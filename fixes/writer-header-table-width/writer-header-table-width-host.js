(function attachWriterHeaderTableWidth(global) {
  "use strict";
  // LINGXI_WRITER_HEADER_TABLE_WIDTH_V1
  const VERSION = 1, WIDTH_TOLERANCE = 0.25, MAX_SAFE_TABLE_WIDTH = 1440;
  const HEADER_INDEX = Object.freeze({ primary: 1, firstPage: 2, evenPages: 3 });

  async function documentOf() {
    const app = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    const doc = app?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = doc && typeof doc.then === "function" ? await doc : doc;
    if (!resolved) throw new Error("未获取到当前 WPS 文字文档。");
    return resolved;
  }
  function integer(value, fallback) { const n = Number(value); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback; }
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  function collectionItem(collection, index, label) {
    const count = number(collection?.Count) || 0;
    if (index < 1 || index > count) throw new Error(`${label}索引 ${index} 不存在（可用 1-${count}）。`);
    const item = collection.Item(index);
    if (!item) throw new Error(`无法读取${label} ${index}。`);
    return item;
  }
  function headerTable(doc, sectionIndex, headerKind, tableIndex) {
    const kind = String(headerKind || "primary");
    if (!(kind in HEADER_INDEX)) throw new Error("headerKind 必须为 primary/firstPage/evenPages。");
    const section = collectionItem(doc.Sections, sectionIndex, "节");
    const header = collectionItem(section.Headers, HEADER_INDEX[kind], "页眉类型");
    const table = collectionItem(header?.Range?.Tables, tableIndex, `${kind} 页眉表格`);
    return { section, header, table, headerKind: kind };
  }
  function bodyTable(doc, tableIndex) { return collectionItem(doc.Tables, tableIndex, "正文表格"); }
  function metrics(table) {
    const widths = [], columns = table?.Columns;
    const count = number(columns?.Count) || 0;
    for (let index = 1; index <= count; index += 1) {
      let width = null; try { width = number(columns.Item(index)?.Width); } catch (error) {}
      widths.push(width);
    }
    const columnsWidth = widths.length && widths.every((width) => width != null) ? widths.reduce((sum, width) => sum + width, 0) : null;
    let preferredWidth = null, preferredWidthType = null, allowAutoFit = null, rows = null;
    try { preferredWidth = number(table?.PreferredWidth); } catch (error) {}
    try { preferredWidthType = number(table?.PreferredWidthType); } catch (error) {}
    try { allowAutoFit = typeof table?.AllowAutoFit === "boolean" ? table.AllowAutoFit : !!Number(table?.AllowAutoFit); } catch (error) {}
    try { rows = number(table?.Rows?.Count) || 0; } catch (error) {}
    return { rows, columns: count, columnWidths: widths, columnsWidth, preferredWidth, preferredWidthType, allowAutoFit };
  }
  function safeWidth(value) { const width = number(value); return width > 0 && width <= MAX_SAFE_TABLE_WIDTH ? width : null; }
  function normalizedTarget(bodyMetrics) {
    // WPS 对合并或异常表格可能回报荒谬的 Columns.Width；优先可信 PreferredWidth。
    const value = safeWidth(bodyMetrics.preferredWidth) ?? safeWidth(bodyMetrics.columnsWidth);
    if (value == null) throw new Error(`UNSAFE_TABLE_WIDTH：正文表格宽度不可用或超出 ${MAX_SAFE_TABLE_WIDTH}pt 安全上限，已拒绝写入。`);
    return value;
  }
  function comparableWidth(info) { return info.columnsWidth != null ? info.columnsWidth : info.preferredWidth; }
  function setColumnsProportionally(table, targetWidth) {
    const before = metrics(table);
    if (!(before.columnsWidth > 0) || !before.columnWidths.length || before.columnWidths.some((width) => !(width > 0))) {
      throw new Error("目标页眉表格没有可安全调整的实际列宽，已停止以避免破坏表格布局。");
    }
    const ratio = targetWidth / before.columnsWidth;
    let assigned = 0;
    const applied = [];
    for (let index = 0; index < before.columnWidths.length; index += 1) {
      // 最后一列吸收浮点舍入，确保列宽总和严格等于目标宽度。
      const width = index === before.columnWidths.length - 1 ? targetWidth - assigned : before.columnWidths[index] * ratio;
      try { table.Columns.Item(index + 1).Width = width; }
      catch (error) { throw new Error(`无法设置目标页眉表格第 ${index + 1} 列宽度：${error?.message || error}`); }
      assigned += width;
      applied.push(width);
    }
    return applied;
  }
  function checkExpected(expected, actual) {
    if (!expected) return;
    const expectedWidth = normalizedTarget(expected);
    const actualWidth = normalizedTarget(actual);
    if (expectedWidth != null && Math.abs(expectedWidth - actualWidth) > WIDTH_TOLERANCE) throw new Error("STALE_BODY_TABLE_METRICS：正文表格宽度已变化，请重新读取 metrics 后再修改。");
  }
  async function getHeaderTableMetrics(options = {}) {
    const doc = await documentOf();
    const sectionIndex = integer(options.sectionIndex, 1), headerTableIndex = integer(options.headerTableIndex, 1), bodyTableIndex = integer(options.bodyTableIndex, 1);
    const header = headerTable(doc, sectionIndex, options.headerKind || "primary", headerTableIndex);
    const body = bodyTable(doc, bodyTableIndex);
    return { version: VERSION, sectionIndex, headerKind: header.headerKind, headerTableIndex, bodyTableIndex, header: metrics(header.table), body: metrics(body) };
  }
  async function alignHeaderTableWidth(options = {}) {
    const doc = await documentOf();
    const sectionIndex = integer(options.sectionIndex, 1), headerTableIndex = integer(options.headerTableIndex, 1), bodyTableIndex = integer(options.bodyTableIndex, 1);
    const header = headerTable(doc, sectionIndex, options.headerKind || "primary", headerTableIndex);
    const body = bodyTable(doc, bodyTableIndex);
    const source = metrics(body); checkExpected(options.expectedBodyMetrics, source);
    const targetWidth = normalizedTarget(source), before = metrics(header.table);
    // 3 = wdPreferredWidthPoints. We deliberately do not change body, margins, text, or other tables.
    try { header.table.AllowAutoFit = false; } catch (error) { throw new Error(`无法关闭目标页眉表格自动调整：${error?.message || error}`); }
    try { header.table.PreferredWidthType = 3; } catch (error) { throw new Error(`无法设置目标页眉表格宽度单位：${error?.message || error}`); }
    try { header.table.PreferredWidth = targetWidth; } catch (error) { throw new Error(`无法设置目标页眉表格宽度：${error?.message || error}`); }
    // WPS 有时会忽略 PreferredWidth 并按页眉可用宽度重新排版；因此必须再写真实列宽。
    const appliedColumnWidths = setColumnsProportionally(header.table, targetWidth);
    const after = metrics(header.table), verifiedWidth = after.columnsWidth;
    if (verifiedWidth == null || Math.abs(verifiedWidth - targetWidth) > WIDTH_TOLERANCE) {
      throw new Error(`HEADER_TABLE_WIDTH_VERIFY_FAILED：目标实际列宽 ${targetWidth}pt，写后读回 ${verifiedWidth == null ? "无" : verifiedWidth + "pt"}。`);
    }
    return { sectionIndex, headerKind: header.headerKind, headerTableIndex, bodyTableIndex, sourceBody: source, targetWidth, before, after, appliedColumnWidths, appliedFields: ["AllowAutoFit", "PreferredWidthType", "PreferredWidth", "Columns.Width"], verification: { ok: true, tolerance: WIDTH_TOLERANCE, width: verifiedWidth } };
  }
  global.WpsAiWriterHeaderTableWidth = { version: VERSION, getHeaderTableMetrics, alignHeaderTableWidth, _internal: { metrics, normalizedTarget, HEADER_INDEX } };
})(window);
