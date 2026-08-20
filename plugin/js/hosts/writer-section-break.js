(function attachWriterSectionBreak(global) {
  "use strict";

  // LINGXI_WRITER_SECTION_BREAK_REMOVAL_V1
  const MARKER = "LINGXI_WRITER_SECTION_BREAK_REMOVAL_V1";

  async function getDocument() {
    const bound = global.WpsAiDocumentMutation?.getBoundDocument?.() || null;
    if (bound) return bound;
    const application = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    const document = application?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = document && typeof document.then === "function" ? await document : document;
    if (!resolved) throw new Error("未检测到打开的 WPS 文字文档。");
    return { application, document: resolved };
  }

  function countOf(collection) { return Math.max(0, Number(collection?.Count) || 0); }
  function rangeNumber(range, key) { const value = Number(range?.[key]); return Number.isFinite(value) ? value : null; }
  function cleanText(value) { return String(value || "").replace(/[\r\n\v\f\u0007]/g, "").trim(); }

  function paragraphAnchorAt(document, position) {
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const total = countOf(paragraphs);
    for (let index = 1; index <= total; index += 1) {
      try {
        const range = paragraphs.Item(index)?.Range;
        const start = rangeNumber(range, "Start"), end = rangeNumber(range, "End");
        if (start != null && end != null && position >= start && position < end) return index;
      } catch (error) {}
    }
    return null;
  }

  async function inspectSectionBoundaries() {
    const { document } = await getDocument();
    const sections = document.Sections;
    const total = countOf(sections);
    const boundaries = [];
    for (let endingSectionIndex = 1; endingSectionIndex < total; endingSectionIndex += 1) {
      const section = sections.Item(endingSectionIndex);
      const range = section?.Range;
      const end = rangeNumber(range, "End");
      const start = rangeNumber(range, "Start");
      if (end == null || start == null || end <= start) continue;
      // Word/WPS 的节末 Range 包含分节符；只取最后一个字符，绝不覆盖正文或段落其余部分。
      const breakRange = typeof document.Range === "function" ? document.Range(end - 1, end) : null;
      boundaries.push({
        endingSectionIndex,
        nextSectionIndex: endingSectionIndex + 1,
        sectionRange: { start, end },
        breakRange: { start: end - 1, end },
        boundaryParagraph: paragraphAnchorAt(document, end - 1),
        breakTextCodePoints: Array.from(String(breakRange?.Text || "")).map((char) => char.codePointAt(0)),
        previousSectionTail: cleanText(document.Range?.(Math.max(start, end - 81), end - 1)?.Text).slice(-80),
        nextSectionStart: rangeNumber(sections.Item(endingSectionIndex + 1)?.Range, "Start")
      });
    }
    return { sections: total, boundaries };
  }

  async function removeSectionBreak(options = {}) {
    const endingSectionIndex = Math.floor(Number(options.endingSectionIndex));
    const expectedSectionCount = Math.floor(Number(options.expectedSectionCount));
    const expectedBoundaryParagraph = options.expectedBoundaryParagraph == null ? null : Math.floor(Number(options.expectedBoundaryParagraph));
    if (!Number.isInteger(endingSectionIndex) || endingSectionIndex < 1) throw new Error("endingSectionIndex 必须是大于 0 的节序号。");
    if (!Number.isInteger(expectedSectionCount) || expectedSectionCount < 2) throw new Error("expectedSectionCount 必须是当前文档的节总数（至少 2）。");

    const before = await inspectSectionBoundaries();
    if (before.sections !== expectedSectionCount) throw new Error(`节数已变化：当前为 ${before.sections} 节，预期为 ${expectedSectionCount} 节。请先重新检查边界。`);
    const target = before.boundaries.find((item) => item.endingSectionIndex === endingSectionIndex);
    if (!target) throw new Error(`未找到节 ${endingSectionIndex} 与下一节之间的分节符。`);
    if (expectedBoundaryParagraph != null && target.boundaryParagraph !== expectedBoundaryParagraph) {
      throw new Error(`边界段落不匹配：当前为 §${target.boundaryParagraph || "未知"}，预期为 §${expectedBoundaryParagraph}。请先重新检查边界。`);
    }

    const { document } = await getDocument();
    const breakRange = typeof document.Range === "function" ? document.Range(target.breakRange.start, target.breakRange.end) : null;
    if (!breakRange || typeof breakRange.Delete !== "function") throw new Error("当前 WPS 版本不支持删除此分节符范围。");
    breakRange.Delete();

    const after = await inspectSectionBoundaries();
    if (after.sections !== before.sections - 1) {
      throw new Error(`分节符删除后验证失败：节数从 ${before.sections} 变为 ${after.sections}（预期 ${before.sections - 1}）。文档已保留自动备份，请立即用 Ctrl+Z 或改动记录恢复，并停止后续修改。`);
    }
    return {
      deleted: true,
      sectionsBefore: before.sections,
      sectionsAfter: after.sections,
      removedBoundary: target,
      followTarget: target.boundaryParagraph ? { kind: "paragraphRange", startAnchor: `§${target.boundaryParagraph}`, endAnchor: `§${target.boundaryParagraph}` } : null,
      verification: { ok: true, expectedSectionsAfter: before.sections - 1 }
    };
  }

  global.WpsAiSectionBreak = { [MARKER]: true, inspectSectionBoundaries, removeSectionBreak };
})(window);
