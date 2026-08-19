// 改完自动审核（auto-review）：一轮对话里 AI 跑过修改型工具后，后台自动复核改动。
// 三档（settings.autoReview）：
//   off    —— 关，不出卡片
//   check  —— 仅确定性校验（默认）：汇总本轮修改型工具的执行结果（ok:false / failures 数组）出审核卡
//   visual —— 在 check 基础上：导出当前文档为 PDF → 只渲染改动涉及页 → 截图 + 用户原始要求 +
//              改动摘要发给多模态模型视觉复核 → 出卡片
// 契约约定：
//   - run() 返回 { mode, pass, summary, issues, images? }；images 仅「审核通过」时带
//     （用户明确要求：不通过只显示文字问题清单，不贴图），调用方直接按 pass 渲染即可。
//   - 临时 UI 专用：本模块不写 eventsV2 / conversation / history，截图只活在返回值的内存里。
//   - run() 永不 reject：visual 任何一步失败都降级成 check 结果 + note 注明原因。
(function attachAutoReview(global) {
  "use strict";

  const MODES = ["off", "check", "visual"];
  const DEFAULT_MODE = "check";

  function normalizeMode(value) {
    const v = String(value || "").trim().toLowerCase();
    return MODES.includes(v) ? v : DEFAULT_MODE;
  }

  // ---------------- check：确定性校验汇总 ----------------
  // entries 由 app.js 从 WpsAiHistory 当前 turn 收集：{ toolName, friendlyName, ok, error,
  // failures, params, target, resultSummary }。ok:false 整条算一个问题；ok 但带 failures
  // （写入后读回比对不一致，见 writer.js formatParagraph 的 applyProp）逐字段算一个问题。
  function buildCheckResult(entries) {
    const issues = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry) return;
      const label = entry.friendlyName || entry.toolName || "修改";
      if (entry.ok === false) {
        issues.push({
          page: null,
          item: label,
          expected: "执行成功",
          actual: entry.error || entry.resultSummary || "执行失败"
        });
      }
      (Array.isArray(entry.failures) ? entry.failures : []).forEach((f) => {
        if (!f) return;
        issues.push({
          page: null,
          item: f.field ? `${label} · ${f.field}` : label,
          expected: f.expected != null ? String(f.expected) : "生效",
          actual: f.error || (f.actual != null ? String(f.actual) : "未生效")
        });
      });
    });
    const pass = issues.length === 0;
    const count = (Array.isArray(entries) ? entries : []).length;
    const summary = pass
      ? `本轮 ${count} 项修改的确定性校验全部通过。`
      : `确定性校验发现 ${issues.length} 项问题。`;
    return { pass, summary, issues };
  }

  // ---------------- 改动页定位 ----------------
  // 从 entries 的 params / target 里正则提取 §N 段落锚点（writer-inspector 文档地图的 §N = 段落序号），
  // 交给 writer host 的 getPageNumbersForAnchors 换成页码。cap 60 个：COM 逐段取页是同步调用，
  // 锚点太多（全文改写）会拖慢审核，反正最后也只渲染前几页。
  function extractAnchors(entries) {
    const found = new Set();
    const scan = (text) => {
      String(text || "").replace(/§(\d+)/g, (m, n) => {
        if (found.size < 60) found.add(`§${n}`);
        return m;
      });
    };
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry) return;
      try { scan(JSON.stringify(entry.params || "")); } catch (e) {}
      try { scan(JSON.stringify(entry.target || "")); } catch (e) {}
    });
    return Array.from(found);
  }

  async function locateChangedPages(writer, entries) {
    const anchors = extractAnchors(entries);
    const info = await writer.getPageNumbersForAnchors(anchors);
    let pages = Array.from(new Set(Object.values(info?.map || {})))
      .map((p) => Number(p) || 0)
      .filter((p) => p >= 1)
      .sort((a, b) => a - b);
    // 无锚点（没走 writer-inspector 流程的改动）：取当前选区所在页，再兜底第 1 页
    if (pages.length === 0) pages = [Number(info?.selectionPage) || 1];
    // 大文档限页：页数 > 10 的文档最多渲染 5 页，控渲染耗时与 vision token 开销
    if ((Number(info?.pageCount) || 0) > 10) pages = pages.slice(0, 5);
    return pages;
  }

  // ---------------- PDF 导出 / 取回 ----------------
  // proxy 契约：GET /review/dir 建目录 + GC 后返回 { ok, dir }；PDF 落该目录（turn-<ts>.pdf），
  // 再 POST /load-local-file { path } 把字节读回来（{ ok, base64, size, mediaType }，≤32MB）。
  function proxyBase() {
    // WpsAiRuntime.proxyBase() 函数内现取端口，不要在模块顶层缓存（端口探测是异步完成的）
    return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
  }

  async function exportAndLoadPdf(writer) {
    const dirResp = await fetch(proxyBase() + "/review/dir");
    const dirData = await dirResp.json().catch(() => ({}));
    if (!dirResp.ok || !dirData.ok || !dirData.dir) {
      throw new Error(dirData.error || `获取审阅目录失败（HTTP ${dirResp.status}）`);
    }
    const dir = String(dirData.dir).replace(/[\\/]+$/, "");
    const pdfPath = `${dir}/turn-${Date.now()}.pdf`;
    await writer.exportToPdf(pdfPath);
    const fileResp = await fetch(proxyBase() + "/load-local-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pdfPath })
    });
    const fileData = await fileResp.json().catch(() => ({}));
    if (!fileResp.ok || !fileData.ok || !fileData.base64) {
      throw new Error(fileData.error || `读取导出的 PDF 失败（HTTP ${fileResp.status}）`);
    }
    return base64ToBytes(fileData.base64);
  }

  function base64ToBytes(base64) {
    const bin = atob(String(base64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---------------- pdf.js 懒加载 + 渲染 ----------------
  // pdf.js ~350KB + worker ~1.3MB，只在 visual 档真正审核时才 dynamic import，不进 main.js
  // 同步 scripts（会拖慢启动）。相对 document 的 URL（./js/vendor/...）在 http 加载模式下可用；
  // dev 的 file:// 模式相对 import 会被 CORS 挡，降级走 proxy 的 /asset 路由（带 ACAO:*）。
  let _pdfjsPromise = null;

  function ensurePdfjs() {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = (async () => {
      const relLib = "./js/vendor/pdfjs/pdf.min.mjs";
      const relWorker = "./js/vendor/pdfjs/pdf.worker.min.mjs";
      let lib = null;
      let workerSrc = relWorker;
      try {
        const mod = await import(relLib);
        lib = mod && mod.getDocument ? mod : (global.pdfjsLib || null);
      } catch (e) {
        const assetBase = proxyBase() + "/asset/js/vendor/pdfjs";
        const mod = await import(`${assetBase}/pdf.min.mjs`);
        lib = mod && mod.getDocument ? mod : (global.pdfjsLib || null);
        workerSrc = `${assetBase}/pdf.worker.min.mjs`;
      }
      if (!lib || typeof lib.getDocument !== "function") {
        throw new Error("pdf.js 加载失败（getDocument 不可用）。");
      }
      try {
        if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
          lib.GlobalWorkerOptions.workerSrc = workerSrc;
        }
      } catch (e) {}
      return lib;
    })();
    // 加载失败后清掉缓存，让下次审核能重试（代理可能后来才启动）
    _pdfjsPromise.catch(() => { _pdfjsPromise = null; });
    return _pdfjsPromise;
  }

  async function renderPagesToImages(pdfBytes, pages) {
    const pdfjs = await ensurePdfjs();
    const doc = await pdfjs.getDocument({ data: pdfBytes }).promise;
    const images = [];
    try {
      for (const pageNo of pages) {
        if (pageNo < 1 || pageNo > doc.numPages) continue;
        const page = await doc.getPage(pageNo);
        // scale 1.5：A4 约 918×1296，多模态模型看得清正文，单张 PNG 也就几百 KB
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        images.push({ page: pageNo, dataUrl: canvas.toDataURL("image/png") });
        try { page.cleanup?.(); } catch (e) {}
      }
    } finally {
      try { doc.destroy?.(); } catch (e) {}
    }
    if (!images.length) throw new Error("改动页渲染失败（没有产出任何截图）。");
    return images;
  }

  // ---------------- 多模态视觉复核 ----------------
  // content parts 形状与 app.js 输入框图片附件完全一致：[{type:"text"}, {type:"image_url",
  // image_url:{url:dataUrl}}]，走 WpsAiOpenAI.chatCompletion 非流式。
  function summarizeEntriesForPrompt(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry, i) => {
      const name = entry.friendlyName || entry.toolName || `修改 ${i + 1}`;
      const target = entry.target && entry.target.label ? `（${entry.target.label}）` : "";
      let state;
      if (entry.ok === false) state = `执行失败：${entry.error || "未知错误"}`;
      else if (Array.isArray(entry.failures) && entry.failures.length) {
        state = `部分字段未生效：${entry.failures.map((f) => f.field || f.error || "?").join("、")}`;
      } else state = entry.resultSummary || "执行成功";
      return `- ${name}${target}：${state}`;
    }).join("\n");
  }

  function buildVisionMessages({ prompt, entries, images }) {
    const pageList = images.map((img) => `第 ${img.page} 页`).join("、");
    const text = [
      "你在复核一次 AI 对 Word 文档的修改是否达到了用户的要求。给你【用户原始要求】、【AI 本轮改动摘要】和【改动页截图】。",
      "请逐张检查截图，重点核对：改动摘要里声明的修改在页面上是否真的生效；有无明显排版破损（文字重叠/错位/乱码/丢内容/样式混乱）；有无与本次改动直接相关的其它明显问题。不要挑剔与本次改动无关的既有内容。",
      "只回 JSON，不要 markdown 代码块、不要任何额外文字：",
      '{"pass": true 或 false, "summary": "一句话结论", "issues": [{"page": 页码数字, "item": "问题点", "expected": "应该是什么", "actual": "截图里实际看到什么"}]}',
      "没有问题时 pass 为 true、issues 为空数组。",
      "",
      "【用户原始要求】",
      String(prompt || "").slice(0, 2000),
      "",
      "【AI 本轮改动摘要】",
      summarizeEntriesForPrompt(entries),
      "",
      `【改动页截图】共 ${images.length} 张，按顺序对应：${pageList}`
    ].join("\n");
    const content = [{ type: "text", text }];
    images.forEach((img) => {
      content.push({ type: "image_url", image_url: { url: img.dataUrl } });
    });
    return [{ role: "user", content }];
  }

  // 宽容解析模型回的 JSON：剥 ```json 围栏 → 直接 parse → 抓首个 {...} 块兜底
  function parseReviewJson(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const fenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(fenced); } catch (e) {}
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(fenced.slice(start, end + 1)); } catch (e) {}
    }
    return null;
  }

  function normalizeVisionResult(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    const issues = (Array.isArray(parsed.issues) ? parsed.issues : []).map((it) => ({
      page: Number(it && it.page) || null,
      item: String((it && it.item) || "问题").slice(0, 200),
      expected: String((it && it.expected) || "").slice(0, 300),
      actual: String((it && it.actual) || "").slice(0, 300)
    }));
    return {
      pass: parsed.pass !== false && issues.length === 0,
      summary: String(parsed.summary || "").slice(0, 500),
      issues
    };
  }

  // ---------------- visual 主流程 ----------------
  async function runVisual({ prompt, entries, model, check }) {
    // 前置条件：WPS 文字宿主 + 模型支持图片输入；不满足则降级 check 并在卡片注明
    let host = "";
    try { host = (await global.WpsAiDocument?.getHost?.()) || ""; } catch (e) {}
    const canSee = !!global.WpsAiCapabilities?.supportsImage?.(model);
    if (host !== "wps" || !canSee) {
      const reason = host !== "wps"
        ? "当前宿主不是 WPS 文字"
        : `当前模型「${model || "?"}」不支持图片输入`;
      return Object.assign({}, check, {
        mode: "check",
        note: `已降级为确定性校验（${reason}）。`
      });
    }
    const writer = global.WpsAiHostWriter;
    if (!writer || typeof writer.getPageNumbersForAnchors !== "function" || typeof writer.exportToPdf !== "function") {
      return Object.assign({}, check, { mode: "check", note: "已降级为确定性校验（Writer 宿主能力缺失）。" });
    }

    const pages = await locateChangedPages(writer, entries);
    const pdfBytes = await exportAndLoadPdf(writer);
    const images = await renderPagesToImages(pdfBytes, pages);
    const raw = await global.WpsAiOpenAI.chatCompletion({
      model,
      messages: buildVisionMessages({ prompt, entries, images }),
      temperature: 0
    });
    const vision = normalizeVisionResult(parseReviewJson(raw));
    if (!vision) throw new Error("视觉审核结果解析失败（模型未按要求回 JSON）。");

    // 合并两路结果：确定性校验的问题照列，视觉问题附页码；任一方不通过则整体不通过
    const pass = check.pass && vision.pass;
    const summary = vision.summary || check.summary;
    return {
      mode: "visual",
      pass,
      summary,
      issues: check.issues.concat(vision.issues),
      // 用户明确要求：审核通过才把截图贴在卡片里；不通过只给文字问题清单
      images: pass ? images : undefined
    };
  }

  // ---------------- 主入口 ----------------
  // run({ prompt, entries, model, mode })。entries 是本轮修改型工具记录
  // （app.js 从 WpsAiHistory 当前 turn 收集，含 toolName/ok/failures/params/target）。
  async function run({ prompt, entries, model, mode } = {}) {
    const normalized = normalizeMode(mode);
    const check = buildCheckResult(entries);
    if (normalized !== "visual") {
      return Object.assign({ mode: "check" }, check);
    }
    try {
      return await runVisual({ prompt, entries, model, check });
    } catch (e) {
      // visual 任何一步失败（导出 / 渲染 / 模型调用）都降级成 check 出卡，绝不让审核本身炸出来
      try { console.warn("[auto-review] visual 失败，降级 check:", e?.message || e); } catch (e2) {}
      return Object.assign({ mode: "check" }, check, {
        note: `视觉审核未完成（${String(e?.message || e).slice(0, 120)}），以下为确定性校验结果。`
      });
    }
  }

  global.WpsAiAutoReview = { run, normalizeMode, MODES };
})(window);
