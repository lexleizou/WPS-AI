(function attachWriterParagraphCell(global) {
  "use strict";

  // LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1
  const MARKER = "LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1";

  async function getDocument() {
    const application = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    const document = application?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = document && typeof document.then === "function" ? await document : document;
    if (!resolved) throw new Error("未检测到打开的 WPS 文字文档。");
    return resolved;
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

  async function deleteEmptyParagraphs(options = {}) {
    const start = Math.floor(Number(options.startParagraph));
    const end = Math.floor(Number(options.endParagraph));
    const expectedCount = Math.floor(Number(options.expectedParagraphCount));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("startParagraph/endParagraph 必须是有效的段落锚点区间（1 ≤ start ≤ end）。");
    }
    if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("expectedParagraphCount 必须是当前文档段落总数。");

    const document = await getDocument();
    const paragraphs = document.Paragraphs || document.Content?.Paragraphs;
    const before = countOf(paragraphs);
    if (!paragraphs || before !== expectedCount) throw new Error(`段落总数已变化：当前 ${before}，预期 ${expectedCount}。请先用 wps_get_document_map 重新核对锚点。`);
    if (end > before) throw new Error(`当前文档只有 ${before} 个段落，没有 §${end}。`);

    // 全部预检通过后才开始删除；任何一个段落不合格都不动文档。
    for (let i = start; i <= end; i += 1) assertSimpleEmptyParagraph(paragraphs.Item(i), `§${i}`);

    // 自后向前删除，保持前序锚点在删除过程中仍然有效。
    for (let i = end; i >= start; i -= 1) {
      const range = paragraphs.Item(i)?.Range;
      if (!range || typeof range.Delete !== "function") throw new Error(`当前 WPS 版本不支持删除 §${i}。已删除的段落请用 Ctrl+Z 恢复。`);
      range.Delete();
    }

    const after = countOf(document.Paragraphs || document.Content?.Paragraphs);
    const removed = end - start + 1;
    if (after !== before - removed) {
      throw new Error(`删除后验证失败：段落数从 ${before} 变为 ${after}（预期 ${before - removed}）。文档有自动备份，请立即用 Ctrl+Z 或改动记录恢复，并停止后续修改。`);
    }
    return {
      deleted: removed,
      anchors: `§${start}–§${end}`,
      paragraphsBefore: before,
      paragraphsAfter: after,
      followTarget: { kind: "paragraphRange", startAnchor: `§${start}`, endAnchor: `§${Math.max(1, start - 1)}` },
      verification: { ok: true }
    };
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

  async function clearHeaderCellText(options = {}) {
    const sectionIndex = Math.floor(Number(options.sectionIndex ?? 1));
    const tableIndex = Math.floor(Number(options.tableIndex ?? 1));
    const row = Math.floor(Number(options.row ?? 1));
    const column = Math.floor(Number(options.column ?? 1));
    const expectedText = String(options.expectedText || "").trim();
    if (!expectedText) throw new Error("expectedText 不能为空：必须明确要清除的文字，防止误清整个单元格。");
    if ([sectionIndex, tableIndex, row, column].some((v) => !Number.isInteger(v) || v < 1)) throw new Error("sectionIndex/tableIndex/row/column 必须是大于 0 的整数。");

    const document = await getDocument();
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

    // 用子 Range 精确删除文字本身：单元格 Range 起始 + 文字偏移，绝不动图片字符。
    const start = Number(range.Start);
    const offset = text.indexOf(expectedText);
    if (!Number.isFinite(start) || offset < 0 || typeof document.Range !== "function") throw new Error("当前 WPS 版本不支持按范围清除页眉文字。");
    const target = document.Range(start + offset, start + offset + expectedText.length);
    if (rawText(target) !== expectedText) throw new Error("目标文字范围校验失败，已中止，未做任何修改。");
    if (typeof target.Delete !== "function") throw new Error("当前 WPS 版本不支持删除页眉文字范围。");
    target.Delete();

    const after = cell.Range;
    const imagesAfter = imageCount(after);
    if (imagesAfter !== imagesBefore) throw new Error(`清除后图片数量变化（${imagesBefore} → ${imagesAfter}），请立即 Ctrl+Z 恢复。`);
    if (rawText(after).includes(expectedText)) throw new Error("清除后目标文字仍存在，请检查文档并用 Ctrl+Z 恢复。");
    return {
      cleared: expectedText,
      location: `节${sectionIndex} 主页眉 表${tableIndex} (${row},${column})`,
      imagesPreserved: imagesAfter,
      verification: { ok: true }
    };
  }

  global.WpsAiParagraphCellTools = { [MARKER]: true, deleteEmptyParagraphs, clearHeaderCellText };
})(window);
