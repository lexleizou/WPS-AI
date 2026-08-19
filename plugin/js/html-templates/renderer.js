// HTML 模板渲染器 —— 把 frontend-slides 风格的 HTML 模板渲染成 PNG（dataURL）。
// 流程：取模板 → 调 render(data, palette) 得到完整 HTML → 写入 1920×1080 隐藏 iframe →
//       等字体加载 → 用 html2canvas 截图 → 返回 PNG dataURL。
//
// 调用方（wpp_render_html_template 工具）拿到 dataURL 后走现有 uploadDataUrl → AddPicture 路径
// 插入到 PPT，整页铺为背景图，文字部分可叠加真文本框（可选）。
//
// 依赖：window.html2canvas（vendor/html2canvas.min.js）+ window.WpsAiHtmlTemplates._registry。
(function attachHtmlRenderer(global) {
  "use strict";

  const STAGE_W = 1920;
  const STAGE_H = 1080;

  function listTemplates() {
    const reg = global.WpsAiHtmlTemplates?._registry || {};
    return Object.keys(reg).sort();
  }

  function getTemplate(name) {
    const reg = global.WpsAiHtmlTemplates?._registry || {};
    return reg[name] || null;
  }

  function listLayouts(name) {
    const tpl = getTemplate(name);
    if (!tpl) return [];
    return Object.keys(tpl.layouts || {});
  }

  // 把 HTML 里 <img src="http(s)://..."> 的远程图先通过 proxy 下载成 dataUrl，
  // 把 src 重写成 dataUrl。这样 html2canvas 走"同源"路径不再受 CORS 拦截 / 不再污染 canvas。
  // 没 proxy 跑（fetch 失败）时静默跳过，html2canvas 仍按原 src 尝试加载。
  // 也匹配 <img ... src='https://...'>（单双引号都支持），跳过 srcset / data:* / file:// 之类的。
  async function inlineRemoteImages(html) {
    const RE = /<img\b[^>]*?\bsrc\s*=\s*("|')(https?:\/\/[^"'\s>]+)\1/gi;
    const matches = [...html.matchAll(RE)];
    if (!matches.length) return { html, count: 0 };
    // 去重以减少请求次数（同一张图被多处引用时）
    const urlSet = Array.from(new Set(matches.map((m) => m[2])));
    const urlToDataUrl = new Map();
    for (const u of urlSet) {
      try {
        const proxyBase = window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
        const resp = await fetch(`${proxyBase}/fetch-remote-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: u })
        });
        if (!resp.ok) continue;
        const json = await resp.json();
        if (json?.ok && json.dataUrl) urlToDataUrl.set(u, json.dataUrl);
      } catch (e) { /* proxy 不可用就跳过，html2canvas 自己撞 CORS */ }
    }
    if (!urlToDataUrl.size) return { html, count: 0 };
    // 把每条 https?://... 替换成 dataUrl（注意只替换 <img src="..."> 这种位置，
    // 避免把 CSS background-image url(...) 也替换了——freeform 也用得到，但先聚焦 img）
    let out = html;
    urlToDataUrl.forEach((dataUrl, src) => {
      // escapeRegExp
      const escSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 用 g flag 替换所有 src="..." / src='...' 出现
      out = out.replace(new RegExp(`(<img\\b[^>]*?\\bsrc\\s*=\\s*)("|')${escSrc}\\2`, "gi"),
        (m, p1, q) => `${p1}${q}${dataUrl}${q}`);
    });
    return { html: out, count: urlToDataUrl.size, total: urlSet.length };
  }

  // html2canvas 不识别 object-fit: cover/contain —— 它把 <img width:100%; height:100%; object-fit:cover>
  // 当成 width:100%; height:100% 渲染（直接拉伸 → 失真）。
  // 修复：把这种 <img> 替换成 <div style="background-image: url(...); background-size: cover/contain; ...">
  // html2canvas 对 background-image 是支持的，cover 行为跟浏览器原生一致。
  // 必须在 waitForFonts 之后（computed style 才稳定）+ html2canvas 之前调。
  function rewriteObjectFitImages(doc) {
    let rewritten = 0;
    const win = doc.defaultView;
    if (!win) return 0;
    const imgs = Array.from(doc.querySelectorAll("img"));
    imgs.forEach((img) => {
      let cs;
      try { cs = win.getComputedStyle(img); } catch (e) { return; }
      const fit = cs?.objectFit;
      if (fit !== "cover" && fit !== "contain") return;
      const src = img.getAttribute("src");
      if (!src) return;
      const div = doc.createElement("div");
      // 复用原 img 的 class/id：保证 parent 选择器仍命中
      if (img.className) div.className = img.className;
      if (img.id) div.id = img.id;
      // 用计算出来的实际宽高（已经是 px），background-position 保留原 object-position
      const objPos = (cs.objectPosition && cs.objectPosition !== "auto") ? cs.objectPosition : "center center";
      div.setAttribute("data-rewritten-from-img", "1");
      div.style.cssText = [
        `width: ${cs.width}`,
        `height: ${cs.height}`,
        `background-image: url("${src.replace(/"/g, '\\"')}")`,
        `background-size: ${fit}`,
        `background-position: ${objPos}`,
        `background-repeat: no-repeat`,
        `display: ${cs.display === "inline" ? "inline-block" : cs.display}`,
        `vertical-align: ${cs.verticalAlign || "baseline"}`,
        // border-radius / overflow 之类是 parent 控的，div 不用复制
      ].join("; ");
      if (img.parentNode) img.parentNode.replaceChild(div, img);
      rewritten += 1;
    });
    return rewritten;
  }

  // 等 iframe 内字体加载完。FontFace API 没就 fallback 到固定延时。
  async function waitForFonts(iframeDoc) {
    try {
      if (iframeDoc.fonts?.ready) {
        await iframeDoc.fonts.ready;
        return;
      }
    } catch (e) { /* fall through */ }
    await new Promise((r) => setTimeout(r, 800));
  }

  // 修复：截图前先把 iframe 里的 ECharts 实际渲染出来。
  // 之前 html2canvas 截图时 [data-echarts-option] 容器还是空 div（父窗口的预览桥接不会跑这个隐藏 iframe），
  // 结果 PPT 插的图里图表区是空白。这里直接在隐藏 iframe 里调用 echarts.init().setOption()，
  // 用 SVG renderer 同步出图，再等一拍让浏览器完成布局/绘制。
  async function bridgeEchartsInDoc(iframeDoc) {
    // echarts 用不上就跳过（降级不画图，旧行为）；这里主动尝试懒加载一次
    if (!window.echarts && global.WpsAiLazyVendor?.ensure) {
      try { await global.WpsAiLazyVendor.ensure("echarts"); } catch (e) { /* 加载失败降级 */ }
    }
    const ec = window.echarts;
    if (!ec) return [];
    const root = iframeDoc.documentElement;
    const cs = iframeDoc.defaultView ? iframeDoc.defaultView.getComputedStyle(root) : null;
    const palette = cs ? [
      (cs.getPropertyValue("--primary") || "#1A6DFF").trim(),
      (cs.getPropertyValue("--accent")  || "#E85D2F").trim(),
      (cs.getPropertyValue("--body-color") || "#475569").trim(),
      (cs.getPropertyValue("--surface") || "#E2E8F0").trim(),
      "#7C5295", "#15803D"
    ] : null;
    const pending = []; // [{chart, container, opt}] 等 finished 后转 inline-SVG
    iframeDoc.querySelectorAll("[data-echarts-option]").forEach((el) => {
      try {
        const opt = JSON.parse(el.getAttribute("data-echarts-option"));
        if (palette && !opt.color) opt.color = palette;
        // 截图场景不要动画 —— 默认 1000ms 动画 → setOption 后立即 setTimeout 截图会截到 0 帧
        opt.animation = false;
        opt.progressive = 0;
        if (!el.style.width && !el.clientWidth) el.style.width = "100%";
        if (!el.style.height && !el.clientHeight) el.style.height = "100%";
        const chart = ec.init(el, null, { renderer: "svg" });
        chart.setOption(opt, { lazyUpdate: false });
        pending.push({ chart, container: el, opt });
      } catch (e) { /* 单格失败不阻塞其他 */ }
    });
    // 处理 canvas 绘制
    iframeDoc.querySelectorAll("canvas[data-canvas-draw]").forEach((c) => {
      try {
        const w = c.clientWidth, h = c.clientHeight;
        if (w && h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d");
        const code = c.getAttribute("data-canvas-draw");
        new Function("ctx", "canvas", "w", "h", code)(ctx, c, c.width, c.height);
      } catch (e) {}
    });
    if (!pending.length) return [];

    // 1) 等每张图 finished 事件（带 1s timeout 兜底）
    await Promise.all(pending.map(({ chart }) => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      try {
        chart.on("finished", finish);
        // 同步路径下 finished 可能已经触发；listener attach 太晚 → 用 rendered 事件兜底
        chart.on("rendered", finish);
      } catch (e) { finish(); return; }
      setTimeout(finish, 1000);
    })));

    // 2) 关键修复：用 chart.renderToSVGString() 拿到稳定的 SVG 字符串，
    //    替换容器内容为 inline <svg>。html2canvas 截动态生成的 echarts SVG 在 WebView
    //    上偶发空白（推测跟 SVG namespace / use href 解析时机有关）；
    //    把它"烘焙"成静态 SVG 后截图就稳了。
    pending.forEach(({ chart, container }) => {
      try {
        if (typeof chart.renderToSVGString === "function") {
          const svgStr = chart.renderToSVGString();
          if (svgStr) {
            // 保证容器仍占 100% 大小
            container.innerHTML = svgStr;
            const svgEl = container.querySelector("svg");
            if (svgEl) {
              svgEl.setAttribute("width", "100%");
              svgEl.setAttribute("height", "100%");
              svgEl.style.width = "100%";
              svgEl.style.height = "100%";
            }
          }
        }
      } catch (e) { /* 单格失败留 init 出来的 SVG 兜底 */ }
    });

    // 3) 再等两个 rAF 让浏览器完成 reflow + 一次 paint
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 50));

    return pending.map((p) => p.chart);
  }

  // 创建一个 1920×1080 的隐藏 iframe，写入 html，等加载完。
  function mountHiddenIframe(html) {
    const iframe = document.createElement("iframe");
    // 不能用 display:none —— html2canvas 截不到不可见元素。
    // 用 absolute + 巨负偏移 + opacity:0，但保证布局有效。
    iframe.style.cssText = [
      "position: absolute",
      "left: -10000px",
      "top: 0",
      `width: ${STAGE_W}px`,
      `height: ${STAGE_H}px`,
      "border: 0",
      "opacity: 0",
      "pointer-events: none"
    ].join("; ");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("scrolling", "no");
    // 修 B15：只给 allow-same-origin（不给 allow-scripts）。AI 生成的 HTML 里若含 <script>，
    // 在无 sandbox 的同源 iframe 里会以插件 origin 执行（可访问 localStorage/API key/WPS API）。
    // 我们的图表由父窗口驱动 echarts（data-echarts-option JSON），不依赖 iframe 内脚本，
    // 因此禁脚本不影响截图渲染，同时消除 <script> 注入执行面。
    iframe.setAttribute("sandbox", "allow-same-origin");
    document.body.appendChild(iframe);
    return new Promise((resolve, reject) => {
      const onLoad = () => {
        iframe.removeEventListener("load", onLoad);
        resolve(iframe);
      };
      iframe.addEventListener("load", onLoad);
      // srcdoc 兼容性广；老版 IE 不支持但 WPS WebView 都是 Chromium
      try {
        iframe.srcdoc = html;
      } catch (e) {
        iframe.removeEventListener("load", onLoad);
        document.body.removeChild(iframe);
        reject(e);
      }
    });
  }

  // 主入口：渲染指定模板 + 布局 → 返回 dataURL。
  // - templateName: "studio" 等 frontend-slides slug
  // - layout: "cover" / "section" / "content" / "stat" 等
  // - data: 字段值对象（具体字段由 template.layouts[layout].fields 定义）
  // - palette: 色板（一般传 wpp_get_style_preset 的返回值或其子集）
  // - opts.scale: 渲染倍数（默认 1，已经是 1920×1080 原始大小；2 = 4K 超清更不易糊）
  async function renderToPng(templateName, layout, data, palette, opts = {}) {
    // 懒加载 html2canvas：普通 chat 冷启动不加载，用到 HTML 模板时才注入
    if (!global.html2canvas) {
      if (global.WpsAiLazyVendor?.ensure) {
        await global.WpsAiLazyVendor.ensure("html2canvas");
      } else {
        throw new Error("html2canvas 未加载（缺 js/lazy-vendor.js）");
      }
    }
    const tpl = getTemplate(templateName);
    if (!tpl) throw new Error(`未知 HTML 模板：${templateName}`);
    const layoutDef = tpl.layouts?.[layout];
    if (!layoutDef) throw new Error(`模板 ${templateName} 没有布局 ${layout}`);

    let html = layoutDef.render(data || {}, palette || {});
    // 远程图（toapis 等 AI 图床）改成 dataUrl，绕开 CORS
    try {
      const { html: rewritten, count, total } = await inlineRemoteImages(html);
      if (count > 0) {
        html = rewritten;
        try { console.log(`[html-renderer] inlined ${count}/${total} remote images to dataUrl`); } catch (e) {}
        try { global.WpsAiLog?.log?.("renderToPng.inlineImages", `${count}/${total} remote → dataUrl`); } catch (e) {}
      }
    } catch (e) { /* 预处理失败不阻塞渲染，html2canvas 继续按原 src 试 */ }

    const iframe = await mountHiddenIframe(html);
    let charts = null;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("iframe document 不可访问（跨域？）");
      await waitForFonts(doc);
      // ECharts / canvas 必须在截图前真实绘制出来，否则 PPT 里图表区是空白
      try { charts = await bridgeEchartsInDoc(doc); } catch (e) { /* 画图失败不阻塞截图 */ }
      // <img object-fit:cover/contain> → <div bg-image> 让 html2canvas 不再把图拉成失真
      try {
        const n = rewriteObjectFitImages(doc);
        if (n > 0) {
          try { console.log(`[html-renderer] rewrote ${n} <img object-fit> → <div background-image>`); } catch (e) {}
          try { global.WpsAiLog?.log?.("renderToPng.objectFit", `rewrote ${n} img`); } catch (e) {}
        }
      } catch (e) {}

      // 关键修：之前 backgroundColor:null 让 html2canvas 截透明 PNG，body 上 background:palette.bg
      // 的颜色被丢掉。预览 iframe 是 DOM 原生渲染所以看得到背景；插入 PPT 后透明 PNG 直接露出
      // slide master 背景，用户看到"没背景色"。改成显式传 palette.backgroundColor 当 canvas 底色。
      const bgFill = (palette && palette.backgroundColor) || "#FFFFFF";
      // 默认 scale=2（3840×2160 输出 → 缩到 PPT slide 时小字号有像素冗余，不糊）。
      // 之前默认 1：1920×1080 等于 1pt=2px 一一对应，小字（24px=12pt）没冗余 → AI 生成
      // 的 chip 标签 / 副标在 PPT 里看着虚。代价：PNG 文件大 4×，但十几页 PPT 也就总几 MB，可控。
      const canvas = await global.html2canvas(doc.body, {
        width: STAGE_W,
        height: STAGE_H,
        scale: opts.scale || 2,
        useCORS: true,
        backgroundColor: bgFill,
        logging: false,
        windowWidth: STAGE_W,
        windowHeight: STAGE_H
      });
      return canvas.toDataURL("image/png");
    } finally {
      // 截完图把 echarts 实例 dispose 掉再卸 iframe，避免实例残留泄漏（多页 batch 时尤其要注意）
      try { (charts || []).forEach((c) => { try { c.dispose(); } catch (e) {} }); } catch (e) {}
      try { iframe.remove(); } catch (e) {}
    }
  }

  // 分图层渲染：把 .stage 拆成 N 张 PNG（背景 + 每个直接子元素一张），
  // 调用方按 layer.x/y/w/h 分别 AddPicture 到 PPT，**每个图层都是独立 shape**，
  // 用户在 PPT 里能选中/移动/缩放各个图层，不再是一张铁板一块的大图。
  //
  // 拆分规则（简单高效，对 freeform / fixed layout 都 OK）:
  //   1. 直接子元素 `.stage > *` 即为图层（DOM 顺序 = z 层底→顶）
  //   2. 背景层 = 把所有直接子元素临时 visibility:hidden 后整张截图，捕获 stage 的 bg/::before/::after
  //   3. 每个直接子元素 = 单独 html2canvas 截图，自带 element 的实际宽高
  //   4. 不递归再拆 grandchild，否则 cover-inner 内的 title+subtitle 会被拆烂，组织复杂还互相覆盖
  //
  // 返回 { width, height, layers: [{x, y, w, h, dataUrl, kind: "background"|"layer"}] }
  // 坐标系：x/y/w/h 单位是 stage 内部 px (1920×1080 基准)。调用方按 PPT slide 实际尺寸缩放。
  async function renderToLayers(templateName, layout, data, palette, opts = {}) {
    // 懒加载 html2canvas：普通 chat 冷启动不加载，用到 HTML 模板时才注入
    if (!global.html2canvas) {
      if (global.WpsAiLazyVendor?.ensure) {
        await global.WpsAiLazyVendor.ensure("html2canvas");
      } else {
        throw new Error("html2canvas 未加载（缺 js/lazy-vendor.js）");
      }
    }
    const tpl = getTemplate(templateName);
    if (!tpl) throw new Error(`未知 HTML 模板：${templateName}`);
    const layoutDef = tpl.layouts?.[layout];
    if (!layoutDef) throw new Error(`模板 ${templateName} 没有布局 ${layout}`);

    let html = layoutDef.render(data || {}, palette || {});
    try {
      const { html: rewritten, count } = await inlineRemoteImages(html);
      if (count > 0) html = rewritten;
    } catch (e) {}
    // 分图层模式默认也 scale=2（4K 超采样），跟 renderToPng 保持一致；小字 / 装饰线不糊
    const scale = opts.scale || 2;

    const iframe = await mountHiddenIframe(html);
    let charts = null;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("iframe document 不可访问（跨域？）");
      await waitForFonts(doc);
      try { charts = await bridgeEchartsInDoc(doc); } catch (e) {}
      try { rewriteObjectFitImages(doc); } catch (e) {}

      const stage = doc.querySelector(".stage") || doc.body;
      const stageRect = stage.getBoundingClientRect();
      const sLeft = stageRect.left;
      const sTop = stageRect.top;

      // 关键修：AI 写 freeform 时很喜欢把全部内容包进一个 .slide / .container 大 wrapper
      // 里，wrapper 自己就是 1920×1080 全屏 → stage 直接子元素只剩 1 个，按它切层等于不切。
      // 自动穿透：如果 stage 只有 1 个直接子元素 + 它几乎占满 stage（>= 90% 面积），
      // 把它的 children 提取出来当真正的层。最多穿 2 层（防止把整页的 main/article 也戳穿）。
      function unwrapSingleFullChild(parent, maxDepth) {
        let cur = parent;
        for (let d = 0; d < maxDepth; d++) {
          const kids = Array.from(cur.children);
          if (kids.length !== 1) break;
          const only = kids[0];
          const r = only.getBoundingClientRect();
          const parentR = cur.getBoundingClientRect();
          const areaRatio = (r.width * r.height) / (parentR.width * parentR.height || 1);
          if (areaRatio < 0.9) break;
          cur = only;
        }
        return Array.from(cur.children);
      }
      const children = unwrapSingleFullChild(stage, 2);

      const layers = [];

      const baseOpts = {
        scale,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        windowWidth: STAGE_W,
        windowHeight: STAGE_H
      };

      // 1) 背景层：临时把所有直接子元素 visibility: hidden，截 stage 整张，
      //    捕获 stage 自身 bg + ::before / ::after + 任何在 stage 上的装饰。
      //    关键修：studio 把 background 挂在 body 上、.stage 自己是透明的。如果跟 baseOpts 一样
      //    传 backgroundColor:null，背景层完全是透明 → PPT 里"没背景色"。改用 palette.backgroundColor
      //    当 canvas 底色，背景层就是一整张纯色，跟 PPT 期望一致。
      const bgFill = (palette && palette.backgroundColor) || "#FFFFFF";
      const prevVis = children.map((c) => c.style.visibility);
      children.forEach((c) => { c.style.visibility = "hidden"; });
      try {
        const bgCanvas = await global.html2canvas(stage, {
          ...baseOpts,
          backgroundColor: bgFill,
          width: STAGE_W,
          height: STAGE_H
        });
        layers.push({
          x: 0, y: 0, w: STAGE_W, h: STAGE_H,
          dataUrl: bgCanvas.toDataURL("image/png"),
          kind: "background"
        });
      } finally {
        children.forEach((c, i) => { c.style.visibility = prevVis[i] || ""; });
      }

      // 2) 每个直接子元素 → 单独一层
      for (const child of children) {
        const r = child.getBoundingClientRect();
        const x = Math.max(0, Math.round(r.left - sLeft));
        const y = Math.max(0, Math.round(r.top - sTop));
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        // 0 宽/高的占位元素（display:none / 空 div）跳过
        if (w <= 1 || h <= 1) continue;
        try {
          const childCanvas = await global.html2canvas(child, {
            ...baseOpts,
            width: w,
            height: h
          });
          layers.push({
            x, y, w, h,
            dataUrl: childCanvas.toDataURL("image/png"),
            kind: "layer"
          });
        } catch (e) { /* 单层失败不影响其他层 */ }
      }

      return { width: STAGE_W, height: STAGE_H, layers };
    } finally {
      try { (charts || []).forEach((c) => { try { c.dispose(); } catch (e) {} }); } catch (e) {}
      try { iframe.remove(); } catch (e) {}
    }
  }

  global.WpsAiHtmlTemplates = global.WpsAiHtmlTemplates || { _registry: {} };
  Object.assign(global.WpsAiHtmlTemplates, {
    renderToPng,
    renderToLayers,
    listTemplates,
    listLayouts,
    getTemplate,
    STAGE_W,
    STAGE_H
  });
})(window);
