(function attachPdfHost(global) {
  "use strict";

  function pickString(value) {
    return (typeof value === "string" && value.trim()) ? value.trim() : "";
  }

  function isThenable(value) {
    return value && typeof value.then === "function";
  }

  async function resolveMaybe(value) {
    return isThenable(value) ? await value : value;
  }

  async function firstString(obj, keys) {
    for (const key of keys) {
      try {
        const value = pickString(await resolveMaybe(obj?.[key]));
        if (value) return value;
      } catch (e) {}
    }
    return "";
  }

  function normalizeMaybeFileUrl(raw) {
    let full = pickString(raw);
    if (!full) return "";
    if (/^file:\/\//i.test(full)) {
      try {
        const url = new URL(full);
        let pathname = decodeURIComponent(url.pathname || "");
        if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
        full = pathname || full;
      } catch (e) {
        full = full.replace(/^file:\/\//i, "");
      }
    }
    return full;
  }

  function isAbsoluteLikePath(value) {
    return /^file:\/\//i.test(value)
      || value.startsWith("/")
      || /^[A-Za-z]:[\\/]/.test(value)
      || /^\\\\/.test(value);
  }

  function joinPathLike(dir, name) {
    const d = normalizeMaybeFileUrl(dir);
    const n = pickString(name);
    if (!d || !n || !isAbsoluteLikePath(d)) return "";
    const sep = d.includes("\\") ? "\\" : "/";
    return d.replace(/[\\/]+$/, "") + sep + n.replace(/^[\\/]+/, "");
  }

  function normalizePdfPathCandidate(raw, carrier) {
    const full = normalizeMaybeFileUrl(raw);
    if (!full) return "";
    if (isAbsoluteLikePath(full) && /\.pdf(?:$|[?#])/i.test(full)) return full;
    const looksLikeDir = isAbsoluteLikePath(full) && (/[\\/]$/.test(full) || !/\.[a-zA-Z0-9]{1,8}$/.test(full));
    if (looksLikeDir && carrier) {
      const joined = joinPathLike(full, pickString(carrier.Name) || pickString(carrier.FileName) || pickString(carrier.Title));
      if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;
    }
    return "";
  }

  function detectPdfApp(app) {
    if (!app) return false;
    try { if (app.ActivePDF) return true; } catch (e) {}
    try { if (app.ActivePdf) return true; } catch (e) {}
    try { if (app.ActivePDFDocument) return true; } catch (e) {}
    try { if (app.ActivePdfDoc) return true; } catch (e) {}
    return false;
  }

  async function getApp() {
    const candidates = [];
    const push = (getter) => {
      try {
        const app = getter();
        if (app) candidates.push(app);
      } catch (e) {}
    };
    try {
      if (global.WpsAiAddon?.getApplication) {
        const app = await global.WpsAiAddon.getApplication();
        if (app) candidates.push(app);
      }
    } catch (e) {}
    try {
      if (global.WpsAiAddon?.getApplicationSync) {
        const app = global.WpsAiAddon.getApplicationSync();
        if (app) candidates.push(app);
      }
    } catch (e) {}
    push(() => typeof global.wps?.PdfApplication === "function" ? global.wps.PdfApplication() : null);
    push(() => typeof global.wps?.PDFApplication === "function" ? global.wps.PDFApplication() : null);
    push(() => typeof global.wps?.KPdfApplication === "function" ? global.wps.KPdfApplication() : null);
    push(() => typeof global.wps?.KpdfApplication === "function" ? global.wps.KpdfApplication() : null);
    push(() => global.pdf?.Application);
    push(() => global.kpdf?.Application);
    push(() => global.Application);
    push(() => global.wps?.Application);
    for (const app of candidates) {
      if (detectPdfApp(app)) return app;
    }
    return candidates[0] || null;
  }

  // WPS PDF 暴露的活动文档属性在不同版本里命名不一致，防御性多试几个
  async function getActivePdf() {
    const app = await getApp();
    if (!app) return null;
    try { const v = await resolveMaybe(app.ActivePDF); if (v) return v; } catch (e) {}
    try { const v = await resolveMaybe(app.ActivePdf); if (v) return v; } catch (e) {}
    try { const v = await resolveMaybe(app.ActivePDFDocument); if (v) return v; } catch (e) {}
    try { const v = await resolveMaybe(app.ActivePdfDoc); if (v) return v; } catch (e) {}
    try { const v = await resolveMaybe(app.ActiveDocument); if (v) return v; } catch (e) {}
    return null;
  }

  async function ensurePdf() {
    const pdf = await getActivePdf();
    if (!pdf) throw new Error("未检测到打开的 PDF 文档，请确认插件运行在 WPS PDF 中并已打开文件。");
    return pdf;
  }

  // 取当前 PDF 的本机绝对路径。属性命名各版本不一，多试；FullName 一般是完整路径，
  // Path 有时只是目录，需和 Name 拼。返回绝对路径或 null。
  async function getActivePdfPath() {
    const pdf = await getActivePdf();
    if (!pdf) return null;
    let full = await firstString(pdf, [
      "FullName",
      "FullPath",
      "FilePath",
      "DocumentPath",
      "LocalPath",
      "Path"
    ]);
    full = normalizePdfPathCandidate(full, pdf);
    if (full) return full;

    const dir = await firstString(pdf, ["Path", "DocumentPath", "FolderPath", "Directory", "Dir"]);
    const name = await firstString(pdf, ["Name", "FileName", "Title"]);
    const joined = joinPathLike(dir, name);
    if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;

    for (const key of ["GetFullName", "GetFullPath", "GetFilePath", "GetDocumentPath", "GetLocalPath", "GetPath"]) {
      try {
        const fn = pdf[key];
        if (typeof fn !== "function") continue;
        const path = normalizePdfPathCandidate(await resolveMaybe(fn.call(pdf)), pdf);
        if (path) return path;
      } catch (e) {}
    }
    try {
      const fn = pdf.BuiltinDocumentProperties;
      if (typeof fn === "function") {
        for (const key of ["FullName", "FullPath", "FilePath", "DocumentPath", "Path", "FileName", "Name", "Title"]) {
          try {
            const prop = await resolveMaybe(fn.call(pdf, key));
            const raw = prop && typeof prop === "object" ? await resolveMaybe(prop.Value) : prop;
            const path = normalizePdfPathCandidate(raw, pdf);
            if (path) return path;
          } catch (e) {}
        }
      }
    } catch (e) {}
    if (global.WpsAiAddon?.probePdfPath) {
      try {
        const probe = await global.WpsAiAddon.probePdfPath(await getApp());
        if (probe?.resolvedPath) return probe.resolvedPath;
      } catch (e) {}
    }
    return null;
  }

  function pageCountSync(pdf) {
    try { if (typeof pdf.PageCount === "number") return pdf.PageCount; } catch (e) {}
    try {
      const fn = pdf.GetPageCount;
      if (typeof fn === "function") return Number(fn.call(pdf)) || 0;
    } catch (e) {}
    try { if (pdf.Pages?.Count != null) return Number(pdf.Pages.Count) || 0; } catch (e) {}
    try { if (typeof pdf.Pages === "number") return pdf.Pages; } catch (e) {}
    return 0;
  }

  // 取第 idx 页（1-based）。Pages 集合在不同版本是函数 / Item 方法 / 索引调用，都试一遍
  function getPageSync(pdf, idx) {
    try { if (typeof pdf.GetPage === "function") return pdf.GetPage(idx); } catch (e) {}
    try { if (pdf.Pages?.Item) return pdf.Pages.Item(idx); } catch (e) {}
    try { if (typeof pdf.Pages === "function") return pdf.Pages(idx); } catch (e) {}
    return null;
  }

  function getPageText(page) {
    if (!page) return "";
    try { if (typeof page.GetText === "function") return String(page.GetText() || ""); } catch (e) {}
    try { if (typeof page.GetAllText === "function") return String(page.GetAllText() || ""); } catch (e) {}
    try { if (typeof page.Text === "string") return page.Text; } catch (e) {}
    try { if (typeof page.Content === "string") return page.Content; } catch (e) {}
    return "";
  }

  async function readDocumentText({ maxPages, maxChars } = {}) {
    const pdf = await ensurePdf();
    const total = pageCountSync(pdf);
    if (!total) return "";
    const limit = maxPages && maxPages > 0 ? Math.min(maxPages, total) : total;
    const charCap = maxChars && maxChars > 0 ? maxChars : Infinity;
    const parts = [];
    let acc = 0;
    for (let i = 1; i <= limit; i += 1) {
      const raw = getPageText(getPageSync(pdf, i));
      if (!raw) continue;
      const trimmed = raw.trim();
      parts.push(`【第 ${i} 页】\n${trimmed}`);
      acc += trimmed.length;
      if (acc >= charCap) break;
    }
    return parts.join("\n\n");
  }

  // 按页范围读取，带续读游标。startPage/endPage 为 1-based 闭区间（省略=全篇）；
  // maxChars 截断时 truncated=true 且 nextPage 指向下次续读的页码。
  async function readDocumentRange({ startPage, endPage, maxChars } = {}) {
    const pdf = await ensurePdf();
    const total = pageCountSync(pdf);
    if (!total) return { text: "", from: 0, to: 0, total: 0, truncated: false, nextPage: null };
    let from = startPage && startPage > 0 ? Math.min(Math.floor(startPage), total) : 1;
    let to = endPage && endPage > 0 ? Math.min(Math.floor(endPage), total) : total;
    if (from > to) { const t = from; from = to; to = t; }
    const charCap = maxChars && maxChars > 0 ? maxChars : Infinity;
    const parts = [];
    let acc = 0;
    let lastRead = from - 1;
    let truncated = false;
    for (let i = from; i <= to; i += 1) {
      lastRead = i;
      const raw = getPageText(getPageSync(pdf, i));
      if (!raw) continue;
      const trimmed = raw.trim();
      parts.push(`【第 ${i} 页】\n${trimmed}`);
      acc += trimmed.length;
      if (acc >= charCap) { truncated = true; break; }
    }
    const nextPage = truncated && (lastRead + 1) <= total ? lastRead + 1 : null;
    return { text: parts.join("\n\n"), from, to: lastRead, total, truncated, nextPage };
  }

  async function readSelectionText() {
    // WPS PDF jsapi 不暴露稳定的"当前选区"API。退化为读第 1 页内容做提示
    return readDocumentText({ maxPages: 1 });
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    return readDocumentText();
  }

  function readOnly() {
    throw new Error("PDF 是只读宿主，无法写回原文。请把结果发到对话里，或新建 Word/PPT 再用。");
  }

  function getScopeOptions() {
    return [
      { value: "document", label: "整篇 PDF" },
      { value: "selection", label: "首页（PDF 不支持选区）" }
    ];
  }

  global.WpsAiHostPdf = {
    host: "pdf",
    label: "WPS PDF",
    readDocumentText,
    readDocumentRange,
    readSelectionText,
    readByScope,
    insertText: readOnly,
    replaceSelectionText: readOnly,
    getScopeOptions,
    getActivePdf,
    getActivePdfPath,
    pageCount: async () => pageCountSync(await ensurePdf()),
    readPage: async (idx) => getPageText(getPageSync(await ensurePdf(), Math.max(1, Math.floor(idx || 1))))
  };
})(window);
