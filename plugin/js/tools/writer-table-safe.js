(function (g) {
  "use strict";
  const MARKER = "LINGXI_WRITER_TABLE_SAFE_TOOLS_V1";

  async function applicationOf() {
    const value = g.WpsAiAddon?.getApplication ? await g.WpsAiAddon.getApplication() : (g.WpsAiAddon?.getApplicationSync?.() || g.wps?.Application || g.Application);
    if (!value) throw new Error("未获取到 WPS Application。");
    return value;
  }
  async function documentOf() {
    const app = await applicationOf();
    const raw = app.ActiveDocument || g.WpsAiDocument?.getActiveDocument?.();
    const document = raw && typeof raw.then === "function" ? await raw : raw;
    if (!document) throw new Error("未获取到当前 WPS 文字文档。");
    return { app, document };
  }
  function count(collection) { return Math.max(0, Number(collection?.Count) || 0); }
  function item(collection, index) {
    try { return typeof collection?.Item === "function" ? collection.Item(index) : null; }
    catch (error) { return null; }
  }
  function tableAt(document, index) {
    const tables = document?.Tables;
    const total = count(tables);
    const tableIndex = Number(index);
    if (!Number.isInteger(tableIndex) || tableIndex < 1 || tableIndex > total) throw new Error(`tableIndex 越界：${index}（当前 ${total} 个表格）`);
    const table = item(tables, tableIndex);
    if (!table) throw new Error(`无法读取第 ${tableIndex} 个表格。`);
    return table;
  }
  function cellPayloadText(raw) {
    // Word/WPS 单元格文本以 CR + BEL 结束；只剥单元格结束标记，保留内部段落符/软换行。
    return String(raw || "").replace(/\r?\x07$/, "");
  }
  function comparableCellText(value) {
    return cellPayloadText(value).replace(/\r\n|\r|\v/g, "\n");
  }
  function prepareCellWriteText(value, existingRaw, mode = "preserve") {
    const source = String(value ?? "");
    if (!/[\r\n\v]/.test(source)) return source;
    if (mode === "paragraph") return source.replace(/\r\n|\r|\n|\v/g, "\r");
    if (mode === "soft") return source.replace(/\r\n|\r|\n|\v/g, "\v");
    const existing = cellPayloadText(existingRaw);
    const existingBreaks = existing.match(/[\r\v]/g) || [];
    const preferred = existingBreaks.includes("\r") ? "\r" : existingBreaks.includes("\v") ? "\v" : "\r";
    // 显式 CR/VT 视为调用方指定；只把普通 LF 映射为现有类型。
    if (/[\r\v]/.test(source)) return source.replace(/\r\n/g, "\r").replace(/\n/g, preferred);
    const parts = source.split("\n");
    if (existingBreaks.length === parts.length - 1) {
      let output = parts[0] || "";
      for (let index = 1; index < parts.length; index += 1) output += existingBreaks[index - 1] + parts[index];
      return output;
    }
    return parts.join(preferred);
  }
  function rowCells(table, rowIndex) {
    const cells = [], seen = new Set();
    const add = (cell) => {
      const start = Number(cell?.Range?.Start);
      if (!cell || (Number.isFinite(start) && seen.has(start))) return;
      if (Number.isFinite(start)) seen.add(start);
      cells.push(cell);
    };
    const columns = count(table?.Columns);
    for (let columnIndex = 1; columnIndex <= columns; columnIndex += 1) {
      try { add(table.Cell(rowIndex, columnIndex)); } catch (error) {}
    }
    if (!cells.length) {
      const all = table?.Range?.Cells;
      for (let index = 1; index <= count(all); index += 1) {
        const cell = item(all, index);
        if (Number(cell?.RowIndex) === rowIndex) add(cell);
      }
    }
    return cells;
  }
  function rowFingerprint(table, rowIndex) {
    return rowCells(table, rowIndex).map((cell) => comparableCellText(cell?.Range?.Text)).join("\u241f");
  }
  function revisionCount(document) {
    try { return count(document?.Revisions); } catch (error) { return 0; }
  }

  async function deleteTableRow({ tableIndex, rowIndex } = {}) {
    const { app, document } = await documentOf();
    const table = tableAt(document, tableIndex);
    const index = Number(rowIndex);
    const beforeRows = count(table.Rows);
    if (!Number.isInteger(index) || index < 1 || index > beforeRows) throw new Error(`rowIndex=${rowIndex} 越界（当前 1–${beforeRows}）`);
    const cells = rowCells(table, index);
    if (!cells.length) throw new Error(`无法定位表 ${tableIndex} 第 ${index} 行的任何单元格，已停止且未写入。`);
    const beforeFingerprint = rowFingerprint(table, index);
    const beforeRevisions = revisionCount(document);
    let strategy = "", invoked = false, lastError = null;
    const attempts = [
      ["rows-item", () => {
        const row = item(table.Rows, index);
        if (!row || typeof row.Delete !== "function") return false;
        row.Delete(); return true;
      }],
      ["cell-range-rows", () => {
        for (const cell of cells) {
          const rows = cell?.Range?.Rows;
          if (typeof rows?.Delete !== "function") continue;
          rows.Delete(); return true;
        }
        return false;
      }],
      ["cell-row", () => {
        for (const cell of cells) {
          const row = cell?.Row;
          if (typeof row?.Delete !== "function") continue;
          row.Delete(); return true;
        }
        return false;
      }],
      ["document-range-rows", () => {
        const starts = cells.map((cell) => Number(cell?.Range?.Start)).filter(Number.isFinite);
        const ends = cells.map((cell) => Number(cell?.Range?.End)).filter(Number.isFinite);
        if (!starts.length || !ends.length || typeof document.Range !== "function") return false;
        const range = document.Range(Math.min(...starts), Math.max(...ends));
        if (typeof range?.Rows?.Delete !== "function") return false;
        range.Rows.Delete(); return true;
      }]
    ];
    for (const [name, run] of attempts) {
      try {
        if (!run()) continue;
        strategy = name; invoked = true; break;
      } catch (error) { lastError = error; }
    }
    if (!invoked) throw new Error(`当前 WPS 无可用的安全删行路径；已验证 Rows.Item 与单元格 Range.Rows。${lastError ? `最后错误：${lastError.message || lastError}` : ""}`);
    const afterRows = count(table.Rows);
    const afterRevisions = revisionCount(document);
    const tracked = afterRows === beforeRows && afterRevisions > beforeRevisions;
    if (afterRows !== beforeRows - 1 && !tracked) {
      // Delete 已被调用但验证不通过；尽量只撤销这一次动作，避免留下半修改状态。
      try { if (typeof app?.Undo === "function") app.Undo(); } catch (error) {}
      throw new Error(`DELETE_TABLE_ROW_POSTCHECK_FAILED：删行后行数 ${beforeRows}→${afterRows} 且无新增删除修订；已尝试撤销。`);
    }
    return {
      tableIndex: Number(tableIndex), deletedRow: index, deletionMode: tracked ? "tracked" : "physical", strategy,
      beforeRows, remainingRows: afterRows, revisionDelta: Math.max(0, afterRevisions - beforeRevisions),
      deletedRowFingerprint: beforeFingerprint.slice(0, 500), verification: { ok: true }
    };
  }

  async function writeTableRange({ tableIndex, startRow = 1, startCol = 1, values, lineBreakMode = "preserve" } = {}) {
    if (!Array.isArray(values) || values.length === 0) throw new Error("values 必须是非空二维数组");
    if (!["preserve", "paragraph", "soft"].includes(lineBreakMode)) throw new Error("lineBreakMode 必须为 preserve/paragraph/soft");
    const { document } = await documentOf();
    const table = tableAt(document, tableIndex);
    const row = Number(startRow), column = Number(startCol);
    if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) throw new Error("startRow/startCol 必须是从 1 开始的整数");
    let colsMax = 0;
    for (const line of values) {
      if (!Array.isArray(line)) throw new Error("values 内层必须是数组");
      colsMax = Math.max(colsMax, line.length);
    }
    const beforeRows = count(table.Rows), beforeCols = count(table.Columns);
    const needRows = row + values.length - 1, needCols = column + colsMax - 1;
    while (count(table.Rows) < needRows) table.Rows.Add();
    while (count(table.Columns) < needCols) table.Columns.Add();
    let written = 0, skipped = 0, failed = 0, paragraphBreakCells = 0, softBreakCells = 0;
    const errors = [];
    for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
      for (let colOffset = 0; colOffset < values[rowOffset].length; colOffset += 1) {
        const targetRow = row + rowOffset, targetCol = column + colOffset;
        try {
          const cell = table.Cell(targetRow, targetCol);
          const beforeRaw = String(cell?.Range?.Text || "");
          const prepared = prepareCellWriteText(values[rowOffset][colOffset], beforeRaw, lineBreakMode);
          if (comparableCellText(beforeRaw) === comparableCellText(prepared)) { skipped += 1; continue; }
          cell.Range.Text = prepared;
          const afterRaw = String(cell?.Range?.Text || "");
          if (comparableCellText(afterRaw) !== comparableCellText(prepared)) throw new Error("写后文本校验不一致");
          written += 1;
          if (prepared.includes("\r")) paragraphBreakCells += 1;
          if (prepared.includes("\v")) softBreakCells += 1;
        } catch (error) {
          failed += 1;
          errors.push({ row: targetRow, col: targetCol, error: String(error?.message || error).slice(0, 240) });
        }
      }
    }
    return {
      tableIndex: Number(tableIndex), writtenCells: written, skippedCells: skipped, failedCells: failed,
      lineBreakMode, paragraphBreakCells, softBreakCells, errors: errors.slice(0, 20),
      finalRows: count(table.Rows), finalCols: count(table.Columns), prevRows: beforeRows, prevCols: beforeCols,
      verification: { ok: failed === 0 }
    };
  }

  function register() {
    const registry = g.WpsAiToolRegistry;
    if (!registry?.registerTool) return false;
    registry.registerTool({
      name: "wps_delete_table_row", origin: "writer-table-safe", replaces: "writer-core", hosts: ["wps"],
      description: "安全删除指定表格的一行（1-based）。兼容 WPS Rows.Item 不可用及合并单元格表，自动回退到单元格 Range.Rows；写后验证行数或删除修订增长。",
      parameters: { type: "object", required: ["tableIndex", "rowIndex"], properties: {
        tableIndex: { type: "integer", minimum: 1 }, rowIndex: { type: "integer", minimum: 1, description: "1-based；先用 wps_read_table/list_tables 核实" }
      } }, handler: deleteTableRow
    });
    registry.registerTool({
      name: "wps_write_table_range", origin: "writer-table-safe", replaces: "writer-core", hosts: ["wps"],
      description: "向指定 Writer 表格写入二维数据（1-based）。默认保留现有单元格换行类型；普通 LF 不再静默变为 Shift+Enter，写后逐格验证。",
      parameters: { type: "object", required: ["tableIndex", "values"], properties: {
        tableIndex: { type: "integer", minimum: 1 }, startRow: { type: "integer", minimum: 1, default: 1 }, startCol: { type: "integer", minimum: 1, default: 1 },
        values: { type: "array", items: { type: "array", items: {} } },
        lineBreakMode: { type: "string", enum: ["preserve", "paragraph", "soft"], default: "preserve", description: "preserve=沿用目标单元格；paragraph=段落符；soft=Shift+Enter" }
      } }, handler: writeTableRange
    });
    return true;
  }

  if (!register()) g.addEventListener?.("load", register, { once: true });
  g.WpsAiWriterTableSafeTools = { marker: MARKER, deleteTableRow, writeTableRange, _internal: { cellPayloadText, comparableCellText, prepareCellWriteText, rowCells } };
})(window);
