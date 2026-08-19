(function attachMarkdownToWord(global) {
  "use strict";

  // wdBuiltinStyle 枚举（Word/WPS 通用，传整数比 locale-dependent 名称稳）
  const STYLE = {
    Normal: -1,
    Heading1: -2,
    Heading2: -3,
    Heading3: -4,
    Heading4: -5,
    Heading5: -6,
    Heading6: -7,
    ListBullet: -19,
    ListNumber: -29,
    Code: -1, // 代码块仍用 Normal，但切等宽字体
    Quote: -1
  };

  /**
   * 把整段 markdown 切成块（heading / paragraph / list-item / hr / code-fence）。
   * 仅处理常用子集，链接/表格/图片不展开（链接保留 URL，表格/图片按段落原样写入）。
   */
  // 计算列表行的缩进层级（0=顶层，每 2 空格或 1 tab 升一层）
  function listLevel(leadingWs) {
    let level = 0;
    for (let i = 0; i < leadingWs.length; i += 1) {
      if (leadingWs[i] === "\t") level += 1;
      else if (leadingWs[i] === " ") {
        // 累计两个空格升一层
        let j = i;
        while (j < leadingWs.length && leadingWs[j] === " " && j - i < 2) j += 1;
        if (j - i === 2) { level += 1; i = j - 1; }
      }
    }
    return Math.min(level, 5);
  }

  // 把一行 | a | b | c | 切成 ["a", "b", "c"]，trim 每个 cell
  function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function tokenizeBlocks(md) {
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let inFence = false;
    let fenceBuf = [];
    let fenceLang = "";

    // 中文 / Unicode 空白全部剥掉。JS 的 \s 正则已经覆盖 U+3000 全角空格、
    // U+00A0 NBSP、U+2000–U+200B 系列、tab、换行等。
    const stripLeadingWs = (s) => String(s || "").replace(/^\s+/, "");
    const flushParagraph = (buf) => {
      if (buf.length === 0) return;
      // 每行各自剥前导空白，再拼接；中间多空格压成单空格；最后整体 trim 兜底
      const text = buf.map(stripLeadingWs).join(" ").replace(/\s+/g, " ").trim();
      if (!text) return;
      blocks.push({ type: "paragraph", text });
    };

    let paraBuf = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // fenced code block
      if (/^\s*```/.test(line)) {
        if (!inFence) {
          flushParagraph(paraBuf); paraBuf = [];
          inFence = true;
          fenceLang = line.replace(/^\s*```/, "").trim();
          fenceBuf = [];
        } else {
          inFence = false;
          blocks.push({ type: "code", text: fenceBuf.join("\n"), lang: fenceLang });
          fenceBuf = [];
          fenceLang = "";
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(line);
        continue;
      }

      // empty line ends paragraph
      if (/^\s*$/.test(line)) {
        flushParagraph(paraBuf); paraBuf = [];
        continue;
      }

      // ATX heading
      // 修 B43：CommonMark 规定关闭 # 序列前必须有空格。旧的 `\s*#*` 会把紧贴内容的 #
      // 当关闭序列剥掉（"# C#" → "C"）。改为 `(?:\s+#+)?` 要求闭合 # 前有空白。
      const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      if (heading) {
        flushParagraph(paraBuf); paraBuf = [];
        const level = Math.min(heading[1].length, 3);
        blocks.push({ type: "heading", level, text: heading[2] });
        continue;
      }

      // horizontal rule
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && /^[\s\-*_]+$/.test(line)) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "hr" });
        continue;
      }

      // markdown table:
      //   | h1 | h2 |
      //   | --- | --- |
      //   | a  | b  |
      // 必须头部行 + 分隔行 + 至少一条数据行
      if (/^\s*\|.+\|\s*$/.test(line)) {
        const sepLine = lines[i + 1];
        if (sepLine && /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|\s*$/.test(sepLine)) {
          flushParagraph(paraBuf); paraBuf = [];
          const headers = splitTableRow(line);
          const rows = [];
          let j = i + 2;
          while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
            rows.push(splitTableRow(lines[j]));
            j += 1;
          }
          blocks.push({ type: "table", headers, rows });
          i = j - 1;
          continue;
        }
      }

      // unordered list item (带 level)
      const ul = /^(\s*)[-*+]\s+(.+)$/.exec(line);
      if (ul) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ul", text: ul[2], level: listLevel(ul[1]) });
        continue;
      }

      // ordered list item (带 level)
      const ol = /^(\s*)\d+\.\s+(.+)$/.exec(line);
      if (ol) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ol", text: ol[2], level: listLevel(ol[1]) });
        continue;
      }

      // blockquote
      const bq = /^\s*>\s?(.*)$/.exec(line);
      if (bq) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "quote", text: bq[1] });
        continue;
      }

      // paragraph line — accumulate until blank
      paraBuf.push(line);
    }

    if (inFence) {
      blocks.push({ type: "code", text: fenceBuf.join("\n"), lang: fenceLang });
    }
    flushParagraph(paraBuf);

    return blocks;
  }

  /**
   * 把一段 markdown 内联文本切成 run 数组：[{ text, bold, italic, code }]
   * 处理：**粗体** *斜体* `代码` ***粗斜*** [文字](url)
   */
  function tokenizeInline(text) {
    const runs = [];
    if (text == null) return runs;
    text = String(text);
    let i = 0;
    let buf = "";
    let bold = false;
    let italic = false;
    const flush = () => {
      if (buf) {
        runs.push({ text: buf, bold, italic, code: false });
        buf = "";
      }
    };

    while (i < text.length) {
      const ch = text[i];
      const next2 = text.slice(i, i + 2);
      const next3 = text.slice(i, i + 3);

      // 反斜杠转义
      if (ch === "\\" && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
        continue;
      }

      // ***bold italic***
      if (next3 === "***") {
        flush();
        const close = text.indexOf("***", i + 3);
        if (close === -1) { buf += "***"; i += 3; continue; }
        runs.push({ text: text.slice(i + 3, close), bold: true, italic: true, code: false });
        i = close + 3;
        continue;
      }

      // **bold**
      if (next2 === "**") {
        flush();
        const close = text.indexOf("**", i + 2);
        if (close === -1) { buf += "**"; i += 2; continue; }
        runs.push({ text: text.slice(i + 2, close), bold: true, italic, code: false });
        i = close + 2;
        continue;
      }

      // __bold__
      if (next2 === "__") {
        flush();
        const close = text.indexOf("__", i + 2);
        if (close === -1) { buf += "__"; i += 2; continue; }
        runs.push({ text: text.slice(i + 2, close), bold: true, italic, code: false });
        i = close + 2;
        continue;
      }

      // *italic*
      if (ch === "*") {
        flush();
        const close = text.indexOf("*", i + 1);
        if (close === -1) { buf += "*"; i += 1; continue; }
        runs.push({ text: text.slice(i + 1, close), bold, italic: true, code: false });
        i = close + 1;
        continue;
      }

      // _italic_  （仅在词边界，避免误吞 file_name）
      if (ch === "_" && (i === 0 || /\s/.test(text[i - 1]))) {
        const close = text.indexOf("_", i + 1);
        if (close > i + 1 && (close + 1 === text.length || /\s|[.,，。！？!?;:、)]/.test(text[close + 1]))) {
          flush();
          runs.push({ text: text.slice(i + 1, close), bold, italic: true, code: false });
          i = close + 1;
          continue;
        }
      }

      // `inline code`
      if (ch === "`") {
        flush();
        const close = text.indexOf("`", i + 1);
        if (close === -1) { buf += "`"; i += 1; continue; }
        runs.push({ text: text.slice(i + 1, close), bold: false, italic: false, code: true });
        i = close + 1;
        continue;
      }

      // [text](url) → 仅写文字 + 后接 (url)（保持简单，不创建超链接对象）
      if (ch === "[") {
        const closeBracket = text.indexOf("]", i + 1);
        if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
          const closeParen = text.indexOf(")", closeBracket + 2);
          if (closeParen !== -1) {
            const linkText = text.slice(i + 1, closeBracket);
            const url = text.slice(closeBracket + 2, closeParen);
            flush();
            runs.push({ text: linkText, bold, italic, code: false });
            runs.push({ text: ` (${url})`, bold, italic, code: false });
            i = closeParen + 1;
            continue;
          }
        }
      }

      buf += ch;
      i += 1;
    }

    flush();
    return runs;
  }

  // 安全设置某属性，COM 对象偶发 readonly / 不支持时不报错
  function safeSet(obj, prop, value) {
    try { obj[prop] = value; } catch (error) { /* ignore */ }
  }

  function applyStyle(selection, styleId) {
    safeSet(selection, "Style", styleId);
  }

  function resetParagraph(selection) {
    applyStyle(selection, STYLE.Normal);
    try { selection.Range.ListFormat?.RemoveNumbers?.(); } catch (e) {}
    // 把段落左缩进 / 首行缩进归零，避免继承前一段（特别是从列表后切回正文）的缩进。
    // 中文 Word 有两套缩进度量：
    //   - 点(pt)单位 ：FirstLineIndent / LeftIndent / RightIndent
    //   - 字符单位   ：CharacterUnitFirstLineIndent / CharacterUnitLeftIndent / CharacterUnitRightIndent
    // 常见的"正文"样式默认首行缩进 2 字符 = CharacterUnitFirstLineIndent=2;
    // 只清 pt 那一套不够，会被字符单位的值再叠回来——这是"扩写后段首 16 字符缩进"的真正源头。
    // 两套一起置 0 才彻底干净。
    try {
      const pf = selection.ParagraphFormat;
      if (pf) {
        safeSet(pf, "LeftIndent", 0);
        safeSet(pf, "FirstLineIndent", 0);
        safeSet(pf, "RightIndent", 0);
        safeSet(pf, "CharacterUnitLeftIndent", 0);
        safeSet(pf, "CharacterUnitFirstLineIndent", 0);
        safeSet(pf, "CharacterUnitRightIndent", 0);
      }
    } catch (e) {}
  }

  // 给当前列表段落施加嵌套缩进：每多一层 ~14pt 左缩进（约半个汉字宽）
  function applyListLevel(selection, level) {
    if (!level || level < 1) return;
    try {
      const pf = selection.ParagraphFormat;
      if (pf) safeSet(pf, "LeftIndent", 14 * level);
    } catch (e) {}
  }

  // 写 Word 原生表格：block = { rows:[[cell]], header:bool }。header 时首行加粗+浅底。
  function writeTable(selection, block) {
    const rows = Array.isArray(block.rows) ? block.rows.map((r) => Array.isArray(r) ? r : []) : [];
    const rowCount = rows.length;
    if (rowCount === 0) return;
    const colCount = Math.max(1, ...rows.map((r) => r.length));
    const hasHeader = block.header !== false;

    let table;
    try {
      const range = selection.Range;
      table = range.Tables.Add(range, rowCount, colCount);
    } catch (e) {
      // 兜底：制表符分隔纯文本
      rows.forEach((r, ri) => {
        writeRuns(selection, [{ text: r.join("\t"), bold: hasHeader && ri === 0 }]);
        newParagraph(selection);
      });
      return;
    }

    try { table.Style = -111; } catch (e) {}      // wdStyleTableGrid
    try { table.AutoFitBehavior(1); } catch (e) {} // wdAutoFitContent

    rows.forEach((row, ri) => {
      for (let c = 0; c < colCount; c += 1) {
        try { table.Cell(ri + 1, c + 1).Range.Text = row[c] || ""; } catch (e) {}
      }
    });

    if (hasHeader) {
      try {
        const headerRow = table.Rows.Item(1);
        headerRow.Range.Font.Bold = true;
        try { headerRow.Shading.BackgroundPatternColor = 15921906; } catch (e) {}
      } catch (e) {}
    }
    try { table.Range.Font.Size = 10.5; } catch (e) {}

    try {
      selection.SetRange(table.Range.End, table.Range.End);
      selection.MoveDown?.();
    } catch (e) {}
    try { selection.TypeParagraph(); } catch (e) {}
  }

  // WPS/Word 的 TypeText 不会把 \n 当换行（直接被吞或变空格）→ 整段替换（如翻译替换）会丢换行。
  // 这里按换行拆开，段内用软回车(\x0B, Shift+Enter)保留换行——不新建段落/列表项，最安全。
  // markdown 段落经 tokenizeBlocks 已把换行折成空格、不含 \n，所以只影响 coerceBlocks 的整段文本。
  function typeWithLineBreaks(selection, text) {
    const s = String(text == null ? "" : text);
    if (!/[\r\n]/.test(s)) {
      try { selection.TypeText(s); } catch (e) { if (typeof selection.InsertAfter === "function") selection.InsertAfter(s); }
      return;
    }
    const parts = s.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        try { selection.TypeText("\x0B"); }
        catch (e) { try { if (selection.InsertBreak) selection.InsertBreak(6 /* wdLineBreak */); } catch (e2) {} }
      }
      const p = parts[i];
      if (p) { try { selection.TypeText(p); } catch (e) { if (typeof selection.InsertAfter === "function") selection.InsertAfter(p); } }
    }
  }

  function writeRuns(selection, runs) {
    let isFirstRun = true;
    for (const run of runs) {
      // 第一个 run 再剥一次前导空白（双保险），避免 tokenizer 漏过的导致段首被 typed 空格
      let text = run.text;
      if (isFirstRun && typeof text === "string") {
        text = text.replace(/^\s+/, "");
        isFirstRun = false;
      }
      if (!text) continue;
      const prevBold = selection.Font.Bold;
      const prevItalic = selection.Font.Italic;
      const prevName = selection.Font.Name;

      safeSet(selection.Font, "Bold", !!run.bold);
      safeSet(selection.Font, "Italic", !!run.italic);
      if (run.code) {
        safeSet(selection.Font, "Name", "Consolas");
      }

      typeWithLineBreaks(selection, text);

      // 还原内联格式
      if (run.code) safeSet(selection.Font, "Name", prevName);
      safeSet(selection.Font, "Italic", prevItalic);
      safeSet(selection.Font, "Bold", prevBold);
    }
  }

  function newParagraph(selection) {
    if (typeof selection.TypeParagraph === "function") {
      selection.TypeParagraph();
    } else {
      selection.TypeText("\n");
    }
  }

  // AI 面向块 → runs 数组。runs 存在直接用；否则纯文本单 run。全程不解析 markdown。
  function runsForBlock(block) {
    if (Array.isArray(block.runs)) {
      return block.runs
        .filter((r) => r && typeof r.text === "string")
        .map((r) => ({ text: r.text, bold: !!r.bold, italic: !!r.italic, code: !!r.code }));
    }
    return [{ text: typeof block.text === "string" ? block.text : "", bold: false, italic: false, code: false }];
  }

  /**
   * 把结构化 blocks 数组写入 Selection 当前位置（Word 原生格式）。
   * @param {object} selection - WPS Word Application.Selection
   * @param {Array} blocks - AI 面向块数组（schema 见设计文档）
   * @param {object} options - options.replace=true 时先清空选区
   */
  function writeBlocks(selection, blocks, options = {}) {
    if (!selection) throw new Error("缺少 Selection 对象");
    const list = Array.isArray(blocks) ? blocks : [];
    if (list.length === 0) return { blocks: 0 };

    if (options.replace) {
      try { selection.Delete(); } catch (e) {
        try { selection.Text = ""; } catch (e2) {}
      }
    }

    list.forEach((block, idx) => {
      if (!block || typeof block !== "object") return;
      try {
        switch (block.type) {
          case "heading": {
            resetParagraph(selection);
            const lvl = Math.min(Math.max(parseInt(block.level, 10) || 1, 1), 6);
            applyStyle(selection, [STYLE.Heading1, STYLE.Heading2, STYLE.Heading3, STYLE.Heading4, STYLE.Heading5, STYLE.Heading6][lvl - 1]);
            writeRuns(selection, runsForBlock(block));
            newParagraph(selection);
            resetParagraph(selection);
            break;
          }
          case "list": {
            const items = Array.isArray(block.items) ? block.items : [];
            const ordered = !!block.ordered;
            items.forEach((item) => {
              applyStyle(selection, ordered ? STYLE.ListNumber : STYLE.ListBullet);
              try {
                if (ordered) selection.Range.ListFormat?.ApplyNumberDefault?.();
                else selection.Range.ListFormat?.ApplyBulletDefault?.();
              } catch (e) {
                writeRuns(selection, [{ text: ordered ? "1. " : "• " }]);
              }
              applyListLevel(selection, parseInt(block.level, 10) || 0);
              writeRuns(selection, runsForBlock({ text: typeof item === "string" ? item : (item && item.text) || "", runs: item && item.runs }));
              newParagraph(selection);
            });
            resetParagraph(selection);
            break;
          }
          case "table":
            resetParagraph(selection);
            writeTable(selection, block);
            break;
          case "code": {
            resetParagraph(selection);
            const prevName = selection.Font.Name;
            safeSet(selection.Font, "Name", "Consolas");
            try { selection.TypeText(String(block.text || "")); } catch (e) {
              if (typeof selection.InsertAfter === "function") selection.InsertAfter(String(block.text || ""));
            }
            safeSet(selection.Font, "Name", prevName);
            newParagraph(selection);
            resetParagraph(selection);
            break;
          }
          case "quote":
            resetParagraph(selection);
            writeRuns(selection, [{ text: "│ ", bold: false, italic: true, code: false }]);
            writeRuns(selection, runsForBlock(block));
            newParagraph(selection);
            break;
          case "spacer":
            newParagraph(selection);
            break;
          case "paragraph":
          default: {
            resetParagraph(selection);
            // 替换列表项时保留其项目符号 / 编号（caller 经 options.listFormat 传入）。
            // 仅 paragraph 块享受此待遇；显式 list/heading/table 块不受影响。
            const lf = options.listFormat;
            if (lf && (lf.kind === "bullet" || lf.kind === "numbered")) {
              applyStyle(selection, lf.kind === "numbered" ? STYLE.ListNumber : STYLE.ListBullet);
              try {
                if (lf.kind === "numbered") selection.Range.ListFormat?.ApplyNumberDefault?.();
                else selection.Range.ListFormat?.ApplyBulletDefault?.();
              } catch (e) {}
              applyListLevel(selection, Math.max(0, (parseInt(lf.level, 10) || 1) - 1));
            }
            writeRuns(selection, runsForBlock(block));
            if (idx !== list.length - 1) newParagraph(selection);
          }
        }
      } catch (err) {
        try { global.WpsAiLog?.log?.("writeBlocks:block-error", { idx, type: block.type, err: err?.message || String(err) }); } catch (_) {}
      }
    });

    return { blocks: list.length };
  }

  // markdown 字符串 → AI 面向 blocks（仅供内部预设复用保留的 tokenizer；AI 工具路径不经此）。
  function blocksFromMarkdown(md) {
    const toks = tokenizeBlocks(md);
    const out = [];
    // 合并连续同类型 list 项为一个 list 块：writeBlocks 对每个 list 块各自
    // ApplyNumberDefault + resetParagraph，若每行一块会让有序列表重新从 1 计数
    // （"1. 1. 1." 而非 "1. 2. 3."）。ul 段跟着 ol 段则拆成两块。
    let pending = null;
    const flushPending = () => { if (pending) { out.push(pending); pending = null; } };
    for (const t of toks) {
      if (t.type === "ul" || t.type === "ol") {
        const ordered = t.type === "ol";
        if (pending && pending.ordered === ordered) {
          pending.items.push({ runs: tokenizeInline(t.text) });
        } else {
          flushPending();
          pending = { type: "list", ordered, level: t.level || 0, items: [{ runs: tokenizeInline(t.text) }] };
        }
        continue;
      }
      flushPending();
      switch (t.type) {
        case "heading":
          out.push({ type: "heading", level: t.level, text: t.text });
          break;
        case "paragraph":
          out.push({ type: "paragraph", runs: tokenizeInline(t.text) });
          break;
        case "table":
          out.push({ type: "table", header: true, rows: [t.headers || [], ...((t.rows) || [])] });
          break;
        case "code":
          out.push({ type: "code", text: t.text, lang: t.lang });
          break;
        case "quote":
          out.push({ type: "quote", text: t.text });
          break;
        case "hr":
          out.push({ type: "spacer" });
          break;
        default:
          if (t.text) out.push({ type: "paragraph", text: t.text });
      }
    }
    flushPending();
    return out;
  }

  // 纯文本 → paragraph 块（按换行切段，保留段落；空行→spacer）。不解析 markdown。
  function paragraphBlocks(text) {
    // \r\n / 单独 \r（Word 段落标记，模型有时原样回显）都归一成 \n 再切段
    const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const out = lines.map((ln) => (ln.trim() === "" ? { type: "spacer" } : { type: "paragraph", text: ln }));
    while (out.length && out[out.length - 1].type === "spacer") out.pop();
    return out.length ? out : [{ type: "paragraph", text: "" }];
  }

  global.WpsAiMarkdownToWord = {
    writeBlocks,
    writeTable,
    runsForBlock,
    blocksFromMarkdown,
    paragraphBlocks,
    tokenizeBlocks,
    tokenizeInline
  };
})(window);
