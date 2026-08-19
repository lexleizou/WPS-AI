// WpsAiFormatTemplates：AI 排版的「排版模板」——每类元素（标题/副标题/各级标题/正文/引用）
// 的字体/字号/加粗/对齐/行距/首行缩进，外加一段默认排版要求（拼进 AI 提示）。
//
//   - 内置模板：通用（维持现有默认样式）/ 合同 / 公文 / 论文 / 通知
//   - 自定义模板：用户在排版弹窗里新建/编辑/删除，存 lingxi_format_templates_v1（SQLite 受管）
//   - styleMap 会传进 writer 的三条替换路径与预览渲染；style 为 null 的模板走原有默认样式
//
// style 字段：{ font, size(pt), bold, italic, align("left|center|right"), lineSpacing(倍数),
//              firstLineIndentChars(字符) } —— 全部可选，缺省不动。
(function attachFormatTemplates(global) {
  "use strict";

  const STORE_KEY = "lingxi_format_templates_v1";

  const BUILTINS = [
    {
      id: "default",
      name: "通用",
      builtin: true,
      requirement: "",
      styles: null // null = 维持 writer 现有默认样式
    },
    {
      id: "contract",
      name: "合同",
      builtin: true,
      requirement: "正式合同/协议风格：标题居中加粗，条款分级编号清晰（第一条 / 1.1 / a.），正文严谨、术语保留原样、不口语化；签署区/落款单独成段。",
      styles: {
        title:     { font: "黑体", size: 16, bold: true,  align: "center" },
        subtitle:  { font: "宋体", size: 12, bold: false, align: "center" },
        heading1:  { font: "黑体", size: 14, bold: true },
        heading2:  { font: "黑体", size: 12, bold: true },
        heading3:  { font: "黑体", size: 12, bold: true },
        heading4:  { font: "黑体", size: 12, bold: true },
        paragraph: { font: "宋体", size: 12, lineSpacing: 1.5, firstLineIndentChars: 2 },
        quote:     { font: "楷体", size: 12, italic: true }
      }
    },
    {
      id: "gov",
      name: "公文",
      builtin: true,
      requirement: "正式公文风格（参照党政机关公文格式）：主标题居中，一级标题「一、」黑体，二级标题「（一）」楷体，正文仿宋、首行缩进两字符，落款居右。",
      // 公文页边距（GB/T 9704 惯例）：上 3.7 下 3.5 左 2.8 右 2.6 cm
      page: { orientation: "portrait", marginTopCm: 3.7, marginBottomCm: 3.5, marginLeftCm: 2.8, marginRightCm: 2.6 },
      // 中文章节自动编号：一、 /（一）——写入时会先剥掉 AI 已带的编号前缀再统一编
      numbering: { h1: "{zh}、", h2: "（{zh}）" },
      styles: {
        title:     { font: "黑体", size: 22, bold: false, align: "center" },
        subtitle:  { font: "楷体", size: 16, bold: false, align: "center" },
        heading1:  { font: "黑体", size: 16, bold: false },
        heading2:  { font: "楷体", size: 16, bold: false },
        heading3:  { font: "仿宋", size: 16, bold: true },
        heading4:  { font: "仿宋", size: 16, bold: true },
        paragraph: { font: "仿宋", size: 16, lineSpacing: 1.5, firstLineIndentChars: 2 },
        quote:     { font: "仿宋", size: 16 }
      }
    },
    {
      id: "paper",
      name: "论文",
      builtin: true,
      requirement: "学术论文风格：标题层级清晰，摘要 / 引言 / 方法 / 结果 / 结论 等分章节用一级标题，正文段落首行缩进，引用与编号保留。",
      page: { orientation: "portrait", marginTopCm: 2.54, marginBottomCm: 2.54, marginLeftCm: 3.17, marginRightCm: 3.17 },
      numbering: { h1: "{n} ", h2: "{n}.{m} " },
      // 论文一级标题（章）另起一页
      styles: {
        title:     { font: "黑体", size: 16, bold: true,  align: "center" },
        subtitle:  { font: "楷体", size: 12, bold: false, align: "center" },
        heading1:  { font: "黑体", size: 14, bold: true,  pageBreakBefore: true },
        heading2:  { font: "黑体", size: 12, bold: true },
        heading3:  { font: "宋体", size: 12, bold: true },
        heading4:  { font: "宋体", size: 12, bold: true },
        paragraph: { font: "宋体", size: 12, lineSpacing: 1.5, firstLineIndentChars: 2 },
        quote:     { font: "楷体", size: 10.5, italic: true }
      }
    },
    {
      id: "notice",
      name: "通知公告",
      builtin: true,
      requirement: "通知/公告体：主标题醒目居中，事由/正文用书面语，关键信息（时间、地点、要求）用编号列出，末尾落款（单位 + 日期）居右。",
      styles: {
        title:     { font: "黑体", size: 18, bold: true,  align: "center" },
        subtitle:  { font: "楷体", size: 14, bold: false, align: "center" },
        heading1:  { font: "黑体", size: 14, bold: true },
        heading2:  { font: "黑体", size: 12, bold: true },
        heading3:  { font: "黑体", size: 12, bold: true },
        heading4:  { font: "黑体", size: 12, bold: true },
        paragraph: { font: "仿宋", size: 14, lineSpacing: 1.5, firstLineIndentChars: 2 },
        quote:     { font: "楷体", size: 12 }
      }
    }
  ];

  const STYLE_KINDS = ["title", "subtitle", "heading1", "heading2", "heading3", "heading4", "paragraph", "quote"];

  function sanitizeStyle(s) {
    if (!s || typeof s !== "object") return null;
    const out = {};
    if (typeof s.font === "string" && s.font.trim()) out.font = s.font.trim().slice(0, 50);
    const size = Number(s.size);
    if (Number.isFinite(size) && size >= 6 && size <= 72) out.size = size;
    if (typeof s.bold === "boolean") out.bold = s.bold;
    if (typeof s.italic === "boolean") out.italic = s.italic;
    if (s.align === "center" || s.align === "right" || s.align === "left") out.align = s.align;
    if (typeof s.pageBreakBefore === "boolean") out.pageBreakBefore = s.pageBreakBefore;
    const ls = Number(s.lineSpacing);
    if (Number.isFinite(ls) && ls >= 1 && ls <= 4) out.lineSpacing = ls;
    const ind = Number(s.firstLineIndentChars);
    if (Number.isFinite(ind) && ind >= 0 && ind <= 8) out.firstLineIndentChars = ind;
    return Object.keys(out).length ? out : null;
  }

  function sanitizeTemplate(t) {
    if (!t || typeof t !== "object") return null;
    const id = String(t.id || "").trim();
    const name = String(t.name || "").trim().slice(0, 30);
    if (!id || !name) return null;
    const styles = {};
    let hasStyle = false;
    for (const kind of STYLE_KINDS) {
      const s = sanitizeStyle(t.styles && t.styles[kind]);
      if (s) { styles[kind] = s; hasStyle = true; }
    }
    return {
      id,
      name,
      builtin: false,
      requirement: String(t.requirement || "").slice(0, 1000),
      styles: hasStyle ? styles : null,
      updatedAt: Date.now()
    };
  }

  function loadCustom() {
    try {
      const raw = global.WpsAiStore?.getItem?.(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(sanitizeTemplate).filter(Boolean) : [];
    } catch (e) { return []; }
  }

  function persistCustom(list) {
    try { global.WpsAiStore?.setItem?.(STORE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function getAll() {
    return BUILTINS.concat(loadCustom());
  }

  function getById(id) {
    if (!id) return null;
    return getAll().find((t) => t.id === id) || null;
  }

  // 保存自定义模板（同 id 覆盖）。内置 id 不可覆盖 —— 调用方应生成新 id。
  function saveCustom(tpl) {
    const clean = sanitizeTemplate(tpl);
    if (!clean) return null;
    if (BUILTINS.some((b) => b.id === clean.id)) return null;
    const list = loadCustom().filter((t) => t.id !== clean.id);
    list.push(clean);
    persistCustom(list);
    return clean;
  }

  function deleteCustom(id) {
    const list = loadCustom();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return false;
    persistCustom(next);
    return true;
  }

  function newCustomId() {
    return "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 把模板 styles 解析成 writer 用的 styleMap（heading level → headingN；无样式返回 null）
  function resolveStyleMap(tpl) {
    const t = typeof tpl === "string" ? getById(tpl) : tpl;
    if (!t || !t.styles) return null;
    return t.styles;
  }

  // ---- P1-1：中文章节自动编号 + 页面设置 ----

  const ZH_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  // 1..99 → 中文数字（章节编号足够用）
  function toZh(n) {
    const v = Math.max(1, Math.min(99, n | 0));
    if (v < 10) return ZH_DIGITS[v];
    const tens = Math.floor(v / 10);
    const ones = v % 10;
    return (tens > 1 ? ZH_DIGITS[tens] : "") + "十" + (ones ? ZH_DIGITS[ones] : "");
  }

  // AI 输出的标题常自带编号（一、 / 第一章 / 1.1 / （一）），统一编号前先剥掉，避免双前缀
  const EXISTING_NUMBERING_RE = /^\s*(?:第[0-9一二三四五六七八九十百千]+[章节条款篇部卷]\s*|[一二三四五六七八九十]+[、.．]\s*|[(（][一二三四五六七八九十0-9]+[)）]\s*|\d+(?:\.\d+)*\s*[、.．)）]?\s+|\d+(?:\.\d+)+\s*)/;

  function numberingPrefix(pattern, h1, h2) {
    return String(pattern || "")
      .replace(/\{zh\}/g, toZh(h2 > 0 ? h2 : h1))
      .replace(/\{n\}/g, String(h1))
      .replace(/\{m\}/g, String(h2));
  }

  /**
   * 给 blocks 里的 heading 统一编号（纯函数，返回新数组，不改入参）。
   * numbering: { h1: "{zh}、", h2: "（{zh}）" } —— {zh} 中文数字 / {n} 章号 / {m} 节号。
   * h2 计数在每个 h1 下重置；配置了编号的层级会先剥掉原有编号前缀。
   */
  function applyHeadingNumbering(blocks, numbering) {
    if (!numbering || (!numbering.h1 && !numbering.h2) || !Array.isArray(blocks)) return blocks;
    let h1 = 0, h2 = 0;
    return blocks.map((b) => {
      if (!b || b.type !== "heading") return b;
      const level = Math.max(1, Math.min(4, Number(b.level || 1)));
      if (level === 1 && numbering.h1) {
        h1 += 1; h2 = 0;
        const text = String(b.text || "").replace(EXISTING_NUMBERING_RE, "");
        return Object.assign({}, b, { text: numberingPrefix(numbering.h1, h1, 0) + text });
      }
      if (level === 2 && numbering.h2) {
        h2 += 1;
        const text = String(b.text || "").replace(EXISTING_NUMBERING_RE, "");
        return Object.assign({}, b, { text: numberingPrefix(numbering.h2, h1 || 1, h2) + text });
      }
      return b;
    });
  }

  function sanitizePage(p) {
    if (!p || typeof p !== "object") return null;
    const out = {};
    if (p.orientation === "portrait" || p.orientation === "landscape") out.orientation = p.orientation;
    for (const k of ["marginTopCm", "marginBottomCm", "marginLeftCm", "marginRightCm"]) {
      const v = Number(p[k]);
      if (Number.isFinite(v) && v >= 0.5 && v <= 8) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  // writer 替换路径的完整写入选项：样式 + 编号 + 页面设置
  function resolveWriteOptions(tpl) {
    const t = typeof tpl === "string" ? getById(tpl) : tpl;
    if (!t) return { styleMap: null, numbering: null, page: null };
    return {
      styleMap: t.styles || null,
      numbering: (t.numbering && (t.numbering.h1 || t.numbering.h2)) ? t.numbering : null,
      page: sanitizePage(t.page)
    };
  }

  global.WpsAiFormatTemplates = {
    STYLE_KINDS,
    getAll,
    getById,
    saveCustom,
    deleteCustom,
    newCustomId,
    resolveStyleMap,
    resolveWriteOptions,
    applyHeadingNumbering,
    toZh,
    sanitizeTemplate,
    _builtins: BUILTINS
  };
})(window);
