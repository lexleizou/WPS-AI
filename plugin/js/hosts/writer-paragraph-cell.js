(function attachWriterParagraphCell(global) {
  "use strict";

  // LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1
  const MARKER = "LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1";

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
  function rawText(range) { return String(range?.Text || ""); }
  function visibleText(range) { return rawText(range).replace(/[\r\n\v\u0007\s]/g, ""); }

  function assertSimpleEmptyParagraph(paragraph, anchor) {
    const range = paragraph?.Range;
    if (!range) throw new Error(`无法读取 ${anchor}。`);
    const raw = rawText(range);
    if (visibleText(range) !== "") throw new Error(`${anchor} 不是空段落（含可见内容），已中止，未删除任何段落。`);
    if (/[\f\u000c\u000e]/.test(raw)) throw new Error(`${anchor} 含有分页/分节控制符，为避免改变分页结构已中止。`);
    if (raw.includes("\u0007")) throw new Error(`${anchor} 位于表格单元格内，删除会破坏表格结构，已中止。`);
    if (countOf(range.Tables) > 0) throw new Error(`${anchor} 位于表格内，删除会破坏表格结构，已中止。`);
    if (countOf(range.InlineShapes) > 0 || countOf(range.Shapes) > 0) throw new Error(`${anchor} 含图片/形状对象，已中止。`);
    return range;
  }

  function normalizedParagraphText(paragraph) {
    return rawText(paragraph?.Range).replace(/[\r\n\v\u0007]+/g, " ").replace(/\s+/g, " ").trim();
  }

  async function deleteEmptyParagraphs(options = {}) {
    const start = Math.floor(Number(options.startParagraph));
    const end = Math.floor(Number(options.endParagraph));
    const expectedCount = Math.floor(Number(options.expectedParagraphCount));
    const expectedNextText = String(options.expectedNextText || "").replace(/\s+/g, " ").trim();
    const expectedPreviousText = String(options.expectedPreviousText || "").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("startParagraph/endParagraph 必须是有效的段落锚点区间（1 ≤ start ≤ end）。");
    }
    const requested = end - start + 1;
    if (requested > 12) throw new Error(`EMPTY_PARAGRAPH_DELETE_LIMIT：单次最多删除 12 个空段，当前请求 ${requested} 个。请拆分并重新读取地图。`);
    if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("expectedParagraphCount 必须是当前文档段落总数。");
    if (expectedNextText.length < 4) throw new Error("expectedNextText 至少 4 个字符：必须提供空段之后首个正文/标题的地图原文，用于防止越界删除正文。");

    const { application, document } = await getDocument();
    const getParagraphs = () => document.Paragraphs || document.Content?.Paragraphs;
    let paragraphs = getParagraphs();
    const before = countOf(paragraphs);
    if (!paragraphs || before !== expectedCount) throw new Error(`段落总数已变化：当前 ${before}，预期 ${expectedCount}。请先用 wps_get_document_map 重新核对锚点。`);
    if (end >= before) throw new Error(`§${end} 后没有可保护的正文段落；拒绝删除文档末尾未知范围。`);

    for (let i = start; i <= end; i += 1) assertSimpleEmptyParagraph(paragraphs.Item(i), `§${i}`);
    const nextTextBefore = normalizedParagraphText(paragraphs.Item(end + 1));
    if (!nextTextBefore.startsWith(expectedNextText)) {
      throw new Error(`NEXT_PARAGRAPH_MISMATCH：§${end + 1} 当前为“${nextTextBefore.slice(0, 80)}”，与 expectedNextText 不符；未删除。`);
    }
    const previousTextBefore = start > 1 ? normalizedParagraphText(paragraphs.Item(start - 1)) : "";
    if (expectedPreviousText && !previousTextBefore.startsWith(expectedPreviousText)) {
      throw new Error(`PREVIOUS_PARAGRAPH_MISMATCH：§${start - 1} 当前为“${previousTextBefore.slice(0, 80)}”，与 expectedPreviousText 不符；未删除。`);
    }

    const tracked = trackRevisionsOn(document);
    const deleteRevisionsBefore = deleteRevisionCount(document);
    let physicalDeleted = 0, trackedDeleted = 0, actions = 0;
    const rollback = () => {
      if (typeof application?.Undo !== "function") return false;
      for (let attempt = 0; attempt < actions; attempt += 1) {
        try {
          const currentCount = countOf(getParagraphs());
          const currentDeleteRevisions = deleteRevisionCount(document);
          if (currentCount === before && currentDeleteRevisions <= deleteRevisionsBefore) break;
          application.Undo();
        } catch (error) { return false; }
      }
      return countOf(getParagraphs()) === before;
    };

    try {
      // 只删除每个空段自身最后一个段落标记；禁止 Select+Selection.Delete，后者在 WPS Mac 会吞掉相邻 TOC/正文。
      for (let i = end; i >= start; i -= 1) {
        paragraphs = getParagraphs();
        const currentBefore = countOf(paragraphs);
        const paragraph = paragraphs.Item(i);
        const range = assertSimpleEmptyParagraph(paragraph, `§${i}`);
        const rangeStart = Number(range.Start), rangeEnd = Number(range.End);
        if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart || typeof document.Range !== "function") {
          throw new Error(`无法取得 §${i} 的精确段落标记范围。`);
        }
        const mark = document.Range(rangeEnd - 1, rangeEnd);
        const markText = rawText(mark);
        if (!/[\r\n\v]/.test(markText) || visibleText(mark) !== "") {
          throw new Error(`§${i} 末字符不是独立空段标记，拒绝删除。`);
        }
        const revisionsBeforeOne = deleteRevisionCount(document);
        if (typeof mark.Delete !== "function") throw new Error("当前 WPS 不支持精确删除单个段落标记；为保护正文已中止。");
        mark.Delete();
        actions += 1;
        const currentAfter = countOf(getParagraphs());
        const revisionsAfterOne = deleteRevisionCount(document);
        if (currentAfter === currentBefore - 1) {
          physicalDeleted += 1;
          const protectedNow = normalizedParagraphText(getParagraphs().Item(i));
          if (!protectedNow.startsWith(expectedNextText)) {
            throw new Error(`EMPTY_PARAGRAPH_BOUNDARY_BREACH：删除 §${i} 后受保护正文不在预期位置（当前“${protectedNow.slice(0, 80)}”）。`);
          }
        } else if (tracked && currentAfter === currentBefore && revisionsAfterOne > revisionsBeforeOne) {
          trackedDeleted += 1;
        } else {
          throw new Error(`EMPTY_PARAGRAPH_STEP_VERIFY_FAILED：删除 §${i} 后段落数 ${currentBefore}→${currentAfter}，删除修订 ${revisionsBeforeOne}→${revisionsAfterOne}。`);
        }
      }

      const paragraphsAfter = countOf(getParagraphs());
      if (paragraphsAfter !== before - physicalDeleted || physicalDeleted + trackedDeleted !== requested) {
        throw new Error(`EMPTY_PARAGRAPH_FINAL_VERIFY_FAILED：计划 ${requested}，物理删除 ${physicalDeleted}，删除修订 ${trackedDeleted}，段落数 ${before}→${paragraphsAfter}。`);
      }
      if (physicalDeleted) {
        const nextTextAfter = normalizedParagraphText(getParagraphs().Item(start));
        if (!nextTextAfter.startsWith(expectedNextText)) throw new Error("EMPTY_PARAGRAPH_NEXT_TEXT_LOST：删除后未找到受保护的后续正文。");
      }
      if (expectedPreviousText && start > 1) {
        const previousTextAfter = normalizedParagraphText(getParagraphs().Item(start - 1));
        if (!previousTextAfter.startsWith(expectedPreviousText)) throw new Error("EMPTY_PARAGRAPH_PREVIOUS_TEXT_LOST：删除后前序 TOC/正文发生变化。");
      }
      return {
        deleted: requested, anchors: `§${start}–§${end}`, paragraphsBefore: before, paragraphsAfter,
        tracked: trackedDeleted > 0, physicalDeleted, trackedDeleted,
        protectedBoundaries: { previous: previousTextBefore.slice(0, 120), next: nextTextBefore.slice(0, 120) },
        note: trackedDeleted ? "修订模式开启：部分或全部空段已记为删除修订，接受修订后才会物理移除。" : undefined,
        followTarget: { kind: "paragraphRange", startAnchor: `§${start}`, endAnchor: `§${Math.max(1, start - 1)}` },
        verification: { ok: true, mode: trackedDeleted ? "tracked-or-mixed" : "physical" }
      };
    } catch (error) {
      const rolledBack = rollback();
      throw new Error(`${error?.message || error} 已执行自动撤销：${rolledBack ? "成功恢复原段落总数" : "无法确认恢复，请立即人工撤销并复核"}。`);
    }
  }

  function getHeaderRange(document, sectionIndex) {
    const sections = document.Sections;
    if (!sections || sectionIndex < 1 || sectionIndex > countOf(sections)) throw new Error(`当前文档没有节 ${sectionIndex}。`);
    const headers = sections.Item(sectionIndex)?.Headers;
    // wdHeaderFooterPrimary = 1
    const header = headers?.Item?.(1);
    const range = header?.Range;
    if (!range) throw new Error(`节 ${sectionIndex} 没有可用的主页眉。`);
    return range;
  }

  function imageCount(range) { return countOf(range?.InlineShapes) + countOf(range?.ShapeRange ? null : null) + countOf(range?.Shapes); }

  function trackRevisionsOn(document) { try { return !!document.TrackRevisions; } catch (error) { return false; } }

  function deleteRevisionCount(document) {
    let total = 0;
    try {
      const revisions = document.Revisions;
      const count = countOf(revisions);
      for (let i = 1; i <= count; i += 1) {
        try { if (Number(revisions.Item(i)?.Type) === 1) total += 1; } catch (error) {}
      }
    } catch (error) {}
    return total;
  }

  async function clearHeaderCellText(options = {}) {
    const sectionIndex = Math.floor(Number(options.sectionIndex ?? 1));
    const tableIndex = Math.floor(Number(options.tableIndex ?? 1));
    const row = Math.floor(Number(options.row ?? 1));
    const column = Math.floor(Number(options.column ?? 1));
    const expectedText = String(options.expectedText || "").trim();
    if (!expectedText) throw new Error("expectedText 不能为空：必须明确要清除的文字，防止误清整个单元格。");
    if ([sectionIndex, tableIndex, row, column].some((v) => !Number.isInteger(v) || v < 1)) throw new Error("sectionIndex/tableIndex/row/column 必须是大于 0 的整数。");

    const { document } = await getDocument();
    const headerRange = getHeaderRange(document, sectionIndex);
    const tables = headerRange.Tables;
    if (tableIndex > countOf(tables)) throw new Error(`节 ${sectionIndex} 主页眉只有 ${countOf(tables)} 个表格，没有第 ${tableIndex} 个。`);
    const table = tables.Item(tableIndex);
    let cell;
    try { cell = table.Cell(row, column); } catch (error) { throw new Error(`页眉表格 ${tableIndex} 没有单元格 (${row}, ${column})（可能存在合并单元格）。`); }
    const range = cell?.Range;
    if (!range) throw new Error(`无法读取页眉表格 ${tableIndex} 单元格 (${row}, ${column})。`);

    const text = rawText(range);
    const occurrences = text.split(expectedText).length - 1;
    if (occurrences !== 1) throw new Error(`目标文字在该单元格中出现 ${occurrences} 次（预期恰好 1 次），已中止。`);
    const imagesBefore = imageCount(range);
    if (imagesBefore < 1) throw new Error("该单元格未检测到图片，为避免清错目标已中止（本工具只用于「图片 + 文字」单元格）。");

    // 用 Range.Find 在单元格范围内定位文字：命中后该 Range 被重定义为匹配文本，
    // 再删该子范围。不做字符偏移计算——InlineShape 在 Text 与故事坐标中的宽度可能不同。
    const tracked = trackRevisionsOn(document);
    const deleteRevisionsBefore = tracked ? deleteRevisionCount(document) : 0;
    const find = range.Find;
    if (!find || typeof find.Execute !== "function") throw new Error("当前 WPS 版本不支持在页眉单元格内查找文字。");
    try { find.ClearFormatting?.(); } catch (error) {}
    try { find.Text = expectedText; } catch (error) { throw new Error("无法设置页眉查找文字。"); }
    try { find.Forward = true; } catch (error) {}
    try { find.MatchWildcards = false; } catch (error) {}
    try { find.Wrap = 0; } catch (error) {}
    if (!find.Execute()) throw new Error("在单元格范围内未找到目标文字，已中止，未做任何修改。");
    if (rawText(range) !== expectedText) throw new Error("查找命中范围与目标文字不一致，已中止，未做任何修改。");
    let removed = false;
    try { range.Delete?.(); removed = true; } catch (error) { removed = false; }
    if (!removed) { try { range.Text = ""; } catch (error) { throw new Error("当前 WPS 版本无法删除页眉文字范围。"); } }

    const after = table.Cell(row, column)?.Range;
    const imagesAfter = imageCount(after);
    if (imagesAfter !== imagesBefore) throw new Error(`清除后图片数量变化（${imagesBefore} → ${imagesAfter}），请立即 Ctrl+Z 恢复。`);
    const stillThere = rawText(after).includes(expectedText);
    if (stillThere && tracked && deleteRevisionCount(document) > deleteRevisionsBefore) {
      return {
        cleared: expectedText,
        location: `节${sectionIndex} 主页眉 表${tableIndex} (${row},${column})`,
        imagesPreserved: imagesAfter,
        tracked: true,
        note: "修订模式开启：文字已按「删除修订」记录（仍可见但带删除线），接受修订后才会消失。",
        verification: { ok: true, mode: "tracked" }
      };
    }
    if (stillThere) throw new Error("清除后目标文字仍存在，请检查文档并用 Ctrl+Z 恢复。");
    return {
      cleared: expectedText,
      location: `节${sectionIndex} 主页眉 表${tableIndex} (${row},${column})`,
      imagesPreserved: imagesAfter,
      verification: { ok: true }
    };
  }

  global.WpsAiParagraphCellTools = { [MARKER]: true, deleteEmptyParagraphs, clearHeaderCellText };
})(window);
