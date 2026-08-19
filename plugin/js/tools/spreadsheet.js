(function attachSpreadsheetTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const MSO = { TRUE: -1, FALSE: 0 };
  const imageAssets = () => global.WpsAiImageAssets;
  function proxyBaseUrl() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"); }
  function CLIPBOARD_IMAGE_URL() { return proxyBaseUrl() + "/clipboard/image"; }

  function finiteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function collectionCount(collection) {
    try {
      const count = Number(collection?.Count);
      return isFinite(count) ? count : null;
    } catch (e) {
      return null;
    }
  }

  function getSheetShapeCount(sheet) {
    return collectionCount(sheet?.Shapes);
  }

  function shapeCountIncreased(before, after) {
    return typeof before === "number" && typeof after === "number" && after > before;
  }

  function latestSheetShape(sheet) {
    const count = getSheetShapeCount(sheet);
    if (!(count > 0)) return null;
    try { return sheet?.Shapes?.Item?.(count) || null; } catch (e) { return null; }
  }

  function revealEtShape(app, shape) {
    if (!shape) return;
    try { shape.Visible = true; } catch (e) {}
    try { shape.ZOrder?.(0); } catch (e) {}
    try { shape.Select?.(); } catch (e) {}
    try {
      if (app?.ScreenRefresh) {
        app.ScreenRefresh();
      } else if (app?.ScreenUpdating !== undefined) {
        const previous = app.ScreenUpdating;
        app.ScreenUpdating = false;
        app.ScreenUpdating = previous;
        app.ScreenUpdating = true;
      }
    } catch (e) {}
  }

  function normalizePictureDimension(value) {
    return finiteNumber(value) && value > 0 ? value : -1;
  }

  function safeEtAddPicture(app, sheet, filePath, left, top, width, height, beforeShapeCount) {
    try { if (app && app.Interactive === false) app.Interactive = true; } catch (e) {}
    const L = finiteNumber(left) ? left : 0;
    const T = finiteNumber(top) ? top : 0;
    const W = normalizePictureDimension(width);
    const H = normalizePictureDimension(height);
    const inserted = () => shapeCountIncreased(beforeShapeCount, getSheetShapeCount(sheet));
    const tryOnce = (w, h) => {
      try {
        return sheet?.Shapes?.AddPicture?.(filePath, MSO.FALSE, MSO.TRUE, L, T, w, h) || null;
      } catch (e) {
        return null;
      }
    };

    let picture = tryOnce(W, H);
    if (picture || inserted()) return picture || latestSheetShape(sheet);
    picture = tryOnce(W, H);
    if (picture || inserted()) return picture || latestSheetShape(sheet);
    picture = tryOnce(-1, -1);
    if (picture) {
      try { if (W > 0) picture.Width = W; } catch (e) {}
      try { if (H > 0) picture.Height = H; } catch (e) {}
    }
    return picture || (inserted() ? latestSheetShape(sheet) : null);
  }

  function insertEtPictureFallback(sheet, filePath, left, top, width, height) {
    const pictures = getEtPicturesCollection(sheet);
    try {
      const picture = pictures?.Insert?.(filePath) || null;
      if (!picture) return null;
      applyEtPictureLayout(picture, left, top, width, height);
      return picture;
    } catch (e) {
      return null;
    }
  }

  function applyEtPictureLayout(picture, left, top, width, height) {
    if (!picture) return;
    try { picture.Left = left; } catch (e) {}
    try { picture.Top = top; } catch (e) {}
    if (finiteNumber(width) && width > 0) { try { picture.Width = width; } catch (e) {} }
    if (finiteNumber(height) && height > 0) { try { picture.Height = height; } catch (e) {} }
  }

  function getEtPicturesCollection(sheet) {
    const pictures = sheet?.Pictures;
    if (!pictures) return null;
    if (typeof pictures.Insert === "function" || typeof pictures.Paste === "function") return pictures;
    if (typeof pictures === "function") {
      try { return pictures.call(sheet) || null; } catch (e) { return null; }
    }
    return null;
  }

  function hasEtSelectionPaste(app) {
    try { return typeof app?.Selection?.Paste === "function"; } catch (e) { return false; }
  }

  async function writeEtClipboardImage(filePath) {
    if (typeof fetch !== "function") throw new Error("fetch 不可用，无法写入图片剪贴板。");
    const resp = await fetch(CLIPBOARD_IMAGE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || `clipboard/image ${resp.status}`);
    }
    return payload;
  }

  async function insertEtClipboardFallback(app, sheet, anchor, filePath, left, top, width, height, beforeShapeCount) {
    await writeEtClipboardImage(filePath);
    try { anchor?.Select?.(); } catch (e) {}

    const inserted = () => shapeCountIncreased(beforeShapeCount, getSheetShapeCount(sheet));
    const done = (picture, strategy) => {
      const shape = picture || (inserted() ? latestSheetShape(sheet) : null);
      if (shape) applyEtPictureLayout(shape, left, top, width, height);
      return { shape, strategy };
    };
    const pictures = getEtPicturesCollection(sheet);

    if (pictures?.Paste) {
      try {
        const picture = pictures.Paste(false) || null;
        const result = done(picture, "pictures.paste-clipboard");
        if (result.shape || inserted()) return result;
      } catch (e) {}
    }

    if (typeof sheet?.Paste === "function") {
      try {
        const picture = sheet.Paste(anchor || undefined) || null;
        const result = done(picture, "worksheet.paste-clipboard");
        if (result.shape || inserted()) return result;
      } catch (e) {}
    }

    const selection = app?.Selection;
    if (typeof selection?.Paste === "function") {
      try {
        const picture = selection.Paste() || null;
        const result = done(picture, "selection.paste-clipboard");
        if (result.shape || inserted()) return result;
      } catch (e) {}
    }

    return { shape: null, strategy: "clipboard" };
  }

  function verifyEtImageInserted(sheet, beforeShapeCount, shape) {
    const afterShapeCount = getSheetShapeCount(sheet);
    const countIncreased = shapeCountIncreased(beforeShapeCount, afterShapeCount);
    return {
      afterShapeCount,
      countIncreased,
      confirmed: !!shape || countIncreased
    };
  }

  function getHost() {
    return global.WpsAiHostSpreadsheet?._internal;
  }

  async function getSheetByName(name) {
    const internal = getHost();
    const wb = await internal.getActiveWorkbook();
    if (!wb) throw new Error("未检测到活动工作簿。");
    if (!name) {
      return wb.ActiveSheet || wb.Sheets?.Item?.(1);
    }
    try {
      return wb.Sheets.Item(name);
    } catch (error) {
      throw new Error(`未找到工作表：${name}`);
    }
  }

  function rangeOf(sheet, address) {
    if (!address) throw new Error("缺少 range 地址（如 A1:B5）");
    return sheet.Range(address);
  }

  // valueType: "raw"(默认, Value2 原始值) | "formula"(公式文本) | "text"(Value, 含部分格式化更可读)
  function read2D(range, valueType) {
    const prop = valueType === "formula" ? "Formula" : valueType === "text" ? "Value" : "Value2";
    let raw;
    try { raw = range[prop]; } catch (e) { raw = null; }
    if (raw == null && prop !== "Value2") { try { raw = range.Value2; } catch (e) { raw = null; } }
    if (raw == null) {
      try { raw = range.Value; } catch (e) { raw = null; }
    }
    if (raw == null) {
      const text = String(range.Text || "");
      return [[text]];
    }
    if (!Array.isArray(raw)) {
      return [[raw]];
    }
    if (Array.isArray(raw[0])) return raw;
    return [raw];
  }

  function extractBalancedJsonArray(text) {
    const s = String(text || "").trim();
    const start = s.indexOf("[");
    if (start < 0) return "";
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return "";
  }

  function parseDelimitedGrid(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized) return [];
    const lines = normalized.split(/\n+/).filter((line) => line.trim() !== "");
    const hasTabs = normalized.includes("\t");
    return lines.map((line) => {
      const parts = hasTabs ? line.split("\t") : line.split(/\s*,\s*/);
      return parts.map((v) => v.trim());
    });
  }

  function normalizeCellValue(value) {
    if (value == null) return "";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return value;
  }

  function normalizeWriteValues(values) {
    let v = values;
    if (typeof v === "string") {
      const raw = v.trim();
      if (!raw) return [];
      try {
        v = JSON.parse(raw);
      } catch (e) {
        const arrayText = extractBalancedJsonArray(raw);
        if (arrayText) {
          try { v = JSON.parse(arrayText); } catch (e2) { v = parseDelimitedGrid(raw); }
        } else {
          v = parseDelimitedGrid(raw);
        }
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      v = v.values || v.rows || v.data || v.items || v.table || v.grid;
    }
    if (!Array.isArray(v)) return [];
    if (!Array.isArray(v[0])) v = [v];
    return v.map((row) => {
      if (Array.isArray(row)) return row.map(normalizeCellValue);
      if (row && typeof row === "object") return Object.values(row).map(normalizeCellValue);
      return [normalizeCellValue(row)];
    });
  }

  function setCell(cell, value) {
    if (typeof value === "string" && value.startsWith("=")) {
      cell.Formula = value;
      return;
    }
    cell.Value2 = value;
  }

  // 单次 et_write_range 允许的最大单元格数（rows*cols）。超过直接拒绝，
  // 避免 AI 误传超巨区域把 COM 桥打爆 / 长时间卡住。
  const ET_WRITE_CELL_CAP = 500000;

  // 是否为规整矩形（每行长度一致且 >0）。规整才能走一次性批量写；
  // 参差行必须走逐格路径以保留「不覆盖右侧已有数据」的跳空行为。
  function isRectangular(values) {
    if (!Array.isArray(values) || values.length === 0) return false;
    const w = Array.isArray(values[0]) ? values[0].length : -1;
    if (w <= 0) return false;
    for (const row of values) {
      if (!Array.isArray(row) || row.length !== w) return false;
    }
    return true;
  }

  // 让出事件循环 + 检查中断信号：让长循环里 UI 不冻、Stop 可点、能真正中断。
  // 同步 COM 循环不让出就会独占 WebView 的 JS 线程，AbortController 也救不了。
  async function coYieldCheck(i, signal, everyN) {
    const n = everyN || 150;
    if (signal && signal.aborted) { const e = new Error("已取消"); e.name = "AbortError"; throw e; }
    if (i > 0 && i % n === 0) {
      await new Promise((r) => setTimeout(r, 0)); // 让出事件循环：UI 不冻、Stop 可点、能中断
      if (signal && signal.aborted) { const e = new Error("已取消"); e.name = "AbortError"; throw e; }
    }
  }

  // 分块读大区域：单次 range.Value2 读超大区域会一次性编组整块、独占 JS 线程（Stop 点了没反应）。
  // 按行切成 CHUNK 行的子区域逐块读，块间 coYieldCheck 让出+查中断。防御式：拿不到维度 / 小区域 /
  // 构造子区域失败都退回原来的单次 read2D —— 正常/小表零行为变化、零回归。
  async function read2DChunked(sheet, r, valueType, signal) {
    const CHUNK = 500;
    let rows = 0, cols = 0, top = 0, left = 0;
    try {
      rows = Number(r.Rows.Count) || 0;
      cols = Number(r.Columns.Count) || 0;
      top = Number(r.Row) || 0;
      left = Number(r.Column) || 0;
    } catch (e) {}
    if (!rows || !cols || !top || !left || rows <= CHUNK) return read2D(r, valueType);
    const out = [];
    for (let start = 0; start < rows; start += CHUNK) {
      await coYieldCheck(start, signal, 1); // 每块让出事件循环 + 查 signal（能真正中断大读）
      const blk = Math.min(CHUNK, rows - start);
      let sub;
      try {
        sub = sheet.Range(sheet.Cells(top + start, left), sheet.Cells(top + start + blk - 1, left + cols - 1));
      } catch (e) { return read2D(r, valueType); } // 子区域构造失败 → 退回单次读，绝不丢数据
      const block = read2D(sub, valueType);
      for (const row of block) out.push(row);
    }
    return out;
  }

  registry.registerTool({
    name: "et_read_comments",
    hosts: ["et"],
    description: "读取 WPS 表格 所有工作表的批注，返回 comments:[{sheet(表名), cell(单元格), author(作者), text(批注内容)}]。问“表格有哪些批注”用本工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const fn = global.WpsAiHostSpreadsheet?.readComments;
      if (typeof fn !== "function") throw new Error("当前宿主不支持读取批注。");
      return await fn.call(global.WpsAiHostSpreadsheet);
    }
  });

  registry.registerTool({
    name: "et_list_sheets",
    hosts: ["et"],
    description: "列出当前 WPS 表格 工作簿的所有工作表名称。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const count = wb.Sheets?.Count || 0;
      const names = [];
      for (let i = 1; i <= count; i += 1) {
        names.push(wb.Sheets.Item(i).Name);
      }
      const active = wb.ActiveSheet?.Name || null;
      return { sheets: names, active };
    }
  });

  registry.registerTool({
    name: "et_get_sheet_info",
    hosts: ["et"],
    description: "获取指定工作表的基本信息（已使用区域、维度、当前选区地址）。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" }
      }
    },
    handler: async ({ sheet } = {}) => {
      const internal = getHost();
      const target = await getSheetByName(sheet);
      const used = target.UsedRange;
      const info = {
        name: target.Name,
        usedRange: used?.Address || null,
        rowCount: used?.Rows?.Count || 0,
        columnCount: used?.Columns?.Count || 0
      };
      try {
        const sel = (await internal.getApp()).Selection;
        info.selection = sel?.Address || null;
      } catch (e) { info.selection = null; }
      return info;
    }
  });

  registry.registerTool({
    name: "et_read_range",
    hosts: ["et"],
    description: "读取区域二维数据。range 省略时读整表已用区域(UsedRange)。valueType 选原始值/公式/显示值。maxRows+offset 按行分页，返回 totalRows/truncated/nextOffset 防大表撑爆上下文。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "区域地址，如 A1:C10 或 A1；省略=整表 UsedRange" },
        valueType: { type: "string", enum: ["raw", "formula", "text"], description: "raw=原始值(默认)；formula=公式文本；text=显示值" },
        maxRows: { type: "integer", minimum: 1, description: "最多返回行数（分页上限）" },
        offset: { type: "integer", minimum: 0, description: "起始行偏移（0 起，默认 0）" }
      }
    },
    handler: async ({ sheet, range, valueType, maxRows, offset } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const r = range ? rangeOf(target, range) : target.UsedRange;
      const all = await read2DChunked(target, r, valueType, ctx.signal);
      const cols = all.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
      const win = global.WpsAiReadUtils.applyListWindow(all, { offset: offset || 0, limit: maxRows || 0 });
      let address = "";
      try { address = r.Address; } catch (e) {}
      return {
        sheet: target.Name,
        range: address,
        valueType: valueType || "raw",
        rows: win.window.length,
        cols,
        totalRows: win.total,
        truncated: win.truncated,
        nextOffset: win.nextOffset,
        values: win.window
      };
    }
  });

  registry.registerTool({
    name: "et_write_range",
    hosts: ["et"],
    description: "向指定区域写入二维数据（行 x 列）。values 长度必须与 range 形状一致。字符串以 '=' 开头会作为公式写入。",
    parameters: {
      type: "object",
      required: ["range", "values"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "目标区域起点或完整地址，如 A1 或 A1:C3" },
        values: {
          type: "array",
          description: "二维数据，外层为行，内层为列",
          items: { type: "array", items: {} }
        }
      }
    },
    handler: async ({ sheet, range, values } = {}, ctx = {}) => {
      const signal = ctx.signal;
      values = normalizeWriteValues(values);
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("values 必须是非空二维数组");
      }
      const target = await getSheetByName(sheet);
      const startCell = target.Range(range).Cells.Item(1, 1);
      const startRow = startCell.Row;
      const startCol = startCell.Column;
      let rows = values.length;
      let cols = 0;
      for (const row of values) {
        if (!Array.isArray(row)) throw new Error("values 内层必须是数组");
        if (row.length > cols) cols = row.length;
      }

      // 超巨区域直接拒绝（写之前就挡，避免卡死 / 打爆 COM 桥）。
      const cellCount = rows * cols;
      if (cellCount > ET_WRITE_CELL_CAP) {
        throw new Error(global.WpsAiI18n.t("写入区域过大（{n} 个单元格），请缩小范围分批写入", { n: cellCount }));
      }

      const endCell = target.Cells.Item(startRow + rows - 1, startCol + cols - 1);

      // 快路径：规整矩形一次性批量写。字符串以 '=' 开头者 Excel 的 Formula
      // 会当公式，其余当字面量——所以整块用 .Formula = 2D 数组即可覆盖两种情况。
      // 若 WPS 的 JS-COM 桥不接受 JS 二维数组赋值或抛错，落到下方逐格路径（保证正确性 + 不冻）。
      if (isRectangular(values)) {
        try {
          const rangeAddr = `${startCell.Address}:${endCell.Address}`;
          target.Range(rangeAddr).Formula = values;
          return {
            sheet: target.Name,
            writtenRange: rangeAddr,
            rows,
            cols
          };
        } catch (e) {
          // 批量不被支持 → 落逐格兜底（下方），correctness 不受影响。
        }
      }

      // 逐格兜底：参差行 / 批量失败都走这里。逐格能保留「缺位不覆盖右侧已有数据」，
      // 且 coYieldCheck 让循环让出事件循环 + 可被 Stop 中断（不再冻 UI）。
      for (let r = 0; r < rows; r += 1) {
        const row = values[r] || [];
        for (let c = 0; c < cols; c += 1) {
          await coYieldCheck(r * cols + c, signal);
          // 修 B4：参差行的缺位不写空串（否则会覆盖右侧已有数据）。
          if (c >= row.length) continue;
          const cell = target.Cells.Item(startRow + r, startCol + c);
          setCell(cell, row[c] ?? "");
        }
      }
      return {
        sheet: target.Name,
        writtenRange: `${startCell.Address}:${endCell.Address}`,
        rows,
        cols
      };
    }
  });

  registry.registerTool({
    name: "et_set_formula",
    hosts: ["et"],
    description: "对单元格或区域批量设置公式。公式不需要前导 '='。如果只填一个公式，会应用到整个 range。",
    parameters: {
      type: "object",
      required: ["range", "formula"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "目标区域，如 D2:D10" },
        formula: { type: "string", description: "公式内容，如 SUM(A2:C2)，可以带或不带前导 =" }
      }
    },
    handler: async ({ sheet, range, formula } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      const f = formula.startsWith("=") ? formula : `=${formula}`;
      r.Formula = f;
      return { sheet: target.Name, range: r.Address, formula: f };
    }
  });

  registry.registerTool({
    name: "et_add_sheet",
    hosts: ["et"],
    description: "在当前工作簿末尾新增一个工作表。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "新工作表名称，留空使用 WPS 默认命名" }
      }
    },
    handler: async ({ name } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const lastIndex = wb.Sheets.Count;
      const last = wb.Sheets.Item(lastIndex);
      const sheet = wb.Sheets.Add(null, last);
      if (name) {
        try { sheet.Name = name; } catch (error) {
          throw new Error(`重命名失败：${error.message || error}`);
        }
      }
      return { name: sheet.Name, index: sheet.Index };
    }
  });

  registry.registerTool({
    name: "et_format_range",
    hosts: ["et"],
    description: "对区域设置基本格式（粗体/斜体/前景色/背景色/水平对齐）。颜色用 0xRRGGBB 或 #RRGGBB。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "目标区域" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        color: { type: "string", description: "字体颜色 #RRGGBB" },
        bgColor: { type: "string", description: "填充色 #RRGGBB" },
        align: { type: "string", enum: ["left", "center", "right"] }
      }
    },
    handler: async ({ sheet, range, bold, italic, color, bgColor, align } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      if (typeof bold === "boolean") r.Font.Bold = bold;
      if (typeof italic === "boolean") r.Font.Italic = italic;
      if (color) r.Font.Color = parseColor(color);
      if (bgColor) r.Interior.Color = parseColor(bgColor);
      if (align) {
        // xlHAlignLeft=-4131, xlHAlignCenter=-4108, xlHAlignRight=-4152
        r.HorizontalAlignment = { left: -4131, center: -4108, right: -4152 }[align];
      }
      return { sheet: target.Name, range: r.Address };
    }
  });

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    // WPS Color 是 BGR 整数（0xBBGGRR）
    return (b << 16) | (g << 8) | r;
  }

  // ---- 枚举常量（来自 et-jsapi-declare） ----

  const BORDER_INDEX = {
    edgeTop: 8, edgeBottom: 9, edgeLeft: 7, edgeRight: 10,
    insideHorizontal: 12, insideVertical: 11,
    diagonalDown: 5, diagonalUp: 6
  };

  const LINE_STYLE = {
    solid: 1,        // xlContinuous
    dashed: -4115,   // xlDash
    dotted: -4118,   // xlDot
    double: -4119,   // xlDouble
    dashDot: 4,      // xlDashDot
    dashDotDot: 5,   // xlDashDotDot
    none: -4142      // xlLineStyleNone
  };

  const BORDER_WEIGHT = {
    hairline: 1,
    thin: 2,
    medium: -4138,
    thick: 4
  };

  const HALIGN = { left: -4131, center: -4108, right: -4152, fill: 5, justify: -4130, distributed: -4117, general: 1 };
  const VALIGN = { top: -4160, center: -4108, bottom: -4107, justify: -4130, distributed: -4117 };

  const SORT_ORDER = { asc: 1, desc: 2 };
  const YES_NO = { yes: 1, no: 2, guess: 0 };

  const SHIFT_DIR = { down: -4121, right: -4161, left: -4159, up: -4162 };

  const AUTOFILL = {
    default: 0, copy: 1, fillSeries: 2, fillFormats: 3, fillValues: 4,
    fillDays: 5, fillWeekdays: 6, fillMonths: 7, fillYears: 8, linearTrend: 9, growthTrend: 10
  };

  // ---- Borders ----

  registry.registerTool({
    name: "et_set_borders",
    hosts: ["et"],
    description: "为指定区域设置边框。position 控制画哪些边：all（全部）/outline（外框）/inside（内框）/top/bottom/left/right/horizontal/vertical。",
    parameters: {
      type: "object",
      required: ["range", "position"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "区域地址，如 A1:C10" },
        position: {
          type: "string",
          enum: ["all", "outline", "inside", "top", "bottom", "left", "right", "horizontal", "vertical"],
          description: "边框位置"
        },
        style: { type: "string", enum: ["solid", "dashed", "dotted", "double", "dashDot", "dashDotDot", "none"], description: "线型，默认 solid" },
        weight: { type: "string", enum: ["hairline", "thin", "medium", "thick"], description: "线粗，默认 thin" },
        color: { type: "string", description: "线条颜色 #RRGGBB，默认黑色" }
      }
    },
    handler: async ({ sheet, range, position, style = "solid", weight = "thin", color } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      const styleVal = LINE_STYLE[style];
      const weightVal = BORDER_WEIGHT[weight];
      const colorVal = color ? parseColor(color) : 0; // 0 = 黑

      const apply = (idx) => {
        const b = r.Borders.Item(idx);
        if (styleVal != null) b.LineStyle = styleVal;
        if (weightVal != null) b.Weight = weightVal;
        b.Color = colorVal;
      };

      const positions = (() => {
        switch (position) {
          case "all": return [BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight, BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical];
          case "outline": return [BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight];
          case "inside": return [BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical];
          case "horizontal": return [BORDER_INDEX.insideHorizontal, BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom];
          case "vertical": return [BORDER_INDEX.insideVertical, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight];
          case "top": return [BORDER_INDEX.edgeTop];
          case "bottom": return [BORDER_INDEX.edgeBottom];
          case "left": return [BORDER_INDEX.edgeLeft];
          case "right": return [BORDER_INDEX.edgeRight];
          default: throw new Error(`未知 position：${position}`);
        }
      })();

      positions.forEach(apply);
      return { sheet: target.Name, range: r.Address, position, style, weight };
    }
  });

  registry.registerTool({
    name: "et_clear_borders",
    hosts: ["et"],
    description: "清除指定区域的所有边框。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      [
        BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight,
        BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical,
        BORDER_INDEX.diagonalDown, BORDER_INDEX.diagonalUp
      ].forEach((idx) => {
        r.Borders.Item(idx).LineStyle = LINE_STYLE.none;
      });
      return { sheet: target.Name, range: r.Address };
    }
  });

  // ---- Merge / Unmerge ----

  registry.registerTool({
    name: "et_merge_cells",
    hosts: ["et"],
    description: "合并单元格。across=true 表示按行合并（每一行作为一个合并单元）；默认 across=false 整块合并。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        across: { type: "boolean", default: false }
      }
    },
    handler: async ({ sheet, range, across = false } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.Merge(!!across);
      return { sheet: target.Name, range: r.Address, across };
    }
  });

  registry.registerTool({
    name: "et_unmerge_cells",
    hosts: ["et"],
    description: "取消合并指定区域内的所有合并单元格。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.UnMerge();
      return { sheet: target.Name, range: r.Address };
    }
  });

  // ---- Sort ----

  registry.registerTool({
    name: "et_sort_range",
    hosts: ["et"],
    description: "对区域排序。keyColumn 指定排序依据的列字母（如 \"A\"）或区域内的列序号（1=第一列）。",
    parameters: {
      type: "object",
      required: ["range", "keyColumn"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "要排序的区域，如 A1:C100" },
        keyColumn: { type: "string", description: "排序依据列：列字母(A-Z) 或区域内列序号" },
        order: { type: "string", enum: ["asc", "desc"], default: "asc" },
        hasHeader: { type: "boolean", description: "是否包含表头（首行不参与排序）", default: true }
      }
    },
    handler: async ({ sheet, range, keyColumn, order = "asc", hasHeader = true } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      // 修 B48：直接用工作表自身的 Range 对象作排序键，不再拼 "SheetName!Addr" 字符串。
      // 旧写法在表名含空格/'-'/'(' 等字符时（如 "销售 2025"）必须写成 '销售 2025'!A1，
      // 不加引号会直接抛异常。用对象引用彻底绕开这个问题。
      let keyRange;
      if (/^[A-Za-z]+$/.test(String(keyColumn))) {
        keyRange = target.Range(`${String(keyColumn).toUpperCase()}1`);
      } else {
        const idx = parseInt(keyColumn, 10);
        if (!idx || idx < 1) throw new Error(`无效的 keyColumn：${keyColumn}`);
        const startCell = r.Cells.Item(1, 1);
        keyRange = target.Cells.Item(startCell.Row, startCell.Column + idx - 1);
      }
      r.Sort(
        keyRange,
        SORT_ORDER[order] || SORT_ORDER.asc,
        undefined, undefined, undefined, undefined, undefined,
        hasHeader ? YES_NO.yes : YES_NO.no
      );
      return { sheet: target.Name, range: r.Address, keyColumn, order, hasHeader };
    }
  });

  // ---- AutoFilter ----

  registry.registerTool({
    name: "et_set_autofilter",
    hosts: ["et"],
    description: "对区域开启或关闭自动筛选。enabled=false 时关闭当前工作表筛选。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "要应用筛选的区域。enabled=true 时必填" },
        enabled: { type: "boolean", default: true }
      }
    },
    handler: async ({ sheet, range, enabled = true } = {}) => {
      const target = await getSheetByName(sheet);
      if (!enabled) {
        try { target.AutoFilterMode = false; } catch (e) { /* ignore */ }
        return { sheet: target.Name, enabled: false };
      }
      if (!range) throw new Error("启用 AutoFilter 需要提供 range");
      const r = rangeOf(target, range);
      r.AutoFilter();
      return { sheet: target.Name, range: r.Address, enabled: true };
    }
  });

  // ---- Sizing ----

  function parseColumnsToken(token) {
    // "A" / "A:C" / "1" / "1:3" → 返回起止列索引（1-based）
    const t = String(token).trim();
    if (/^\d+(:\d+)?$/.test(t)) {
      const [a, b] = t.split(":").map((n) => parseInt(n, 10));
      return [a, b || a];
    }
    const m = /^([A-Za-z]+)(?::([A-Za-z]+))?$/.exec(t);
    if (!m) throw new Error(`无效的 columns：${t}`);
    const colStrToNum = (s) => s.toUpperCase().split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    return [colStrToNum(m[1]), m[2] ? colStrToNum(m[2]) : colStrToNum(m[1])];
  }

  function parseRowsToken(token) {
    const t = String(token).trim();
    if (/^\d+(:\d+)?$/.test(t)) {
      const [a, b] = t.split(":").map((n) => parseInt(n, 10));
      return [a, b || a];
    }
    throw new Error(`无效的 rows：${t}`);
  }

  function colNumToLetters(n) {
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // WPS 的 JS 桥不允许 sheet.Columns(N) 这种 COM 默认方法语法。
  // Columns/Rows 是 Range 属性，要用 .Item(N) 或地址法 Range("A:A")/Range("3:3") 取列/行。
  function columnAt(sheet, idx) {
    try {
      if (sheet.Columns?.Item) return sheet.Columns.Item(idx);
    } catch (e) { /* fallthrough */ }
    const letters = colNumToLetters(idx);
    return sheet.Range(`${letters}:${letters}`);
  }

  function rowAt(sheet, idx) {
    try {
      if (sheet.Rows?.Item) return sheet.Rows.Item(idx);
    } catch (e) { /* fallthrough */ }
    return sheet.Range(`${idx}:${idx}`);
  }

  registry.registerTool({
    name: "et_set_column_width",
    hosts: ["et"],
    description: "设置列宽。columns 支持 \"A\"、\"A:C\"、\"1\"、\"1:3\"。width 单位是 WPS 默认字符宽度。",
    parameters: {
      type: "object",
      required: ["columns", "width"],
      properties: {
        sheet: { type: "string" },
        columns: { type: "string", description: "列范围，例 A 或 A:C 或 1:3" },
        width: { type: "number", description: "列宽（字符数）" }
      }
    },
    handler: async ({ sheet, columns, width } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseColumnsToken(columns);
      let i = 0;
      for (let c = start; c <= end; c += 1) {
        await coYieldCheck(i++, ctx.signal);
        columnAt(target, c).ColumnWidth = width;
      }
      return { sheet: target.Name, columns, width };
    }
  });

  registry.registerTool({
    name: "et_set_row_height",
    hosts: ["et"],
    description: "设置行高。rows 支持 \"1\"、\"1:5\"。height 单位是磅（point）。",
    parameters: {
      type: "object",
      required: ["rows", "height"],
      properties: {
        sheet: { type: "string" },
        rows: { type: "string", description: "行范围，例 1 或 1:5" },
        height: { type: "number", description: "行高（磅）" }
      }
    },
    handler: async ({ sheet, rows, height } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseRowsToken(rows);
      let i = 0;
      for (let r = start; r <= end; r += 1) {
        await coYieldCheck(i++, ctx.signal);
        rowAt(target, r).RowHeight = height;
      }
      return { sheet: target.Name, rows, height };
    }
  });

  registry.registerTool({
    name: "et_autofit",
    hosts: ["et"],
    description: "自动调整区域的行高和/或列宽到内容大小。dimension：rows / columns / both。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        dimension: { type: "string", enum: ["rows", "columns", "both"], default: "both" }
      }
    },
    handler: async ({ sheet, range, dimension = "both" } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (dimension === "rows" || dimension === "both") r.EntireRow.AutoFit();
      if (dimension === "columns" || dimension === "both") r.EntireColumn.AutoFit();
      return { sheet: target.Name, range: r.Address, dimension };
    }
  });

  // ---- Insert / Delete rows / columns ----

  registry.registerTool({
    name: "et_insert_rows",
    hosts: ["et"],
    description: "在指定行号之前插入若干行。",
    parameters: {
      type: "object",
      required: ["atRow"],
      properties: {
        sheet: { type: "string" },
        atRow: { type: "integer", minimum: 1, description: "插入位置（在该行之前插入）" },
        count: { type: "integer", minimum: 1, default: 1 }
      }
    },
    handler: async ({ sheet, atRow, count = 1 } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      for (let i = 0; i < count; i += 1) {
        await coYieldCheck(i, ctx.signal);
        rowAt(target, atRow).Insert(SHIFT_DIR.down);
      }
      return { sheet: target.Name, atRow, count };
    }
  });

  registry.registerTool({
    name: "et_insert_columns",
    hosts: ["et"],
    description: "在指定列之前插入若干列。",
    parameters: {
      type: "object",
      required: ["atColumn"],
      properties: {
        sheet: { type: "string" },
        atColumn: { type: "string", description: "插入位置：列字母（如 B）或列号（2）" },
        count: { type: "integer", minimum: 1, default: 1 }
      }
    },
    handler: async ({ sheet, atColumn, count = 1 } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const [colIdx] = parseColumnsToken(atColumn);
      for (let i = 0; i < count; i += 1) {
        await coYieldCheck(i, ctx.signal);
        columnAt(target, colIdx).Insert(SHIFT_DIR.right);
      }
      return { sheet: target.Name, atColumn, count };
    }
  });

  registry.registerTool({
    name: "et_insert_image",
    hosts: ["et"],
    description: "在当前 WPS 表格工作表插入图片。fileName 可以是 HTTP URL、dataUrl 或本地路径；HTTP/dataUrl 会先落成本地文件再插入，默认放到当前选区左上角。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        cell: { type: "string", description: "目标单元格地址，如 B2；留空表示当前选区" },
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        left: { type: "number", description: "左侧位置（磅），传入后优先于 cell/选区" },
        top: { type: "number", description: "顶部位置（磅），传入后优先于 cell/选区" },
        width: { type: "number", default: 240, description: "宽度（磅）" },
        height: { type: "number", description: "高度（磅），省略使用原图比例或 WPS 默认值" }
      }
    },
    handler: async ({ sheet, cell, fileName, left, top, width = 240, height } = {}) => {
      if (!fileName) throw new Error("缺少图片路径 fileName。");
      const localFileName = await imageAssets()?.ensureLocalImagePath?.(fileName) || fileName;
      const internal = getHost();
      const app = await internal.getApp();
      const target = await getSheetByName(sheet);
      try { target.Activate(); } catch (e) {}

      let anchor = null;
      if (cell) {
        anchor = rangeOf(target, cell);
      } else {
        try { anchor = app.Selection; } catch (e) {}
        if (!anchor || typeof anchor.Left !== "number" || typeof anchor.Top !== "number") {
          try { anchor = target.Range("A1"); } catch (e) {}
        }
      }

      const x = typeof left === "number" ? left : (Number(anchor?.Left) || 0);
      const y = typeof top === "number" ? top : (Number(anchor?.Top) || 0);
      const w = finiteNumber(width) ? width : undefined;
      const h = finiteNumber(height) ? height : undefined;
      const beforeShapeCount = getSheetShapeCount(target);
      let shape = null;
      let strategy = null;
      if (target.Shapes?.AddPicture) {
        shape = safeEtAddPicture(app, target, localFileName, x, y, w, h, beforeShapeCount);
        if (shape) strategy = "shapes.add-picture";
      }

      let verified = verifyEtImageInserted(target, beforeShapeCount, shape);
      const pictures = getEtPicturesCollection(target);
      let fallbackError = null;
      if (!verified.confirmed && pictures?.Insert) {
        shape = insertEtPictureFallback(target, localFileName, x, y, w, h);
        if (shape) strategy = "pictures.insert";
        verified = verifyEtImageInserted(target, beforeShapeCount, shape);
      }

      if (!verified.confirmed) {
        try {
          const pasted = await insertEtClipboardFallback(app, target, anchor, localFileName, x, y, w, h, beforeShapeCount);
          shape = pasted.shape;
          strategy = pasted.strategy;
          verified = verifyEtImageInserted(target, beforeShapeCount, shape);
        } catch (e) {
          fallbackError = e?.message || String(e);
        }
      }

      if (!target.Shapes?.AddPicture && !pictures?.Insert && !pictures?.Paste && typeof target?.Paste !== "function" && !hasEtSelectionPaste(app)) {
        throw new Error("当前 WPS 表格对象不支持插入图片。");
      }

      if (!verified.confirmed) {
        const fallbackText = fallbackError ? `；剪贴板兜底失败：${fallbackError}` : "";
        throw new Error(`图片插入未确认成功。before=${beforeShapeCount ?? "unknown"} after=${verified.afterShapeCount ?? "unknown"}${fallbackText}`);
      }

      revealEtShape(app, shape);
      return {
        sheet: target.Name,
        cell: cell || anchor?.Address || null,
        fileName: localFileName,
        sourceFileName: fileName,
        shapeIndex: verified.afterShapeCount,
        confirmed: true,
        strategy,
        left: x,
        top: y,
        width: w ?? null,
        height: h ?? null
      };
    }
  });

  registry.registerTool({
    name: "et_delete_rows",
    hosts: ["et"],
    description: "删除指定行。rows 支持 \"3\" 或 \"3:5\"。",
    parameters: {
      type: "object",
      required: ["rows"],
      properties: {
        sheet: { type: "string" },
        rows: { type: "string", description: "行范围，例 3 或 3:5" }
      }
    },
    handler: async ({ sheet, rows } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseRowsToken(rows);
      // 从后往前删，避免索引漂移
      let i = 0;
      for (let r = end; r >= start; r -= 1) {
        await coYieldCheck(i++, ctx.signal);
        rowAt(target, r).Delete();
      }
      return { sheet: target.Name, rows, deleted: end - start + 1 };
    }
  });

  registry.registerTool({
    name: "et_delete_columns",
    hosts: ["et"],
    description: "删除指定列。columns 支持 \"B\"、\"B:D\"、\"2\"、\"2:4\"。",
    parameters: {
      type: "object",
      required: ["columns"],
      properties: {
        sheet: { type: "string" },
        columns: { type: "string" }
      }
    },
    handler: async ({ sheet, columns } = {}, ctx = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseColumnsToken(columns);
      let i = 0;
      for (let c = end; c >= start; c -= 1) {
        await coYieldCheck(i++, ctx.signal);
        columnAt(target, c).Delete();
      }
      return { sheet: target.Name, columns, deleted: end - start + 1 };
    }
  });

  // ---- Fill / Clear ----

  registry.registerTool({
    name: "et_fill_down",
    hosts: ["et"],
    description: "把首行内容向下填充到整个区域（FillDown）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.FillDown();
      return { sheet: target.Name, range: r.Address };
    }
  });

  registry.registerTool({
    name: "et_fill_right",
    hosts: ["et"],
    description: "把首列内容向右填充到整个区域（FillRight）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.FillRight();
      return { sheet: target.Name, range: r.Address };
    }
  });

  registry.registerTool({
    name: "et_clear",
    hosts: ["et"],
    description: "清除区域内容。mode：contents（仅值/公式）/ formats（仅格式）/ all（全部）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        mode: { type: "string", enum: ["contents", "formats", "all"], default: "contents" }
      }
    },
    handler: async ({ sheet, range, mode = "contents" } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (mode === "contents" || mode === "all") r.ClearContents();
      if (mode === "formats" || mode === "all") r.ClearFormats();
      return { sheet: target.Name, range: r.Address, mode };
    }
  });

  // ---- Number format / extended formatting ----

  registry.registerTool({
    name: "et_set_number_format",
    hosts: ["et"],
    description: "设置区域的数字格式。常见 format 字符串：\"0.00\"（两位小数）、\"0.00%\"（百分比）、\"#,##0\"（千分位）、\"yyyy-mm-dd\"（日期）、\"@\"（文本）。",
    parameters: {
      type: "object",
      required: ["range", "format"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        format: { type: "string", description: "Excel 数字格式代码" }
      }
    },
    handler: async ({ sheet, range, format } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.NumberFormat = format;
      return { sheet: target.Name, range: r.Address, format };
    }
  });

  registry.registerTool({
    name: "et_set_alignment",
    hosts: ["et"],
    description: "设置区域对齐方式。h（水平）：left/center/right/fill/justify/general；v（垂直）：top/center/bottom/justify。可单独传任一项。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        h: { type: "string", enum: ["left", "center", "right", "fill", "justify", "distributed", "general"] },
        v: { type: "string", enum: ["top", "center", "bottom", "justify", "distributed"] },
        wrap: { type: "boolean", description: "是否自动换行" }
      }
    },
    handler: async ({ sheet, range, h, v, wrap } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (h && HALIGN[h] != null) r.HorizontalAlignment = HALIGN[h];
      if (v && VALIGN[v] != null) r.VerticalAlignment = VALIGN[v];
      if (typeof wrap === "boolean") r.WrapText = wrap;
      return { sheet: target.Name, range: r.Address, h, v, wrap };
    }
  });

  // ---- Find / Replace ----

  registry.registerTool({
    name: "et_find_replace",
    hosts: ["et"],
    description: "在指定区域执行查找替换。range 留空时对整个工作表生效。",
    parameters: {
      type: "object",
      required: ["find", "replace"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "可选；省略时使用 UsedRange" },
        find: { type: "string" },
        replace: { type: "string" },
        matchCase: { type: "boolean", default: false }
      }
    },
    handler: async ({ sheet, range, find, replace, matchCase = false } = {}) => {
      const target = await getSheetByName(sheet);
      const r = range ? rangeOf(target, range) : target.UsedRange;
      // Replace(What, Replacement, LookAt, SearchOrder, MatchCase)
      const ok = r.Replace(find, replace, undefined, undefined, !!matchCase);
      return { sheet: target.Name, range: r.Address, find, replace, matched: !!ok };
    }
  });

  // ---- Freeze panes ----

  registry.registerTool({
    name: "et_freeze_panes",
    hosts: ["et"],
    description: "冻结窗格。splitRow 表示在第几行下方水平分割（0=不水平分割）；splitColumn 表示在第几列右侧垂直分割（0=不垂直分割）。",
    parameters: {
      type: "object",
      properties: {
        splitRow: { type: "integer", minimum: 0, default: 1, description: "冻结的行数（在第 N 行下方分割）" },
        splitColumn: { type: "integer", minimum: 0, default: 0, description: "冻结的列数（在第 N 列右侧分割）" }
      }
    },
    handler: async ({ splitRow = 1, splitColumn = 0 } = {}) => {
      const internal = getHost();
      const app = await internal.getApp();
      const win = app.ActiveWindow;
      if (!win) throw new Error("未获取到活动窗口。");
      // 先解冻避免叠加
      try { win.FreezePanes = false; } catch (e) {}
      win.SplitRow = splitRow;
      win.SplitColumn = splitColumn;
      win.FreezePanes = true;
      return { splitRow, splitColumn };
    }
  });

  registry.registerTool({
    name: "et_unfreeze_panes",
    hosts: ["et"],
    description: "取消冻结窗格。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const internal = getHost();
      const app = await internal.getApp();
      const win = app.ActiveWindow;
      if (!win) throw new Error("未获取到活动窗口。");
      win.FreezePanes = false;
      return { ok: true };
    }
  });

  // ---- Hyperlinks ----

  registry.registerTool({
    name: "et_add_hyperlink",
    hosts: ["et"],
    description: "在指定单元格添加超链接。",
    parameters: {
      type: "object",
      required: ["cell", "address"],
      properties: {
        sheet: { type: "string" },
        cell: { type: "string", description: "目标单元格，如 A1" },
        address: { type: "string", description: "URL 或路径" },
        displayText: { type: "string", description: "显示文本，省略时使用 address" },
        screenTip: { type: "string", description: "鼠标悬浮提示" }
      }
    },
    handler: async ({ sheet, cell, address, displayText, screenTip } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, cell);
      target.Hyperlinks.Add(r, address, undefined, screenTip, displayText || address);
      return { sheet: target.Name, cell: r.Address, address, displayText: displayText || address };
    }
  });

  // ---- Sheet management ----

  registry.registerTool({
    name: "et_rename_sheet",
    hosts: ["et"],
    description: "重命名工作表。",
    parameters: {
      type: "object",
      required: ["newName"],
      properties: {
        sheet: { type: "string", description: "要改名的工作表，省略表示当前活动工作表" },
        newName: { type: "string" }
      }
    },
    handler: async ({ sheet, newName } = {}) => {
      const target = await getSheetByName(sheet);
      const oldName = target.Name;
      target.Name = newName;
      return { oldName, newName: target.Name };
    }
  });

  registry.registerTool({
    name: "et_delete_sheet",
    hosts: ["et"],
    description: "删除指定工作表。慎用。",
    parameters: {
      type: "object",
      required: ["sheet"],
      properties: { sheet: { type: "string" } }
    },
    handler: async ({ sheet } = {}) => {
      const target = await getSheetByName(sheet);
      const name = target.Name;
      const internal = getHost();
      const app = await internal.getApp();
      // 关闭确认弹窗（如果支持）
      try { app.DisplayAlerts = false; } catch (e) {}
      // 修 B46：Delete() 抛异常（如删仅剩的唯一工作表）时也要在 finally 恢复 DisplayAlerts，
      // 否则整个 Excel 会话此后关闭未保存工作簿、覆盖文件都不再弹确认，静默丢数据。
      try {
        target.Delete();
      } finally {
        try { app.DisplayAlerts = true; } catch (e) {}
      }
      return { deleted: name };
    }
  });

  registry.registerTool({
    name: "et_activate_sheet",
    hosts: ["et"],
    description: "激活（切换到）指定工作表。",
    parameters: {
      type: "object",
      required: ["sheet"],
      properties: { sheet: { type: "string" } }
    },
    handler: async ({ sheet } = {}) => {
      const target = await getSheetByName(sheet);
      target.Activate();
      return { active: target.Name };
    }
  });

  // ---- Selection ----

  registry.registerTool({
    name: "et_select_range",
    hosts: ["et"],
    description: "把选区移动到指定区域（不写入数据，只是选中）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      try { target.Activate(); } catch (e) {}
      const r = rangeOf(target, range);
      r.Select();
      return { sheet: target.Name, range: r.Address };
    }
  });

  // ============ 条件格式 / 数据验证 / 图表 / 批注 / 导出（新增）============
  // 说明：以下 COM 调用无法在开发环境验证，均标注「需真机验」；枚举常量取自 Excel/WPS ET 对象模型。

  // xlFormatConditionOperator / xlFormatConditionType 复用同一套比较符常量
  const CF_OPERATOR = { greater: 5, less: 6, greaterEqual: 7, lessEqual: 8, equal: 3, notEqual: 4, between: 1, notBetween: 2 };
  const XL_CELL_VALUE = 1, XL_EXPRESSION = 2;

  function applyCfFormat(fc, opts) {
    if (!fc || !opts) return;
    try { if (opts.bgColor) fc.Interior.Color = parseColor(opts.bgColor); } catch (e) {}
    try { if (opts.color) fc.Font.Color = parseColor(opts.color); } catch (e) {}
    try { if (typeof opts.bold === "boolean") fc.Font.Bold = opts.bold; } catch (e) {}
  }

  // FullName 派生同名 .pdf；未保存（FullName 无路径分隔符）返回 null
  function derivePdfPath(fullName) {
    const s = String(fullName || "");
    if (!s || !/[\\/]/.test(s)) return null;
    return s.replace(/\.[^.\\/]+$/, "") + ".pdf";
  }

  registry.registerTool({
    name: "et_add_conditional_format",
    hosts: ["et"],
    description: "给区域加条件格式（高亮规则）。type：cell_value(按数值比较)/color_scale(色阶)/data_bar(数据条)/above_average/below_average(相对均值)/top10/bottom10(前N/后N)/duplicate/unique(重复/唯一值)/expression(自定义公式)。带色的类型可配 bgColor/color 高亮色(#RRGGBB)。",
    parameters: {
      type: "object",
      required: ["range", "type"],
      properties: {
        sheet: { type: "string", description: "工作表名，留空=活动表" },
        range: { type: "string", description: "目标区域，如 A1:A20" },
        type: { type: "string", enum: ["cell_value", "color_scale", "data_bar", "above_average", "below_average", "top10", "bottom10", "duplicate", "unique", "expression"] },
        operator: { type: "string", enum: ["greater", "less", "greaterEqual", "lessEqual", "equal", "notEqual", "between", "notBetween"], description: "cell_value 的比较符" },
        value1: { type: "string", description: "cell_value 阈值1 / expression 公式(以=开头)" },
        value2: { type: "string", description: "between/notBetween 的阈值2" },
        rank: { type: "integer", description: "top10/bottom10 的 N（默认10）" },
        percent: { type: "boolean", description: "top10/bottom10 是否按百分比" },
        bgColor: { type: "string", description: "命中填充色 #RRGGBB" },
        color: { type: "string", description: "命中字体色 #RRGGBB" },
        bold: { type: "boolean" }
      }
    },
    handler: async ({ sheet, range, type, operator, value1, value2, rank, percent, bgColor, color, bold } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      const fcs = r.FormatConditions;
      const fmt = { bgColor, color, bold };
      let fc;
      if (type === "cell_value") {
        const op = CF_OPERATOR[operator || "greater"];
        fc = (value2 != null && value2 !== "")
          ? fcs.Add(XL_CELL_VALUE, op, String(value1 == null ? "" : value1), String(value2))
          : fcs.Add(XL_CELL_VALUE, op, String(value1 == null ? "" : value1));
        applyCfFormat(fc, fmt);
      } else if (type === "expression") {
        fc = fcs.Add(XL_EXPRESSION, undefined, String(value1 == null ? "" : value1));
        applyCfFormat(fc, fmt);
      } else if (type === "color_scale") {
        fc = fcs.AddColorScale(3);
      } else if (type === "data_bar") {
        fc = fcs.AddDatabar();
        try { if (bgColor) fc.BarColor.Color = parseColor(bgColor); } catch (e) {}
      } else if (type === "above_average" || type === "below_average") {
        fc = fcs.AddAboveAverage();
        try { fc.AboveBelow = type === "below_average" ? 1 : 0; } catch (e) {} // xlAboveAverage=0 / xlBelowAverage=1
        applyCfFormat(fc, fmt);
      } else if (type === "top10" || type === "bottom10") {
        fc = fcs.AddTop10();
        try { fc.TopBottom = type === "bottom10" ? 1 : 0; } catch (e) {} // xlTop10Top=0 / xlTop10Bottom=1
        try { fc.Rank = Number(rank) > 0 ? Number(rank) : 10; } catch (e) {}
        try { fc.Percent = !!percent; } catch (e) {}
        applyCfFormat(fc, fmt);
      } else if (type === "duplicate" || type === "unique") {
        fc = fcs.AddUniqueValues();
        try { fc.DupeUnique = type === "duplicate" ? 1 : 0; } catch (e) {} // xlDuplicate=1 / xlUnique=0
        applyCfFormat(fc, fmt);
      } else {
        throw new Error(`不支持的条件格式类型：${type}`);
      }
      try { fc.SetFirstPriority(); } catch (e) {}
      return { sheet: target.Name, range: r.Address, type, applied: true };
    }
  });

  const DV_TYPE = { list: 3, whole: 1, decimal: 2, date: 4, time: 5, textLength: 6, custom: 7 };
  const DV_ALERT = { stop: 1, warning: 2, info: 3 };

  registry.registerTool({
    name: "et_add_data_validation",
    hosts: ["et"],
    description: "给区域加数据验证。type=list 下拉列表(source=逗号分隔项或区域地址如 =Sheet1!$A$1:$A$5)；whole/decimal 数值范围(operator+min/max)；date/time/textLength 同理；custom 自定义公式(formula)。可配 inputMessage 输入提示 + errorMessage 报错。写入前会清掉该区域旧验证。",
    parameters: {
      type: "object",
      required: ["range", "type"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        type: { type: "string", enum: ["list", "whole", "decimal", "date", "time", "textLength", "custom"] },
        source: { type: "string", description: "list 选项：逗号分隔或区域地址" },
        operator: { type: "string", enum: ["between", "notBetween", "greater", "less", "greaterEqual", "lessEqual", "equal", "notEqual"] },
        min: { type: "string", description: "范围下限 / 单值" },
        max: { type: "string", description: "between 上限" },
        formula: { type: "string", description: "custom 公式(以=开头)" },
        alertStyle: { type: "string", enum: ["stop", "warning", "info"] },
        inputMessage: { type: "string" },
        errorMessage: { type: "string" }
      }
    },
    handler: async ({ sheet, range, type, source, operator, min, max, formula, alertStyle, inputMessage, errorMessage } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      const v = r.Validation;
      try { v.Delete(); } catch (e) {}
      const alert = DV_ALERT[alertStyle || "stop"];
      const op = CF_OPERATOR[operator || "between"];
      if (type === "list") {
        if (!source) throw new Error("list 类型需要 source（选项或区域）");
        v.Add(DV_TYPE.list, alert, 1 /*xlBetween*/, source);
        try { v.InCellDropdown = true; } catch (e) {}
      } else if (type === "custom") {
        if (!formula) throw new Error("custom 类型需要 formula");
        v.Add(DV_TYPE.custom, alert, undefined, formula);
      } else {
        const t = DV_TYPE[type];
        if (!t) throw new Error(`不支持的验证类型：${type}`);
        if (max != null && max !== "") v.Add(t, alert, op, String(min == null ? "" : min), String(max));
        else v.Add(t, alert, op, String(min == null ? "" : min));
      }
      try { v.IgnoreBlank = true; } catch (e) {}
      try { if (inputMessage) { v.ShowInput = true; v.InputMessage = inputMessage; } } catch (e) {}
      try { if (errorMessage) { v.ShowError = true; v.ErrorMessage = errorMessage; } } catch (e) {}
      return { sheet: target.Name, range: r.Address, type, applied: true };
    }
  });

  const CHART_TYPE = { column: 51, columnStacked: 52, bar: 57, line: 4, lineMarkers: 65, pie: 5, doughnut: -4120, area: 1, scatter: -4169, radar: -4151 };

  registry.registerTool({
    name: "et_insert_chart",
    hosts: ["et"],
    description: "在工作表插入图表。dataRange=数据区域(含表头，如 A1:B10)。chartType：column/columnStacked/bar/line/lineMarkers/pie/doughnut/area/scatter/radar。可选 title + 位置 left/top/width/height(磅)。",
    parameters: {
      type: "object",
      required: ["dataRange"],
      properties: {
        sheet: { type: "string" },
        dataRange: { type: "string", description: "数据区域(含表头)" },
        chartType: { type: "string", enum: ["column", "columnStacked", "bar", "line", "lineMarkers", "pie", "doughnut", "area", "scatter", "radar"] },
        title: { type: "string" },
        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      }
    },
    handler: async ({ sheet, dataRange, chartType, title, left, top, width, height } = {}) => {
      const target = await getSheetByName(sheet);
      const data = target.Range(dataRange);
      const L = Number.isFinite(left) ? left : 240;
      const T = Number.isFinite(top) ? top : 20;
      const W = Number.isFinite(width) ? width : 480;
      const H = Number.isFinite(height) ? height : 300;
      const co = target.ChartObjects().Add(L, T, W, H);
      const chart = co.Chart;
      try { chart.SetSourceData(data); } catch (e) {}
      try { const ct = CHART_TYPE[chartType || "column"]; chart.ChartType = ct == null ? 51 : ct; } catch (e) {}
      if (title) { try { chart.HasTitle = true; chart.ChartTitle.Text = title; } catch (e) {} }
      let addr = ""; try { addr = data.Address; } catch (e) {}
      return { sheet: target.Name, dataRange: addr, chartType: chartType || "column", applied: true };
    }
  });

  registry.registerTool({
    name: "et_add_comment",
    hosts: ["et"],
    description: "给单元格添加批注（已有批注先清除再写）。cell=单元格地址(如 B2)，text=批注内容。",
    parameters: {
      type: "object",
      required: ["cell", "text"],
      properties: {
        sheet: { type: "string" },
        cell: { type: "string", description: "单元格地址，如 B2" },
        text: { type: "string" }
      }
    },
    handler: async ({ sheet, cell, text } = {}) => {
      if (!text) throw new Error("text 不能为空");
      const target = await getSheetByName(sheet);
      const c = target.Range(cell).Cells.Item(1, 1);
      try { c.ClearComments(); } catch (e) {}
      const comment = c.AddComment(String(text));
      try { comment.Visible = false; } catch (e) {}
      let addr = ""; try { addr = c.Address; } catch (e) {}
      return { sheet: target.Name, cell: addr, applied: true };
    }
  });

  registry.registerTool({
    name: "et_export_pdf",
    hosts: ["et"],
    description: "把当前工作簿导出为 PDF。path 省略时导到工作簿同目录同名 .pdf（工作簿需已保存到磁盘）。",
    parameters: { type: "object", properties: { path: { type: "string", description: "输出 PDF 完整路径，省略=同目录同名" } } },
    handler: async ({ path } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const out = path || derivePdfPath(wb.FullName);
      if (!out) throw new Error("工作簿尚未保存到磁盘，请先保存或显式传 path。");
      wb.ExportAsFixedFormat(0 /*xlTypePDF*/, out);
      return { path: out, applied: true };
    }
  });

  // ============ 智能表 / 数据清洗 / 保护 / 命名 / 文档属性 / 另存 / 打印（第一二梯队）============

  // BuiltInDocumentProperties 读写（三端通用小工具，各 host 各留一份）
  const DOC_PROP_KEYS = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords", comments: "Comments", category: "Category", manager: "Manager", company: "Company" };
  function readWriteDocProps(container, setObj) {
    const props = container.BuiltInDocumentProperties;
    if (setObj && typeof setObj === "object") {
      for (const [k, v] of Object.entries(setObj)) {
        const name = DOC_PROP_KEYS[k];
        if (name && v != null) { try { props.Item(name).Value = String(v); } catch (e) {} }
      }
    }
    const out = {};
    for (const [k, name] of Object.entries(DOC_PROP_KEYS)) {
      try { out[k] = String(props.Item(name).Value == null ? "" : props.Item(name).Value); } catch (e) { out[k] = ""; }
    }
    return out;
  }

  registry.registerTool({
    name: "et_create_table",
    hosts: ["et"],
    description: "把区域转成智能表/超级表（ListObject，自带筛选+隔行底纹）。range=含表头的区域(如 A1:D20)。可选 name(表名)、styleName(如 TableStyleMedium2)、totalRow(显示汇总行)、hasHeaders(默认true)。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "含表头的区域" },
        name: { type: "string" },
        styleName: { type: "string", description: "表样式名，如 TableStyleMedium2/9" },
        totalRow: { type: "boolean" },
        hasHeaders: { type: "boolean", description: "首行是否表头，默认 true" }
      }
    },
    handler: async ({ sheet, range, name, styleName, totalRow, hasHeaders } = {}) => {
      const target = await getSheetByName(sheet);
      // ListObjects.Add(SourceType=xlSrcRange(1), Source, LinkSource, XlListObjectHasHeaders: xlYes=1/xlNo=2)
      const lo = target.ListObjects.Add(1, target.Range(range), undefined, hasHeaders === false ? 2 : 1);
      if (name) { try { lo.Name = name; } catch (e) {} }
      if (styleName) { try { lo.TableStyle = styleName; } catch (e) {} }
      if (totalRow) { try { lo.ShowTotals = true; } catch (e) {} }
      let addr = ""; try { addr = lo.Range.Address; } catch (e) {}
      let tname = ""; try { tname = lo.Name; } catch (e) {}
      return { sheet: target.Name, range: addr, name: tname, applied: true };
    }
  });

  registry.registerTool({
    name: "et_remove_duplicates",
    hosts: ["et"],
    description: "删除区域内的重复行。range=含表头的区域。columns=按哪些列判重(区域内 1 起的列号数组，省略=全部列)。hasHeader 默认 true。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        columns: { type: "array", items: { type: "integer" }, description: "判重列号(区域内 1 起)，省略=全部列" },
        hasHeader: { type: "boolean" }
      }
    },
    handler: async ({ sheet, range, columns, hasHeader } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      let cols = Array.isArray(columns) && columns.length ? columns : null;
      if (!cols) {
        const n = Number(r.Columns.Count) || 1;
        cols = []; for (let i = 1; i <= n; i += 1) cols.push(i);
      }
      // Range.RemoveDuplicates(Columns, Header: xlYes=1/xlNo=2)
      r.RemoveDuplicates(cols, hasHeader === false ? 2 : 1);
      let addr = ""; try { addr = r.Address; } catch (e) {}
      return { sheet: target.Name, range: addr, applied: true };
    }
  });

  registry.registerTool({
    name: "et_text_to_columns",
    hosts: ["et"],
    description: "文本分列：把一列按分隔符拆成多列。range=源单列区域。delimiter：comma/tab/semicolon/space/other。other 时用 otherChar 指定字符。destination 省略=原地覆盖。",
    parameters: {
      type: "object",
      required: ["range", "delimiter"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "源单列区域，如 A1:A20" },
        delimiter: { type: "string", enum: ["comma", "tab", "semicolon", "space", "other"] },
        otherChar: { type: "string", description: "delimiter=other 时的分隔字符" },
        destination: { type: "string", description: "结果起始单元格，省略=原地" }
      }
    },
    handler: async ({ sheet, range, delimiter, otherChar, destination } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      const dest = destination ? target.Range(destination) : r;
      const isTab = delimiter === "tab", isSemi = delimiter === "semicolon", isComma = delimiter === "comma", isSpace = delimiter === "space", isOther = delimiter === "other";
      // TextToColumns(Destination, DataType=xlDelimited(1), TextQualifier=xlDoubleQuote(1), ConsecutiveDelimiter, Tab, Semicolon, Comma, Space, Other, OtherChar)
      r.TextToColumns(dest, 1, 1, false, isTab, isSemi, isComma, isSpace, isOther, isOther ? String(otherChar || "") : undefined);
      return { sheet: target.Name, applied: true };
    }
  });

  registry.registerTool({
    name: "et_protect_sheet",
    hosts: ["et"],
    description: "保护/取消保护工作表。protect=true 保护(可选 password)，false 取消保护。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        protect: { type: "boolean", description: "true=保护，false=取消，默认 true" },
        password: { type: "string" }
      }
    },
    handler: async ({ sheet, protect, password } = {}) => {
      const target = await getSheetByName(sheet);
      if (protect === false) { target.Unprotect(password || undefined); }
      else { target.Protect(password || undefined); }
      return { sheet: target.Name, protected: protect !== false, applied: true };
    }
  });

  registry.registerTool({
    name: "et_define_name",
    hosts: ["et"],
    description: "给区域定义名称（命名区域），之后公式可用该名字引用。name=名称，range=区域。",
    parameters: {
      type: "object",
      required: ["name", "range"],
      properties: { sheet: { type: "string" }, name: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, name, range } = {}) => {
      const target = await getSheetByName(sheet);
      target.Range(range).Name = String(name);
      return { sheet: target.Name, name, range, applied: true };
    }
  });

  registry.registerTool({
    name: "et_doc_properties",
    hosts: ["et"],
    description: "读取/设置工作簿文档属性（标题/作者/主题/关键字等）。传 set 则写入对应字段；始终返回当前全部属性。",
    parameters: {
      type: "object",
      properties: {
        set: { type: "object", description: "要写入的属性，键为 title/author/subject/keywords/comments/category/manager/company" }
      }
    },
    handler: async ({ set } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      return { properties: readWriteDocProps(wb, set) };
    }
  });

  registry.registerTool({
    name: "et_save_as",
    hosts: ["et"],
    description: "把工作簿另存为指定格式。path=完整路径，format：xlsx/xls/csv/txt/html。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, format: { type: "string", enum: ["xlsx", "xls", "csv", "txt", "html"] } }
    },
    handler: async ({ path, format } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const FMT = { xlsx: 51, xls: 56, csv: 6, txt: 42, html: 44 };
      wb.SaveAs(path, FMT[format] == null ? 51 : FMT[format]);
      return { path, format: format || "xlsx", applied: true };
    }
  });

  registry.registerTool({
    name: "et_print",
    hosts: ["et"],
    description: "打印当前工作簿（默认打印机）。copies 可选份数。",
    parameters: { type: "object", properties: { copies: { type: "integer", minimum: 1 } } },
    handler: async ({ copies } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      if (Number(copies) > 1) { try { wb.PrintOut(undefined, undefined, Number(copies)); return { applied: true, copies: Number(copies) }; } catch (e) {} }
      wb.PrintOut();
      return { applied: true };
    }
  });

  // ============ 分组 / 分类汇总 / 迷你图（第三梯队）============

  registry.registerTool({
    name: "et_group_outline",
    hosts: ["et"],
    description: "对行或列分组/取消分组（做分级显示折叠）。axis=rows/columns，range=区域(如 A2:A5 或 B2:D2)，action=group(默认)/ungroup。",
    parameters: {
      type: "object",
      required: ["range", "axis"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        axis: { type: "string", enum: ["rows", "columns"] },
        action: { type: "string", enum: ["group", "ungroup"] }
      }
    },
    handler: async ({ sheet, range, axis, action } = {}) => {
      const target = await getSheetByName(sheet);
      let r = target.Range(range);
      r = axis === "columns" ? r.EntireColumn : r.EntireRow;
      if (action === "ungroup") r.Ungroup(); else r.Group();
      return { sheet: target.Name, axis, action: action || "group", applied: true };
    }
  });

  const SUBTOTAL_FN = { sum: -4157, count: -4112, average: -4106, max: -4136, min: -4139, product: -4149, countNums: -4113 };

  registry.registerTool({
    name: "et_subtotal",
    hosts: ["et"],
    description: "分类汇总（需先按 groupBy 列排好序）。range=含表头区域，groupBy=分组列(区域内1起的列号)，func=sum/count/average/max/min，totalColumns=要汇总的列号数组。",
    parameters: {
      type: "object",
      required: ["range", "groupBy", "totalColumns"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        groupBy: { type: "integer", description: "分组列号(区域内1起)" },
        func: { type: "string", enum: ["sum", "count", "average", "max", "min"] },
        totalColumns: { type: "array", items: { type: "integer" }, description: "要汇总的列号数组" }
      }
    },
    handler: async ({ sheet, range, groupBy, func, totalColumns } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      // Range.Subtotal(GroupBy, Function, TotalList[, Replace, PageBreaks, SummaryBelowData])
      r.Subtotal(Number(groupBy), SUBTOTAL_FN[func || "sum"], totalColumns);
      return { sheet: target.Name, applied: true };
    }
  });

  const SPARK_TYPE = { line: 1, column: 2, winloss: 3 };

  registry.registerTool({
    name: "et_add_sparkline",
    hosts: ["et"],
    description: "在单元格里加迷你图。location=放迷你图的单元格/区域(如 F2:F10)，dataRange=数据源(如 B2:E10)，type=line(折线,默认)/column(柱形)/winloss(盈亏)。",
    parameters: {
      type: "object",
      required: ["location", "dataRange"],
      properties: {
        sheet: { type: "string" },
        location: { type: "string" },
        dataRange: { type: "string" },
        type: { type: "string", enum: ["line", "column", "winloss"] }
      }
    },
    handler: async ({ sheet, location, dataRange, type } = {}) => {
      const target = await getSheetByName(sheet);
      const loc = target.Range(location);
      // Range.SparklineGroups.Add(Type, SourceData)
      loc.SparklineGroups.Add(SPARK_TYPE[type || "line"], dataRange);
      return { sheet: target.Name, location, type: type || "line", applied: true };
    }
  });

  // ============ 单元格样式 / 高级筛选 / 视图缩放（A 组）============

  registry.registerTool({
    name: "et_apply_cell_style",
    hosts: ["et"],
    description: "给区域套用内置单元格样式。styleName 如 Good/Bad/Neutral/Title/Heading 1/Note/Warning Text/Currency/Percent 等（也支持中文样式名）。",
    parameters: {
      type: "object",
      required: ["range", "styleName"],
      properties: { sheet: { type: "string" }, range: { type: "string" }, styleName: { type: "string" } }
    },
    handler: async ({ sheet, range, styleName } = {}) => {
      const target = await getSheetByName(sheet);
      target.Range(range).Style = String(styleName);
      return { sheet: target.Name, range, styleName, applied: true };
    }
  });

  registry.registerTool({
    name: "et_advanced_filter",
    hosts: ["et"],
    description: "高级筛选。range=数据区域(含表头)。criteriaRange=条件区域(省略=仅按 unique 去重)。copyTo=结果复制到的起点(给了就走复制模式，否则原地筛选)。unique=只保留不重复记录。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        criteriaRange: { type: "string" },
        copyTo: { type: "string" },
        unique: { type: "boolean" }
      }
    },
    handler: async ({ sheet, range, criteriaRange, copyTo, unique } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      // AdvancedFilter(Action: xlFilterInPlace=1 / xlFilterCopy=2, CriteriaRange, CopyToRange, Unique)
      const action = copyTo ? 2 : 1;
      r.AdvancedFilter(action, criteriaRange ? target.Range(criteriaRange) : undefined, copyTo ? target.Range(copyTo) : undefined, !!unique);
      return { sheet: target.Name, mode: copyTo ? "copy" : "inPlace", applied: true };
    }
  });

  registry.registerTool({
    name: "et_set_view",
    hosts: ["et"],
    description: "调整视图。zoom=缩放百分比(如 100/150)。goto=跳到并滚动到某单元格/区域(如 A1)。",
    parameters: {
      type: "object",
      properties: { zoom: { type: "integer", minimum: 10, maximum: 400 }, goto: { type: "string" } }
    },
    handler: async ({ zoom, goto } = {}) => {
      const internal = getHost();
      const app = await internal.getApp();
      if (Number(zoom) > 0) { try { app.ActiveWindow.Zoom = Number(zoom); } catch (e) {} }
      if (goto) {
        const sheet = await internal.getActiveSheet();
        const r = sheet.Range(goto);
        try { app.Goto(r, true); } catch (e) { try { r.Select(); } catch (e2) {} }
      }
      return { applied: true };
    }
  });
})(window);
