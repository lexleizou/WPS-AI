(function attachWriterTableColumnWidth(global) {
  "use strict";
  // LINGXI_WRITER_TABLE_COLUMN_WIDTH_V1
  const MAX_SAFE_WIDTH = 1440, TOLERANCE = 0.25;
  const HEADER_INDEX = Object.freeze({ primary: 1, firstPage: 2, evenPages: 3 });
  async function documentOf() {
    const bound = global.WpsAiDocumentMutation?.getBoundDocument?.() || null;
    if (bound) return bound;
    const app = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    const raw = app?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = raw && typeof raw.then === "function" ? await raw : raw;
    if (!resolved) throw new Error("未获取到当前 WPS 文字文档。");
    return resolved;
  }
  function count(collection) { const value = Number(collection?.Count); return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
  function item(collection, index, label) { if (index < 1 || index > count(collection)) throw new Error(`${label}索引 ${index} 不存在。`); const value = collection.Item(index); if (!value) throw new Error(`无法读取${label} ${index}。`); return value; }
  function number(value) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
  function fingerprint(value) { let hash = 2166136261; for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(16); }
  function tableOf(doc, options = {}) {
    const scope = options.scope || "body", tableIndex = Number(options.tableIndex) || 1;
    if (scope === "body") return { scope, table: item(doc.Tables, tableIndex, "正文表格"), tableIndex };
    if (scope !== "header") throw new Error("scope 必须为 body 或 header。");
    const sectionIndex = Number(options.sectionIndex) || 1, kind = options.headerKind || "primary", kindIndex = HEADER_INDEX[kind];
    if (!kindIndex) throw new Error("headerKind 必须为 primary/firstPage/evenPages。");
    const section = item(doc.Sections, sectionIndex, "节"), header = item(section.Headers, kindIndex, "页眉类型");
    return { scope, sectionIndex, headerKind: kind, tableIndex, table: item(header.Range?.Tables, tableIndex, "页眉表格") };
  }
  function metrics(table) {
    const widths = [], columns = table?.Columns;
    for (let index = 1; index <= count(columns); index += 1) {
      try { widths.push(number(item(columns, index, "表格列").Width)); } catch (error) { widths.push(null); }
    }
    const result = { columnCount: widths.length, widths, totalWidth: widths.length && widths.every((width) => width != null) ? widths.reduce((sum, width) => sum + width, 0) : null };
    result.fingerprint = fingerprint(result); return result;
  }
  function validWidth(value) { const width = number(value); return width != null && width > 0 && width <= MAX_SAFE_WIDTH; }
  async function getColumnWidths(options = {}) { const located = tableOf(await documentOf(), options); return { ...located, table: undefined, metrics: metrics(located.table) }; }
  async function setColumnWidth(options = {}) {
    const located = tableOf(await documentOf(), options);
    if (located.scope === "header") throw new Error("HEADER_COLUMN_WRITE_PAUSED：页眉裸列宽写入已暂停；异常或合并页眉必须先建立恢复档案，不能靠单列宽度修复。");
    const before = metrics(located.table), columnIndex = Number(options.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 1 || columnIndex > before.columnCount) throw new Error("columnIndex 无效。");
    if (!before.widths.every(validWidth)) throw new Error("UNSAFE_TABLE_COLUMNS：当前表格存在不可读或异常列宽，已拒绝写入。");
    if (String(options.expectedFingerprint || "") !== before.fingerprint) throw new Error("STALE_TABLE_COLUMN_WIDTHS：表格列宽已变化，请重新读取。");
    const width = number(options.width); if (!validWidth(width)) throw new Error(`UNSAFE_COLUMN_WIDTH：width 必须在 0-${MAX_SAFE_WIDTH}pt 之间。`);
    const target = item(located.table.Columns, columnIndex, "表格列");
    if (Math.abs(number(target.Width) - width) > TOLERANCE) target.Width = width;
    const after = metrics(located.table), actual = after.widths[columnIndex - 1];
    if (!validWidth(actual) || Math.abs(actual - width) > TOLERANCE) throw new Error(`TABLE_COLUMN_WIDTH_VERIFY_FAILED：目标 ${width}pt，写后读回 ${actual == null ? "无" : actual + "pt"}。`);
    return { scope: located.scope, sectionIndex: located.sectionIndex, headerKind: located.headerKind, tableIndex: located.tableIndex, columnIndex, before, after, changed: Math.abs(before.widths[columnIndex - 1] - width) > TOLERANCE, verification: { ok: true, width: actual, tolerance: TOLERANCE } };
  }
  function headerStructure(table) { return { columns: count(table?.Columns), rows: count(table?.Rows) }; }
  async function getHeaderReference(options = {}) {
    const located = tableOf(await documentOf(), { ...options, scope: "header" }), reference = metrics(located.table);
    if (!reference.widths.length || !reference.widths.every(validWidth)) throw new Error("UNSAFE_SOURCE_HEADER_WIDTHS：源页眉列宽不可读或异常，不能作为恢复基准。");
    const structure = headerStructure(located.table);
    return { sectionIndex: located.sectionIndex, headerKind: located.headerKind, tableIndex: located.tableIndex, widths: reference.widths, structure, fingerprint: fingerprint({ widths: reference.widths, structure }) };
  }
  async function restoreHeaderWidths(options = {}) {
    throw new Error("HEADER_WIDTH_RESTORE_PAUSED：跨节复制页眉列宽已暂停。它不能证明文档身份、页眉链接或合并关系安全，禁止继续写入。");
    /* Legacy implementation intentionally retained below for audit only.
    const doc = await documentOf(), source = await getHeaderReference(options), expected = String(options.expectedReferenceFingerprint || "");
    if (expected !== source.fingerprint) throw new Error("STALE_HEADER_WIDTH_REFERENCE：健康源页眉列宽已变化，请重新读取参考值。");
    const targets = Array.isArray(options.targetSectionIndexes) ? [...new Set(options.targetSectionIndexes.map(Number).filter(Number.isInteger))] : [];
    if (!targets.length) throw new Error("targetSectionIndexes 至少包含一个目标节。");
    const results = [];
    for (const sectionIndex of targets) {
      try {
        if (sectionIndex === source.sectionIndex) throw new Error("源节不能同时作为恢复目标。");
        const target = tableOf(doc, { scope: "header", sectionIndex, headerKind: source.headerKind, tableIndex: source.tableIndex });
        const structure = headerStructure(target.table);
        if (structure.columns !== source.structure.columns || structure.rows !== source.structure.rows) throw new Error("HEADER_TABLE_STRUCTURE_MISMATCH：目标页眉表格行列结构与健康源不一致。");
        for (let index = 1; index <= source.widths.length; index += 1) item(target.table.Columns, index, "目标页眉表格列").Width = source.widths[index - 1];
        const after = metrics(target.table);
        if (!after.widths.every(validWidth) || after.widths.some((width, index) => Math.abs(width - source.widths[index]) > TOLERANCE)) throw new Error("HEADER_WIDTH_RESTORE_VERIFY_FAILED：写后列宽与健康源不一致。");
        results.push({ sectionIndex, status: "completed", widths: after.widths });
      } catch (error) { results.push({ sectionIndex, status: "failed", error: error?.message || String(error) }); }
    }
    const completed = results.filter((result) => result.status === "completed").length;
    const summary = { total: results.length, completed, failed: results.length - completed, status: completed === results.length ? "completed" : completed ? "partial" : "failed" };
    // 任一目标复核失败即让真实工具调用失败，进度层不得把部分恢复渲染成“全部完成”。
    if (summary.failed) { const error = new Error(`HEADER_WIDTH_RESTORE_PARTIAL：${completed}/${summary.total} 节恢复成功，${summary.failed} 节失败。`); error.details = { source, results, summary }; throw error; }
    return { source, results, summary };
    */
  }
  global.WpsAiTableColumnWidth = { getColumnWidths, setColumnWidth, getHeaderReference, restoreHeaderWidths, _internal: { metrics } };
})(window);
