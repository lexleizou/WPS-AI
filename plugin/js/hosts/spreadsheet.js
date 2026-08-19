(function attachSpreadsheetHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActiveWorkbook() {
    const app = await getApp();
    return app?.ActiveWorkbook || null;
  }

  async function ensureWorkbook() {
    const wb = await getActiveWorkbook();
    if (!wb) throw new Error("未检测到打开的 WPS 表格 工作簿。");
    return wb;
  }

  async function getActiveSheet() {
    const wb = await ensureWorkbook();
    return wb.ActiveSheet || wb.Sheets?.Item?.(1) || null;
  }

  async function getSelection() {
    const app = await getApp();
    return app?.Selection || null;
  }

  function joinValues(values, rowSep = "\n", colSep = "\t") {
    if (values == null) return "";
    if (!Array.isArray(values)) return String(values);
    if (Array.isArray(values[0])) {
      return values
        .map((row) => row.map((v) => (v == null ? "" : String(v))).join(colSep))
        .join(rowSep);
    }
    return values.map((v) => (v == null ? "" : String(v))).join(colSep);
  }

  async function readRangeAsText(range) {
    if (!range) return "";
    let values;
    try {
      values = range.Value2;
    } catch (error) {
      values = null;
    }
    if (values == null) {
      try {
        values = range.Value;
      } catch (error) {
        values = null;
      }
    }
    if (values == null) {
      return String(range.Text || "").trim();
    }
    return joinValues(values).trim();
  }

  async function readSelectionText() {
    const sel = await getSelection();
    return readRangeAsText(sel);
  }

  async function readSheetText(sheet) {
    const target = sheet || (await getActiveSheet());
    if (!target) throw new Error("未检测到当前工作表。");
    const used = target.UsedRange;
    if (!used) return "";
    return readRangeAsText(used);
  }

  async function readWorkbookText() {
    const wb = await ensureWorkbook();
    const sheets = wb.Sheets;
    const count = sheets?.Count || 0;
    const buffers = [];
    for (let i = 1; i <= count; i += 1) {
      const sheet = sheets.Item(i);
      const name = sheet?.Name || `Sheet${i}`;
      const text = await readSheetText(sheet);
      buffers.push(`# ${name}\n${text}`);
    }
    return buffers.join("\n\n").trim();
  }

  async function readDocumentText() {
    return readSheetText();
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    if (scope === "workbook") return readWorkbookText();
    return readSheetText();
  }

  function parseDelimited(text) {
    // 修 B3：去掉尾部换行产生的空行。AI/LLM 输出几乎总带一个尾随 \n，
    // 若不剥掉，"42\n" 会被切成 2 行，把选区正下方单元格写空覆盖用户数据。
    const normalized = String(text).replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const lines = normalized.split("\n");
    return lines.map((line) => line.split("\t"));
  }

  function setCellValue(cell, value) {
    const num = Number(value);
    if (value !== "" && !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(String(value).trim())) {
      cell.Value2 = num;
    } else if (typeof value === "string" && value.charAt(0) === "=") {
      // 修 B30：以 "=" 开头的文本不隐式当公式写入（非法公式会抛错中断整次写入）。
      // 用 .Text/.Value 明确按文本写；失败再退回 Value2。
      try { cell.NumberFormatLocal = "@"; } catch (e) {}
      try { cell.Value = value; } catch (e) { try { cell.Value2 = value; } catch (e2) {} }
    } else {
      cell.Value2 = value;
    }
  }

  /**
   * 在选区起点写入文本：
   * - 单值：写入 Selection.Cells(1,1)
   * - 多行/制表符分隔：从起点向下/向右展开为二维数据
   */
  async function writeAtSelection(text) {
    if (!text) throw new Error("没有可写入的内容。");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");

    const grid = parseDelimited(text);
    const rows = grid.length;
    const cols = grid.reduce((max, row) => Math.max(max, row.length), 0);

    if (rows === 1 && cols === 1) {
      const cell = sel.Cells ? sel.Cells.Item(1, 1) : sel;
      setCellValue(cell, grid[0][0]);
      return;
    }

    const startCell = sel.Cells ? sel.Cells.Item(1, 1) : sel;
    const startRow = startCell.Row;
    const startCol = startCell.Column;
    const sheet = startCell.Worksheet || (await getActiveSheet());
    if (!sheet) throw new Error("无法获取当前工作表。");

    for (let r = 0; r < rows; r += 1) {
      const row = grid[r] || [];
      for (let c = 0; c < cols; c += 1) {
        // 参差行的缺位不写（不再用 "" 覆盖右侧已有数据）。
        if (c >= row.length) continue;
        const cell = sheet.Cells.Item(startRow + r, startCol + c);
        // per-cell 容错：单个单元格写失败不中断整次写入，避免留下半张表。
        try { setCellValue(cell, row[c] ?? ""); } catch (e) {}
      }
    }
  }

  async function insertText(text) {
    return writeAtSelection(text);
  }

  async function replaceSelectionText(text) {
    return writeAtSelection(text);
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选区" },
      { value: "sheet", label: "当前工作表" },
      { value: "workbook", label: "整个工作簿" }
    ];
  }

  // 读取所有工作表的批注：遍历 sheet.Comments（传统批注）。返回 [{sheet, cell, author, text}]
  async function readComments() {
    const wb = await ensureWorkbook();
    const sheets = wb.Worksheets || wb.Sheets;
    const sc = Number(sheets && sheets.Count) || 0;
    const clip = (t, n) => { const s = String(t == null ? "" : t).replace(/[\r\n\x07\t]+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
    const sg = (obj, prop) => { try { return obj ? obj[prop] : undefined; } catch (e) { return undefined; } };
    const out = [];
    for (let s = 1; s <= sc; s += 1) {
      let sheet, sheetName;
      try { sheet = sheets.Item(s); sheetName = clip(sg(sheet, "Name"), 60); } catch (e) { continue; }
      let comments;
      try { comments = sheet.Comments; } catch (e) { comments = null; }
      const cc = Number(sg(comments, "Count")) || 0;
      for (let i = 1; i <= cc; i += 1) {
        try {
          const c = comments.Item(i);
          let text = "";
          try { text = String(c.Text()); } catch (e) { try { text = String(sg(c, "Text")); } catch (_) {} }
          let cell = "";
          try { cell = String(c.Parent.Address(false, false)); } catch (e) { try { cell = String(sg(sg(c, "Parent"), "Address")); } catch (_) {} }
          out.push({ sheet: sheetName, cell: clip(cell, 30), author: clip(sg(c, "Author"), 60), text: clip(text, 500) });
        } catch (e) {}
      }
    }
    return { total: out.length, comments: out };
  }

  global.WpsAiHostSpreadsheet = {
    host: "et",
    label: "WPS 表格",
    readComments,
    readSelectionText,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText,
    getScopeOptions,
    // 阶段 4 的工具调用会复用这些底层方法
    _internal: {
      getApp,
      getActiveSheet,
      getActiveWorkbook,
      readRangeAsText,
      writeAtSelection,
      setCellValue
    }
  };
})(window);
