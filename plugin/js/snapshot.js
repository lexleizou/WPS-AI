/**
 * AI 工具执行前 / 执行后的"现场快照"。
 * 给 history 模块提供 before/after 数据。
 *
 * 设计原则：
 *   - 文本型快照（slide 上的标题+所有文本、cell 区域值、selection 文本）
 *   - 不做 PPT 截图（依赖 Slide.Export，开销大；先用文本对比够看清"改了啥"）
 *   - 失败一律返回 null，不抛错，绝不影响工具本身执行
 *   - 异步，但要可控（每个 snapshot 最多 ~500ms）
 *
 * 调用入口：
 *   await WpsAiSnapshot.captureBefore(host, toolName, params) -> { kind, label, data } | null
 *   await WpsAiSnapshot.captureAfter (host, toolName, params, result) -> 同上
 *
 * 还提供：
 *   WpsAiSnapshot.inferTarget(host, toolName, params, result) -> { kind, label } | null
 */
(function attachSnapshot(global) {
  "use strict";

  // ----- 宿主探测 -----

  function detectHost() {
    try {
      if (global.wps && global.wps.WpsApplication) return "wps";
      if (global.et && global.et.Application) return "et";
      if (global.wpp && global.wpp.Application) return "wpp";
    } catch (e) {}
    return "*";
  }

  // ----- WPP / 演示快照 -----

  async function getWppApp() {
    return global.wpp?.Application || global.WpsAiAddon?.getApplication?.();
  }

  async function snapshotSlide(slideIndex) {
    try {
      const app = await getWppApp();
      const pres = app?.ActivePresentation;
      if (!pres) return null;
      const idx = typeof slideIndex === "number" && slideIndex > 0 ? slideIndex : null;
      const slide = idx ? pres.Slides.Item(idx) : app.ActiveWindow?.View?.Slide;
      if (!slide) return null;
      const shapes = slide.Shapes;
      const cnt = shapes?.Count || 0;
      const texts = [];
      let title = "";
      for (let i = 1; i <= cnt; i += 1) {
        const sh = shapes.Item(i);
        let txt = "";
        try { txt = String(sh.TextFrame?.TextRange?.Text || "").trim(); } catch (e) {}
        if (!txt) continue;
        // PpPlaceholderType 1=Title, 3=CenterTitle, 4=Subtitle
        try {
          const ptype = sh.PlaceholderFormat?.Type;
          if (!title && (ptype === 1 || ptype === 3)) title = txt;
        } catch (e) {}
        texts.push({ name: sh.Name || `Shape${i}`, text: txt.length > 200 ? txt.slice(0, 200) + "…" : txt });
      }
      return {
        slideIndex: slide.SlideIndex,
        title,
        shapeCount: cnt,
        texts
      };
    } catch (e) {
      return null;
    }
  }

  async function snapshotPresentation() {
    try {
      const app = await getWppApp();
      const pres = app?.ActivePresentation;
      if (!pres) return null;
      return {
        slideCount: pres.Slides?.Count || 0,
        name: String(pres.Name || "")
      };
    } catch (e) { return null; }
  }

  // ----- ET / 表格快照 -----

  async function getEtApp() {
    return global.et?.Application || global.WpsAiAddon?.getApplication?.();
  }

  async function snapshotEtRange(rangeRef) {
    try {
      const app = await getEtApp();
      const sheet = app?.ActiveSheet;
      if (!sheet) return null;
      let range;
      if (rangeRef) {
        try { range = sheet.Range(rangeRef); } catch (e) { range = null; }
      }
      if (!range) range = app.Selection;
      if (!range) return null;
      const rows = range.Rows?.Count || 1;
      const cols = range.Columns?.Count || 1;
      // 安全上限：>500 单元格的范围只取头部
      const maxRows = Math.min(rows, 50);
      const maxCols = Math.min(cols, 20);
      const values = [];
      for (let r = 1; r <= maxRows; r += 1) {
        const row = [];
        for (let c = 1; c <= maxCols; c += 1) {
          let v = "";
          try { v = range.Cells(r, c).Value2; } catch (e) {}
          if (v == null) v = "";
          row.push(String(v));
        }
        values.push(row);
      }
      return {
        address: String(range.Address || rangeRef || ""),
        rows, cols,
        truncated: rows > maxRows || cols > maxCols,
        values
      };
    } catch (e) { return null; }
  }

  // ----- WPS / 文字快照 -----

  async function getWpsApp() {
    return global.wps?.WpsApplication?.() || global.WpsAiAddon?.getApplication?.();
  }

  async function snapshotWpsSelection() {
    try {
      const app = await getWpsApp();
      const sel = app?.Selection;
      if (!sel) return null;
      let text = "";
      try { text = String(sel.Text || sel.Range?.Text || ""); } catch (e) {}
      if (text.length > 2000) text = text.slice(0, 2000) + "…";
      return { source: "selection", textLength: text.length, text };
    } catch (e) { return null; }
  }

  async function snapshotWpsDocumentMeta() {
    try {
      const app = await getWpsApp();
      const doc = app?.ActiveDocument;
      if (!doc) return null;
      const range = doc.Content || doc.Range;
      let len = 0;
      try { len = String(range?.Text || "").length; } catch (e) {}
      return { source: "document", chars: len };
    } catch (e) { return null; }
  }

  // ----- 工具 → 目标 / snapshot 函数映射 -----

  // 工具名 -> 推断目标 / 选择 snapshot 函数
  // 返回 { kind, label, snapshot(): Promise<snapshot|null> }
  function inferTargetAndCapture(host, toolName, params, result) {
    const p = params || {};
    const r = result?.value || {};

    // 演示
    if (host === "wpp") {
      const slideIdx = p.slide || r.slide || null;
      if (toolName === "wpp_add_slide" || toolName === "wpp_duplicate_slide") {
        // 新增页：before=演示概况, after=新页
        const newIdx = r.slide || r.index || null;
        return {
          kind: "slide",
          label: newIdx ? `新增第 ${newIdx} 页` : "新增幻灯片",
          captureBefore: () => snapshotPresentation(),
          captureAfter: () => newIdx ? snapshotSlide(newIdx) : snapshotPresentation()
        };
      }
      if (toolName === "wpp_delete_slide") {
        const idx = p.slide;
        return {
          kind: "slide",
          label: idx ? `删除第 ${idx} 页` : "删除幻灯片",
          captureBefore: () => snapshotSlide(idx),
          captureAfter: () => snapshotPresentation()
        };
      }
      if (toolName === "wpp_apply_style_preset" && !p.slide) {
        return {
          kind: "document",
          label: "全部幻灯片",
          captureBefore: () => snapshotPresentation(),
          captureAfter: () => snapshotPresentation()
        };
      }
      if (toolName === "wpp_set_slide_transition" && !p.slide) {
        return {
          kind: "document",
          label: "全部幻灯片",
          captureBefore: () => snapshotPresentation(),
          captureAfter: () => snapshotPresentation()
        };
      }
      // 默认：影响单页，snapshot 那一页
      if (slideIdx) {
        return {
          kind: "slide",
          label: `第 ${slideIdx} 页`,
          captureBefore: () => snapshotSlide(slideIdx),
          captureAfter: () => snapshotSlide(slideIdx)
        };
      }
      // 兜底：演示总体
      return {
        kind: "document",
        label: "演示文稿",
        captureBefore: () => snapshotPresentation(),
        captureAfter: () => snapshotPresentation()
      };
    }

    // 表格
    if (host === "et") {
      const ref = p.range || p.address || p.target || null;
      return {
        kind: "range",
        label: ref || "当前选区",
        captureBefore: () => snapshotEtRange(ref),
        captureAfter: () => snapshotEtRange(ref)
      };
    }

    // 文字
    if (host === "wps") {
      // 涉及选区的工具
      return {
        kind: "selection",
        label: "当前选区",
        captureBefore: () => snapshotWpsSelection(),
        captureAfter: () => snapshotWpsSelection()
      };
    }

    return null;
  }

  async function safeCapture(fn) {
    try {
      const timed = new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 500);
        Promise.resolve(fn()).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
      });
      return await timed;
    } catch (e) { return null; }
  }

  async function captureBefore(host, toolName, params) {
    const target = inferTargetAndCapture(host, toolName, params, null);
    if (!target) return { target: null, before: null };
    const before = await safeCapture(target.captureBefore);
    return { target: { kind: target.kind, label: target.label }, before, _captureAfter: target.captureAfter };
  }

  async function captureAfter(captureAfterFn) {
    if (!captureAfterFn) return null;
    return await safeCapture(captureAfterFn);
  }

  global.WpsAiSnapshot = {
    detectHost,
    captureBefore,
    captureAfter,
    snapshotSlide,
    snapshotPresentation,
    snapshotEtRange,
    snapshotWpsSelection
  };
})(window);
