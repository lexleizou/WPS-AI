(function attachWriterParagraphCell(global) {
  "use strict";

  // LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1
  const MARKER = "LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1";

  async function getDocument() {
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

  async function deleteEmptyParagraphs(options = {}) {
    const start = Math.floor(Number(options.startParagraph));
    const end = Math.floor(Number(options.endParagraph));
    const expectedCount = Math.floor(Number(options.expectedParagraphCount));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("startParagraph/endParagraph 必须是有效的段落锚点区间（1 ≤ start ≤ end）。");
    }
    if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("expectedParagraphCount 必须是当前文档段落总数。");

    const { application, document } = await getDocument();
    const paragraphs = document.Paragraphs || document.Content?.Paragraphs;
    const before = countOf(paragraphs);
    if (!paragraphs || before !== expectedCount) throw new Error(`段落总数已变化：当前 ${before}，预期 ${expectedCount}。请先用 wps_get_document_map 重新核对锚点。`);
    if (end > before) throw new Error(`当前文档只有 ${before} 个段落，没有 §${end}。`);

    // 全部预检通过后才开始删除；任何一个段落不合格都不动文档。
    for (let i = start; i <= end; i += 1) assertSimpleEmptyParagraph(paragraphs.Item(i), `§${i}`);

    // 邻居签名：删除成功后，原 §end+1 的内容应落在 §start 上；比 Count 更可靠（WPS 的 Count 可能不刷新）。
    const signatureOf = (index) => {
      if (index < 1 || index > before) return null;
      try { return visibleText(paragraphs.Item(index)?.Range).slice(0, 40); } catch (error) { return null; }
    };
    const tailSignature = signatureOf(end + 1);
    // 修订模式：删除会记为删除修订，段落暂时留在文档里（总数不变），接受修订后才消失。
    const tracked = trackRevisionsOn(document);
    const deleteRevisionsBefore = tracked ? deleteRevisionCount(document) : 0;

    // 自后向前删除，保持前序锚点在删除过程中仍然有效。
    // WPS macOS JSAPI 的 Range.Delete() 对段落范围可能静默无操作；优先用 Select+Selection.Delete（主 writer host 已验证的通路）。
    for (let i = end; i >= start; i -= 1) {
      const range = paragraphs.Item(i)?.Range;
      if (!range) throw new Error(`无法读取 §${i}，已中止。已删除的段落可用 Ctrl+Z 恢复。`);
      let done = false;
      try {
        if (typeof range.Select === "function" && application?.Selection) {
          range.Select();
          application.Selection.Delete();
          done = true;
        }
      } catch (error) { done = false; }
      if (!done) { try { range.Delete?.(); done = true; } catch (error) { done = false; } }
      if (!done) { try { range.Text = ""; } catch (error) { throw new Error(`当前 WPS 版本无法删除 §${i}。已删除的段落可用 Ctrl+Z 恢复。`); } }
    }

    const paragraphsAfter = countOf(document.Paragraphs || document.Content?.Paragraphs);
    const removed = end - start + 1;
    const countOk = paragraphsAfter === before - removed;
    let shiftedSignature = null;
    try { shiftedSignature = visibleText((document.Paragraphs || document.Content?.Paragraphs).Item(start)?.Range).slice(0, 40); } catch (error) {}
    // 空签名（后邻也是空段/不可读）无法作为证据，避免空串恒等造成误判。
    const neighborOk = !tailSignature ? false : shiftedSignature === tailSignature;
    if (!countOk && !neighborOk && tracked) {
      const deleteRevisionsAfter = deleteRevisionCount(document);
      if (deleteRevisionsAfter >= deleteRevisionsBefore + removed) {
        return {
          deleted: removed,
          anchors: `§${start}–§${end}`,
          paragraphsBefore: before,
          paragraphsAfter,
          tracked: true,
          note: "修订模式开启：已按「删除修订」记录，段落在接受修订前仍可见（带删除线）。在「改动」页点「接受全部」后段落才会真正移除。",
          followTarget: { kind: "paragraphRange", startAnchor: `§${start}`, endAnchor: `§${Math.max(1, start - 1)}` },
          verification: { ok: true, mode: "tracked", deleteRevisionsBefore, deleteRevisionsAfter }
        };
      }
    }
    if (!countOk && !neighborOk) {
      throw new Error(`删除后验证失败：段落总数 ${before} → ${paragraphsAfter}（预期 ${before - removed}），且 §${start} 未呈现后续内容。WPS 接口可能静默拒绝了删除；文档大概率未改动，请用 Ctrl+Z 核对并改用显示编辑标记（Ctrl+Shift+8）人工确认。`);
    }
    return {
      deleted: removed,
      anchors: `§${start}–§${end}`,
      paragraphsBefore: before,
      paragraphsAfter,
      followTarget: { kind: "paragraphRange", startAnchor: `§${start}`, endAnchor: `§${Math.max(1, start - 1)}` },
      verification: { ok: true, countOk, neighborOk }
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
