(function (global) {
  "use strict";
  // LINGXI_WRITER_HEADER_TABLE_WIDTH_V2
  const VERSION = 2, HEADER_INDEX = Object.freeze({ primary: 1, firstPage: 2, evenPages: 3 });
  async function documentOf() {
    const app = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    const raw = app?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const document = raw && typeof raw.then === "function" ? await raw : raw;
    if (!document) throw new Error("未获取到当前 WPS 文字文档。");
    return document;
  }
  function number(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
  function integer(value, fallback) { const result = Number(value); return Number.isInteger(result) && result >= 1 ? result : fallback; }
  function item(collection, index, label) {
    const total = number(collection?.Count) || 0;
    if (index < 1 || index > total) throw new Error(`${label}索引 ${index} 不存在（可用 1-${total}）。`);
    return collection.Item(index);
  }
  function metrics(table) {
    const columnWidths = [];
    for (let index = 1; index <= (number(table?.Columns?.Count) || 0); index += 1) {
      try { columnWidths.push(number(table.Columns.Item(index)?.Width)); } catch (error) { columnWidths.push(null); }
    }
    const columnsWidth = columnWidths.length && columnWidths.every((width) => width != null) ? columnWidths.reduce((sum, width) => sum + width, 0) : null;
    let preferredWidth = null, preferredWidthType = null, allowAutoFit = null;
    try { preferredWidth = number(table.PreferredWidth); } catch (error) {}
    try { preferredWidthType = number(table.PreferredWidthType); } catch (error) {}
    try { allowAutoFit = typeof table.AllowAutoFit === "boolean" ? table.AllowAutoFit : !!Number(table.AllowAutoFit); } catch (error) {}
    return { rows: number(table?.Rows?.Count) || 0, columns: columnWidths.length, columnWidths, columnsWidth, preferredWidth, preferredWidthType, allowAutoFit };
  }
  function headerTable(document, sectionIndex, headerKind, tableIndex) {
    const kind = String(headerKind || "primary");
    if (!HEADER_INDEX[kind]) throw new Error("headerKind 必须为 primary/firstPage/evenPages。");
    const section = item(document.Sections, sectionIndex, "节");
    const header = item(section.Headers, HEADER_INDEX[kind], "页眉类型");
    return { headerKind: kind, header: item(header.Range?.Tables, tableIndex, `${kind} 页眉表格`) };
  }
  async function getHeaderTableMetrics(options = {}) {
    const document = await documentOf();
    const sectionIndex = integer(options.sectionIndex, 1), headerTableIndex = integer(options.headerTableIndex, 1), bodyTableIndex = integer(options.bodyTableIndex, 1);
    const header = headerTable(document, sectionIndex, options.headerKind || "primary", headerTableIndex);
    const body = item(document.Tables, bodyTableIndex, "正文表格");
    return { version: VERSION, sectionIndex, headerKind: header.headerKind, headerTableIndex, bodyTableIndex, header: metrics(header.header), body: metrics(body) };
  }
  async function alignHeaderTableWidth() {
    throw new Error("HEADER_TABLE_WIDTH_WRITE_PAUSED：页眉宽度/自动调整写入已暂停。请先用 wps_get_header_table_recovery_profile 建立身份与结构档案；异常或合并表格不得通过宽度工具修复。");
  }
  global.WpsAiWriterHeaderTableWidth = { version: VERSION, getHeaderTableMetrics, alignHeaderTableWidth, _internal: { metrics, HEADER_INDEX } };
})(window);
