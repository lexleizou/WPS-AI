// studio 模板：通用骨架 + 多种排版布局，**完全由当前 stylePreset 色板与字体驱动**。
// 选 Bold Signal 就出黑橙、选 Dark Botanical 就出深绿金，不再固定黑底黄字。
//
// 已实装布局（让 AI 能搭一整套 deck 不必 fallback 到直写工具）：
//   - cover：封面（巨型标题 + 副标）
//   - section：章节分隔（巨号 + 章节名）
//   - content：内容页（标题 + 多行要点）
//   - stat：数据强爆（巨型数字 + 标签 + 描述）
//   - feature-grid：2×2 特性矩阵（每格 = 图标 + 标题 + 正文）
//   - quote：金句页（大引号 + 引文 + 署名）
//   - comparison：对比页（左右两栏 + 图标 + 列表）
//   - metric-trio：三联指标（每格 = 图标 + 数字 + 标签）
//
// 字段全部走 escapeHtml；data.body 支持 \n 换行。图标用内置 lucide-style 线性 SVG，
// 名字写在字段里（如 "lightbulb"），未知图标自动 fallback 为 sparkles。
(function attachStudio(global) {
  "use strict";

  const CJK_FALLBACK = "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'WenQuanYi Micro Hei', system-ui, sans-serif";

  function cssFont(name) {
    const n = String(name || "").trim();
    if (!n) return CJK_FALLBACK;
    const quoted = /^[\w-]+$/.test(n) ? n : `'${n.replace(/'/g, "\\'")}'`;
    return `${quoted}, ${CJK_FALLBACK}`;
  }

  // 修 #17: 给固定 layout 暴露 titleSize/bodySize/numberSize 等字号字段。
  // sanitizeSize 把 AI 传的字号统一成 px（接受 "60" / "60px" / 60 / "60pt" → 转 px）。
  // 越界数值丢弃返回 fallback；让 AI 文本超长时能压字号而不需要换 freeform。
  function sanitizeSize(v, fallback, minPx, maxPx) {
    if (v == null || v === "") return fallback;
    let s = String(v).trim().toLowerCase();
    let px;
    if (s.endsWith("pt")) px = parseFloat(s) * 2; // 1pt ≈ 2px (1920×1080 画布约定)
    else px = parseFloat(s); // 默认按 px
    if (!isFinite(px) || px <= 0) return fallback;
    if (typeof minPx === "number" && px < minPx) return fallback;
    if (typeof maxPx === "number" && px > maxPx) return fallback;
    return Math.round(px);
  }

  function resolvePalette(p) {
    return {
      bg: p?.backgroundColor || "#FFFFFF",
      surface: p?.surfaceColor || "#F4F4F5",
      primary: p?.primaryColor || "#1A1A1A",
      accent: p?.accentColor || "#FF5722",
      titleColor: p?.titleColor || p?.primaryColor || "#1A1A1A",
      bodyColor: p?.bodyColor || "#404040",
      titleFont: cssFont(p?.titleFont),
      bodyFont: cssFont(p?.bodyFont)
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function multilineHtml(s) {
    return escapeHtml(String(s || "")).replace(/\n/g, "<br>");
  }

  // 编辑感细节：右下角"03 / 12 · BRAND"小字。可选字段 pageIndex / brand，
  // 用户都不传就不渲染。注入到任何 layout 的 stage 内。
  // pageIndex 可以是 "03 / 12" 或 "3" 都行；brand 是小品牌名/客户名。
  function pageIndicatorHtml(data) {
    const pi = String(data?.pageIndex || "").trim();
    const brand = String(data?.brand || "").trim();
    if (!pi && !brand) return "";
    const parts = [];
    if (pi) parts.push(`<span>${escapeHtml(pi)}</span>`);
    if (pi && brand) parts.push(`<span class="pi-sep"></span>`);
    if (brand) parts.push(`<span>${escapeHtml(brand)}</span>`);
    return `<div class="page-indicator">${parts.join("")}</div>`;
  }

  // ===== lucide 线性图标库（24×24 viewBox，stroke=currentColor）=====
  // 精选 ~28 个常用 PPT 图标。AI 用名字引用，未知名 fallback 到 sparkles。
  const ICONS = {
    "lightbulb": '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    "sparkles": '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    "zap": '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    "rocket": '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    "target": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    "trending-up": '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    "trending-down": '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    "user": '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    "check": '<polyline points="20 6 9 17 4 12"/>',
    "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    "x": '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    "x-circle": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    "arrow-right": '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    "arrow-down": '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    "bar-chart": '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    "pie-chart": '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    "activity": '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    "lock": '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    "calendar": '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    "book": '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    "star": '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    "heart": '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    "map-pin": '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    "briefcase": '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    "code": '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
  };

  // 渲染图标：返回 inline SVG 字符串。size 单位 px，color 默认 currentColor。
  function icon(name, size = 48, color = "currentColor") {
    const paths = ICONS[name] || ICONS["sparkles"];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">${paths}</svg>`;
  }

  // 组合 <head> + <body>
  // 把 palette 暴露成 CSS 变量，freeform / 后续自定义 layout 可直接用 var(--primary) 引用。
  function doc(palette, bodyHtml, extraCss = "") {
    return `<!doctype html><html><head><meta charset="utf-8">
<style>
:root {
  --bg: ${palette.bg};
  --surface: ${palette.surface};
  --primary: ${palette.primary};
  --accent: ${palette.accent};
  --title-color: ${palette.titleColor};
  --body-color: ${palette.bodyColor};
  --title-font: ${palette.titleFont};
  --body-font: ${palette.bodyFont};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; }
body {
  background: ${palette.bg};
  color: ${palette.bodyColor};
  font-family: ${palette.bodyFont};
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.stage { width: 1920px; height: 1080px; padding: 80px 140px; position: relative; }
.grid-tag {
  position: absolute; top: 64px; left: 140px;
  font-family: ${palette.titleFont};
  font-size: 22px; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase;
  color: ${palette.accent};
}
.footer-tag {
  position: absolute; bottom: 56px; left: 140px; right: 140px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: ${palette.titleFont};
  font-size: 20px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase;
  color: ${palette.bodyColor};
}
.accent-bar { position: absolute; left: 140px; width: 64px; height: 4px; background: ${palette.accent}; }
/* 编辑感页码指示：右下角小字 "03 / 12 · BRAND"。任何 layout 通过 .page-indicator 复用，
   颜色取 bodyColor 弱化，字号 18px=9pt 是不抢戏的细节。 */
.page-indicator {
  position: absolute;
  right: 140px; bottom: 56px;
  font-family: ${palette.titleFont};
  font-size: 18px; font-weight: 700;
  letter-spacing: 0.28em; text-transform: uppercase;
  color: ${palette.bodyColor}; opacity: 0.55;
  display: flex; gap: 14px; align-items: center;
}
.page-indicator .pi-sep { width: 18px; height: 1px; background: ${palette.bodyColor}; opacity: 0.6; }
/* echarts 容器默认样式：AI 写 <div class="chart" data-echarts-option='{...}'></div> 即可被父窗口自动渲染 */
[data-echarts-option] { width: 100%; height: 100%; }
${extraCss}
</style>
</head>
<body><div class="stage">${bodyHtml}</div></body></html>`;
  }

  const TEMPLATE = {
    slug: "studio",
    label: "Studio（通用骨架，按当前色板渲染）",
    icons: Object.keys(ICONS), // 供 AI 看可用图标列表
    layouts: {
      // ============================================================
      // cover: 封面
      // ============================================================
      cover: {
        fields: ["title", "subtitle", "tag", "titleSize", "subtitleSize", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const subtitle = escapeHtml(data.subtitle || "");
          const tag = escapeHtml(data.tag || "");
          // 修 #17: 字数多时 AI 可以传 titleSize=140 压一压；越界丢弃回 fallback
          const titleSize = sanitizeSize(data.titleSize, 200, 40, 320);
          const subtitleSize = sanitizeSize(data.subtitleSize, 40, 16, 80);
          // 应用 rule-of-thirds: 标题放在 2/3 处下方（justify-content:flex-end + padding-bottom）
          // 配 accent-bar 做 hero 入口指示，是 modern keynote / pitch deck 标准开场。
          const body = `
            ${tag ? `<div class="grid-tag">${tag}</div>` : ""}
            <div class="cover-inner">
              <div class="accent-bar" style="position:relative;left:0;margin-bottom:36px"></div>
              <div class="cover-title">${title}</div>
              ${subtitle ? `<div class="cover-subtitle">${subtitle}</div>` : ""}
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 160px; }
            .cover-title {
              font-family: ${palette.titleFont};
              font-size: ${titleSize}px; font-weight: 900; line-height: 0.96;
              letter-spacing: -0.03em; color: ${palette.titleColor};
              max-width: 1640px;
            }
            .cover-subtitle {
              margin-top: 40px;
              font-family: ${palette.titleFont};
              font-size: ${subtitleSize}px; font-weight: 700; letter-spacing: 0.18em;
              text-transform: uppercase; color: ${palette.bodyColor};
              max-width: 1500px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // section: 章节分隔
      // ============================================================
      section: {
        fields: ["number", "title", "subtitle", "footer", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const number = escapeHtml(data.number || "01");
          const title = multilineHtml(data.title || "");
          const subtitle = escapeHtml(data.subtitle || "");
          const footer = escapeHtml(data.footer || "");
          // 章节号从 320px 收到 260px —— 大但不压迫；同时叠加 1px 细横线 + 副标，给杂志式
          // 章节扉页气质（章节号 / 横线 / 章节名 / 一句话提要）。
          const body = `
            <div class="sec-grid">
              <div class="sec-meta">
                <div class="sec-number">${number}</div>
                <div class="sec-rule"></div>
              </div>
              <div class="sec-body">
                <div class="sec-title">${title}</div>
                ${subtitle ? `<div class="sec-subtitle">${subtitle}</div>` : ""}
              </div>
            </div>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; padding-top: 160px; padding-bottom: 160px; }
            .sec-grid { display: grid; grid-template-columns: 5fr 7fr; gap: 80px; align-items: center; }
            .sec-meta { display: flex; flex-direction: column; gap: 40px; align-items: flex-start; }
            .sec-number {
              font-family: ${palette.titleFont};
              font-size: 260px; font-weight: 900; line-height: 0.85;
              letter-spacing: -0.04em; color: ${palette.accent};
            }
            .sec-rule { width: 240px; height: 4px; background: ${palette.accent}; opacity: 0.7; }
            .sec-body { display: flex; flex-direction: column; gap: 24px; }
            .sec-title {
              font-family: ${palette.titleFont};
              font-size: 84px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
            }
            .sec-subtitle {
              font-family: ${palette.bodyFont};
              font-size: 36px; font-weight: 500; line-height: 1.4;
              color: ${palette.bodyColor};
              max-width: 880px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // content: 标题 + 多行要点
      // ============================================================
      content: {
        fields: ["title", "body", "tag", "footer", "titleSize", "bodySize", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const lines = String(data.body || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
          const tag = escapeHtml(data.tag || "");
          const footer = escapeHtml(data.footer || "");
          const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
          // 修 #17: 6 行要点放不下时 AI 可 bodySize=32 压字号；标题太长可 titleSize=64
          // 默认 bodySize=40 (=20pt) 符合 modern pitch deck 正文标准（最低 18pt）
          const titleSize = sanitizeSize(data.titleSize, 88, 30, 180);
          const bodySize = sanitizeSize(data.bodySize, 40, 20, 64);
          const body = `
            ${tag ? `<div class="grid-tag">${tag}</div>` : ""}
            <div class="content-title">${title}</div>
            <ul class="content-body">${items}</ul>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; gap: 56px; padding-top: 160px; padding-bottom: 160px; }
            .content-title {
              font-family: ${palette.titleFont};
              font-size: ${titleSize}px; font-weight: 800; line-height: 1.04;
              letter-spacing: -0.015em; max-width: 1640px;
              color: ${palette.titleColor};
            }
            .content-body {
              font-family: ${palette.bodyFont};
              font-size: ${bodySize}px; font-weight: 500; line-height: 1.6;
              list-style: none; padding: 0; margin: 0; max-width: 1640px;
              color: ${palette.bodyColor};
            }
            .content-body li { padding: 10px 0 10px 60px; position: relative; }
            .content-body li::before {
              content: "›"; position: absolute; left: 0; top: 6px;
              font-family: ${palette.titleFont};
              font-size: 48px; font-weight: 900;
              color: ${palette.accent};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // stat: 巨型数字 + 标签 + 描述
      // ============================================================
      stat: {
        fields: ["number", "label", "description", "numberSize", "labelSize", "descSize", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const number = escapeHtml(data.number || "0");
          const label = escapeHtml(data.label || "");
          const description = multilineHtml(data.description || "");
          // 修 #17: 数字长（"1,234,567"）AI 可 numberSize=280；描述多行可 descSize=32
          // descSize 提到 40 (=20pt) 符合 modern pitch deck 正文标准
          const numberSize = sanitizeSize(data.numberSize, 440, 80, 600);
          const labelSize = sanitizeSize(data.labelSize, 64, 24, 120);
          const descSize = sanitizeSize(data.descSize, 40, 20, 60);
          const body = `
            <div class="stat-inner">
              <div class="stat-number">${number}</div>
              ${label ? `<div class="stat-label">${label}</div>` : ""}
              ${description ? `<div class="stat-desc">${description}</div>` : ""}
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; }
            .stat-inner { display: flex; flex-direction: column; gap: 32px; max-width: 1640px; }
            .stat-number {
              font-family: ${palette.titleFont};
              font-size: ${numberSize}px; font-weight: 900; line-height: 0.9;
              letter-spacing: -0.06em;
              color: ${palette.accent};
            }
            .stat-label {
              font-family: ${palette.titleFont};
              font-size: ${labelSize}px; font-weight: 800; letter-spacing: 0.06em;
              text-transform: uppercase;
              color: ${palette.titleColor};
            }
            .stat-desc {
              font-family: ${palette.bodyFont};
              font-size: ${descSize}px; font-weight: 500; line-height: 1.45;
              color: ${palette.bodyColor};
              max-width: 1200px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // feature-grid: 2×2 特性矩阵（每格图标 + 标题 + 正文）
      // items 字段格式：每行一个 cell，"icon|heading|body" 用竖线分隔；最多 4 行
      // 例：
      //   "lightbulb|创意驱动|从用户痛点出发\nzap|快速执行|两周内交付 MVP\nshield|稳定保障|99.9% SLA\nusers|团队协作|跨职能共建"
      // ============================================================
      "feature-grid": {
        fields: ["title", "items", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 4).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { icon: parts[0] || "sparkles", head: parts[1] || "", body: parts[2] || "" };
          });
          const grid = items.map((it) => `
            <div class="fg-cell">
              <div class="fg-icon">${icon(it.icon, 64, palette.accent)}</div>
              <div class="fg-head">${escapeHtml(it.head)}</div>
              <div class="fg-body">${escapeHtml(it.body)}</div>
            </div>
          `).join("");
          const body = `
            <div class="fg-title">${title}</div>
            <div class="fg-grid">${grid}</div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 64px; padding-top: 120px; padding-bottom: 120px; }
            .fg-title {
              font-family: ${palette.titleFont};
              font-size: 72px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .fg-grid {
              flex: 1;
              display: grid;
              grid-template-columns: 1fr 1fr;
              grid-template-rows: 1fr 1fr;
              gap: 44px;
            }
            .fg-cell {
              display: flex; flex-direction: column; gap: 20px;
              padding: 40px 44px;
              background: ${palette.surface};
              border-left: 5px solid ${palette.accent};
              /* 有边框线（border-left）就不加 border-radius —— 圆角会把 accent 色条上下截掉 */
            }
            .fg-head {
              font-family: ${palette.titleFont};
              font-size: 40px; font-weight: 800; line-height: 1.15;
              color: ${palette.titleColor};
            }
            .fg-body {
              font-family: ${palette.bodyFont};
              font-size: 30px; font-weight: 500; line-height: 1.55;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // quote: 大引号 + 引文 + 署名 + 角色
      // ============================================================
      quote: {
        fields: ["quote", "author", "role", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const quoteText = multilineHtml(data.quote || "");
          const author = escapeHtml(data.author || "");
          const role = escapeHtml(data.role || "");
          // 金句字号 → 88px = 44pt，匹配 modern pitch deck 的"金句要有压迫感"标准
          // 引号 → 360px，更大开口、更杂志感
          const body = `
            <div class="q-mark">&ldquo;</div>
            <div class="q-text">${quoteText}</div>
            ${author ? `<div class="q-author"><div class="q-author-bar"></div><div class="q-author-text"><div class="q-author-name">${author}</div>${role ? `<div class="q-author-role">${role}</div>` : ""}</div></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; gap: 32px; padding-left: 200px; padding-right: 200px; }
            .q-mark {
              font-family: ${palette.titleFont};
              font-size: 360px; line-height: 0.55;
              color: ${palette.accent};
            }
            .q-text {
              font-family: ${palette.bodyFont};
              font-size: 88px; font-weight: 500; line-height: 1.22;
              letter-spacing: -0.015em;
              font-style: italic;
              color: ${palette.titleColor};
              max-width: 1500px;
            }
            .q-author {
              display: flex; gap: 28px; align-items: center;
              margin-top: 40px;
            }
            .q-author-bar { width: 72px; height: 4px; background: ${palette.accent}; flex: none; }
            .q-author-name {
              font-family: ${palette.titleFont};
              font-size: 32px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
              color: ${palette.titleColor};
            }
            .q-author-role {
              font-family: ${palette.bodyFont};
              font-size: 26px;
              color: ${palette.bodyColor};
              margin-top: 6px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // comparison: 左右双栏对比（每栏图标 + 标签 + 多行）
      // 左侧 muted（淡色背景，常表示"过去/反例"），右侧 accent（突出，常表示"现在/正例"）
      // ============================================================
      comparison: {
        fields: ["title", "leftIcon", "leftLabel", "leftBody", "rightIcon", "rightLabel", "rightBody", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const leftIcon = String(data.leftIcon || "x-circle").trim();
          const leftLabel = escapeHtml(data.leftLabel || "");
          const leftLines = String(data.leftBody || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
          const leftItems = leftLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
          const rightIcon = String(data.rightIcon || "check-circle").trim();
          const rightLabel = escapeHtml(data.rightLabel || "");
          const rightLines = String(data.rightBody || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
          const rightItems = rightLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
          const body = `
            ${title ? `<div class="cmp-title">${title}</div>` : ""}
            <div class="cmp-grid">
              <div class="cmp-cell cmp-left">
                <div class="cmp-icon">${icon(leftIcon, 72, palette.bodyColor)}</div>
                <div class="cmp-label">${leftLabel}</div>
                <ul class="cmp-list">${leftItems}</ul>
              </div>
              <div class="cmp-cell cmp-right">
                <div class="cmp-icon" style="color:${palette.accent}">${icon(rightIcon, 72, palette.accent)}</div>
                <div class="cmp-label">${rightLabel}</div>
                <ul class="cmp-list">${rightItems}</ul>
              </div>
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 56px; padding-top: 100px; padding-bottom: 100px; }
            .cmp-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              text-align: center;
            }
            .cmp-grid {
              flex: 1;
              display: grid; grid-template-columns: 1fr 1fr;
              gap: 44px;
            }
            .cmp-cell {
              display: flex; flex-direction: column; gap: 24px;
              padding: 48px 52px;
              /* 不加 border-radius —— 右侧卡有 3px accent 全边框，圆角会让 4 条边都弯，
                 PPT 印出来看着不利落。直角边框 + 直角卡更干净。 */
            }
            .cmp-left { background: ${palette.surface}; opacity: 0.65; }
            .cmp-right { background: ${palette.surface}; border: 4px solid ${palette.accent}; }
            .cmp-label {
              font-family: ${palette.titleFont};
              font-size: 44px; font-weight: 800; line-height: 1.1;
              color: ${palette.titleColor};
            }
            .cmp-list {
              list-style: none; padding: 0; margin: 0;
              font-family: ${palette.bodyFont};
              font-size: 30px; line-height: 1.55;
              color: ${palette.bodyColor};
            }
            .cmp-list li {
              padding: 8px 0 8px 28px; position: relative;
            }
            .cmp-list li::before {
              content: "·"; position: absolute; left: 4px; top: 6px;
              font-size: 36px;
              font-weight: 900; color: ${palette.accent}; line-height: 1;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // metric-trio: 三联指标（图标 + 大数字 + 标签 + 可选描述）
      // items 格式：每行一个 cell，"icon|number|label|desc" 用竖线分隔；最多 3 行
      // 例：
      //   "trending-up|+247%|增长率|相较上季度\nusers|12.4M|月活|稳定增长\nactivity|99.9%|可用性|过去 30 天"
      // ============================================================
      "metric-trio": {
        fields: ["title", "items", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return {
              icon: parts[0] || "trending-up",
              number: parts[1] || "",
              label: parts[2] || "",
              desc: parts[3] || ""
            };
          });
          const cells = items.map((it) => `
            <div class="mt-cell">
              <div class="mt-icon">${icon(it.icon, 60, palette.accent)}</div>
              <div class="mt-num">${escapeHtml(it.number)}</div>
              <div class="mt-label">${escapeHtml(it.label)}</div>
              ${it.desc ? `<div class="mt-desc">${escapeHtml(it.desc)}</div>` : ""}
            </div>
          `).join("");
          const cols = Math.max(1, items.length || 3);
          const body = `
            ${title ? `<div class="mt-title">${title}</div>` : ""}
            <div class="mt-grid">${cells}</div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 72px; padding-top: 120px; padding-bottom: 120px; justify-content: center; }
            .mt-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .mt-grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 60px; }
            .mt-cell {
              display: flex; flex-direction: column; gap: 14px;
              padding: 32px 32px 28px;
              border-top: 5px solid ${palette.accent};
            }
            .mt-num {
              font-family: ${palette.titleFont};
              font-size: 200px; font-weight: 900; line-height: 0.88; letter-spacing: -0.045em;
              color: ${palette.titleColor};
            }
            .mt-label {
              font-family: ${palette.titleFont};
              font-size: 36px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
              color: ${palette.titleColor};
              margin-top: 8px;
            }
            .mt-desc {
              font-family: ${palette.bodyFont};
              font-size: 28px; line-height: 1.45;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // timeline: 横向时间轴 —— 一条线 + 3-6 个里程碑节点
      // items 字段格式：每行一个节点 "date|title|description"，最多 6 行
      // 例：
      //   "2024 Q1|项目立项|需求调研 + 原型设计\n2024 Q2|内测发布|首批 100 客户试用\n2024 Q3|正式上线|GA 全网开放"
      // ============================================================
      timeline: {
        fields: ["title", "items", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 6).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { date: parts[0] || "", head: parts[1] || "", body: parts[2] || "" };
          });
          const nodes = items.map((it, i) => `
            <div class="tl-node">
              <div class="tl-dot">${i + 1}</div>
              <div class="tl-date">${escapeHtml(it.date)}</div>
              <div class="tl-head">${escapeHtml(it.head)}</div>
              <div class="tl-body">${escapeHtml(it.body)}</div>
            </div>
          `).join("");
          const body = `
            ${title ? `<div class="tl-title">${title}</div>` : ""}
            <div class="tl-track">
              <div class="tl-line"></div>
              <div class="tl-nodes">${nodes}</div>
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 96px; padding-top: 140px; padding-bottom: 140px; justify-content: center; }
            .tl-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .tl-track { position: relative; padding: 44px 0 0 0; }
            .tl-line {
              position: absolute; top: 82px; left: 40px; right: 40px; height: 4px;
              background: ${palette.accent}; opacity: 0.4;
            }
            .tl-nodes { display: grid; grid-template-columns: repeat(${Math.max(1, items.length)}, 1fr); gap: 36px; position: relative; }
            .tl-node { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
            .tl-dot {
              width: 80px; height: 80px; border-radius: 50%;
              background: ${palette.accent}; color: ${palette.bg};
              font-family: ${palette.titleFont};
              font-size: 34px; font-weight: 900;
              display: flex; align-items: center; justify-content: center;
              border: 6px solid ${palette.bg};
              box-shadow: 0 0 0 4px ${palette.accent};
            }
            .tl-date {
              font-family: ${palette.titleFont};
              font-size: 26px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
              color: ${palette.accent}; margin-top: 12px;
            }
            .tl-head {
              font-family: ${palette.titleFont};
              font-size: 36px; font-weight: 800; line-height: 1.2;
              color: ${palette.titleColor};
            }
            .tl-body {
              font-family: ${palette.bodyFont};
              font-size: 28px; font-weight: 500; line-height: 1.5;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // agenda: 议程 / 章节目录 —— 大字号 1-7 编号 + 条目名
      // 适合开场页（"今日议程"）/ 章节总览 / TOC。
      // items 字段：每行一条 "标签|条目名"（标签可缺），最多 7 行
      // 例：
      //   "01|背景与挑战\n02|解决方案\n03|案例落地\n04|后续规划"
      // ============================================================
      agenda: {
        fields: ["title", "items", "footer", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "议程");
          const footer = escapeHtml(data.footer || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 7).map((line, i) => {
            const parts = line.split("|").map((s) => s.trim());
            if (parts.length === 1) return { tag: String(i + 1).padStart(2, "0"), name: parts[0] };
            return { tag: parts[0], name: parts.slice(1).join(" | ") };
          });
          const rows = items.map((it) => `
            <div class="ag-row">
              <span class="ag-tag">${escapeHtml(it.tag)}</span>
              <span class="ag-rule"></span>
              <span class="ag-name">${escapeHtml(it.name)}</span>
            </div>
          `).join("");
          const body = `
            <div class="ag-head">
              <div class="accent-bar" style="position:relative;left:0;margin-bottom:28px"></div>
              <div class="ag-title">${title}</div>
            </div>
            <div class="ag-list">${rows}</div>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 64px; padding-top: 140px; padding-bottom: 140px; }
            .ag-title {
              font-family: ${palette.titleFont};
              font-size: 104px; font-weight: 900; line-height: 1; letter-spacing: -0.025em;
              color: ${palette.titleColor};
            }
            .ag-list { display: flex; flex-direction: column; gap: 14px; max-width: 1640px; flex: 1; justify-content: center; }
            .ag-row {
              display: grid; grid-template-columns: 140px 1fr auto;
              gap: 36px; align-items: center;
              padding: 18px 0;
              border-bottom: 1px solid ${palette.surface};
            }
            .ag-tag {
              font-family: ${palette.titleFont};
              font-size: 52px; font-weight: 900; letter-spacing: -0.02em;
              color: ${palette.accent};
            }
            /* 编辑感 TOC 经典的"dotted leader" —— 点状横线代替整段实线，比单纯 background 多一份杂志气。
               实现注意：用 background-image radial-gradient 而**不是** border-bottom:dotted。
               html2canvas（插入用的截图库）对 CSS dashed/dotted 边框渲染不可靠，
               预览里能看到但截图插入到 PPT 后会丢失。background-image 的点阵 html2canvas 支持稳定。 */
            .ag-rule {
              height: 4px;
              background-image: radial-gradient(circle, ${palette.bodyColor} 1.4px, transparent 1.8px);
              background-size: 14px 4px;
              background-repeat: repeat-x;
              background-position: center;
              opacity: 0.45;
            }
            .ag-name {
              font-family: ${palette.titleFont};
              font-size: 48px; font-weight: 700; line-height: 1.2;
              color: ${palette.titleColor};
              text-align: right;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // two-column: 双栏文字（左标题/导语 + 右多段正文，或左右等权两栏）
      // 用于"上下文 + 详细说明"类场景。
      // ============================================================
      "two-column": {
        fields: ["title", "leftHead", "leftBody", "rightHead", "rightBody", "tag", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const tag = escapeHtml(data.tag || "");
          const leftHead = escapeHtml(data.leftHead || "");
          const leftBody = multilineHtml(data.leftBody || "");
          const rightHead = escapeHtml(data.rightHead || "");
          const rightBody = multilineHtml(data.rightBody || "");
          const body = `
            ${tag ? `<div class="grid-tag">${tag}</div>` : ""}
            ${title ? `<div class="tc-title">${title}</div>` : ""}
            <div class="tc-grid">
              <div class="tc-col tc-left">
                ${leftHead ? `<div class="tc-head">${leftHead}</div>` : ""}
                <div class="tc-body">${leftBody}</div>
              </div>
              <div class="tc-col tc-right">
                ${rightHead ? `<div class="tc-head">${rightHead}</div>` : ""}
                <div class="tc-body">${rightBody}</div>
              </div>
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 64px; padding-top: 160px; padding-bottom: 120px; }
            .tc-title {
              font-family: ${palette.titleFont};
              font-size: 80px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.015em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .tc-grid {
              flex: 1;
              display: grid; grid-template-columns: 1fr 1fr;
              gap: 88px;
            }
            .tc-col {
              padding-left: 32px;
              border-left: 5px solid ${palette.accent};
              display: flex; flex-direction: column; gap: 20px;
            }
            .tc-head {
              font-family: ${palette.titleFont};
              font-size: 40px; font-weight: 800; line-height: 1.15;
              color: ${palette.titleColor};
            }
            .tc-body {
              font-family: ${palette.bodyFont};
              font-size: 32px; font-weight: 500; line-height: 1.6;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // image-text: 左大图 + 右文字 (或 imagePosition=right 翻转)
      // imageUrl 可以是 https URL（remote 会被预处理成 dataUrl），也可以是 dataUrl。
      // 没有 imageUrl 时左边显示一个 placeholder color block + icon。
      // ============================================================
      "image-text": {
        fields: ["title", "body", "imageUrl", "imagePosition", "tag", "icon", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const body = multilineHtml(data.body || "");
          const tag = escapeHtml(data.tag || "");
          const imageUrl = String(data.imageUrl || "").trim();
          const placeholderIcon = String(data.icon || "image").trim();
          const right = String(data.imagePosition || "left").toLowerCase() === "right";

          // 没图就显示一个块 + 图标，避免空白
          const imageHtml = imageUrl
            ? `<div class="it-image" style="background-image:url('${escapeHtml(imageUrl)}')"></div>`
            : `<div class="it-image it-placeholder">${icon(placeholderIcon === "image" ? "sparkles" : placeholderIcon, 120, palette.accent)}</div>`;

          const textHtml = `
            <div class="it-text">
              ${tag ? `<div class="it-tag">${tag}</div>` : ""}
              ${title ? `<div class="it-title">${title}</div>` : ""}
              ${body ? `<div class="it-body">${body}</div>` : ""}
            </div>
          `;

          const grid = right
            ? `<div class="it-grid it-right">${textHtml}${imageHtml}</div>${pageIndicatorHtml(data)}`
            : `<div class="it-grid">${imageHtml}${textHtml}</div>${pageIndicatorHtml(data)}`;

          // 黄金比 62 : 38（含图侧 62%，文字侧 38%）—— 鲁尔比例让画面更悦目
          const css = `
            .stage { display: flex; flex-direction: column; padding: 0; }
            .it-grid {
              flex: 1;
              display: grid; grid-template-columns: 62fr 38fr;
              gap: 0;
              width: 100%; height: 100%;
            }
            .it-grid.it-right { grid-template-columns: 38fr 62fr; }
            .it-image {
              background-size: cover; background-position: center;
              background-color: ${palette.surface};
            }
            .it-placeholder {
              display: flex; align-items: center; justify-content: center;
              background: ${palette.surface};
            }
            .it-text {
              padding: 160px 120px;
              display: flex; flex-direction: column; gap: 32px;
              justify-content: center;
              background: ${palette.bg};
            }
            .it-tag {
              font-family: ${palette.titleFont};
              font-size: 24px; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase;
              color: ${palette.accent};
            }
            .it-title {
              font-family: ${palette.titleFont};
              font-size: 84px; font-weight: 900; line-height: 1.05; letter-spacing: -0.02em;
              color: ${palette.titleColor};
            }
            .it-body {
              font-family: ${palette.bodyFont};
              font-size: 32px; font-weight: 500; line-height: 1.6;
              color: ${palette.bodyColor};
            }
            /* image-text 是分屏布局，page-indicator 默认 right:140 会被吃掉，单独覆盖到右下 */
            .page-indicator { right: 60px; bottom: 40px; }
          `;
          return doc(palette, grid, css);
        }
      },

      // ============================================================
      // process: 横向流程 —— 3-5 个步骤盒子 + 箭头
      // steps 字段：每行 "icon|title|description"，最多 5 步
      // 例：
      //   "search|调研|访谈 + 数据分析\nedit|设计|原型 + 评审\nrocket|发布|灰度 + 全量"
      // ============================================================
      process: {
        fields: ["title", "steps", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const steps = String(data.steps || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { icon: parts[0] || "arrow-right", head: parts[1] || "", body: parts[2] || "" };
          });
          // 步骤盒之间插箭头节点（最后一个步骤后面不加箭头）
          const cells = steps.map((s, i) => `
            <div class="pr-step">
              <div class="pr-num">${String(i + 1).padStart(2, "0")}</div>
              <div class="pr-icon">${icon(s.icon, 48, palette.accent)}</div>
              <div class="pr-head">${escapeHtml(s.head)}</div>
              <div class="pr-body">${escapeHtml(s.body)}</div>
            </div>
            ${i < steps.length - 1 ? `<div class="pr-arrow">${icon("arrow-right", 44, palette.accent)}</div>` : ""}
          `).join("");
          // 多列 grid：N 个 step + (N-1) 个箭头
          const gridTemplate = steps.map(() => "1fr").join(" auto ");
          const body = `
            ${title ? `<div class="pr-title">${title}</div>` : ""}
            <div class="pr-row" style="grid-template-columns:${gridTemplate}">${cells}</div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 96px; justify-content: center; padding-top: 140px; padding-bottom: 140px; }
            .pr-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .pr-row { display: grid; gap: 28px; align-items: stretch; }
            .pr-step {
              display: flex; flex-direction: column; gap: 14px;
              padding: 40px 36px;
              background: ${palette.surface};
              border-radius: 16px;
              position: relative;
            }
            .pr-num {
              position: absolute; top: 20px; right: 24px;
              font-family: ${palette.titleFont};
              font-size: 32px; font-weight: 900; letter-spacing: 0.04em;
              color: ${palette.accent}; opacity: 0.5;
            }
            .pr-icon { margin-bottom: 10px; }
            .pr-head {
              font-family: ${palette.titleFont};
              font-size: 36px; font-weight: 800; line-height: 1.2;
              color: ${palette.titleColor};
            }
            .pr-body {
              font-family: ${palette.bodyFont};
              font-size: 26px; font-weight: 500; line-height: 1.55;
              color: ${palette.bodyColor};
            }
            .pr-arrow { display: flex; align-items: center; justify-content: center; }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // table: 简单数据表（首行表头加粗、强调色横线，行间分隔线）
      // headers: 用 "|" 分隔列名；rows: 每行一条记录，列用 "|" 分隔
      // 例：
      //   headers: "渠道|月用户|增长率|备注"
      //   rows:    "微信|3.2M|+12%|稳定主力\n抖音|1.8M|+85%|流量黑马\n小红书|0.6M|+45%|新阵地"
      // ============================================================
      table: {
        fields: ["title", "headers", "rows", "footer", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const footer = escapeHtml(data.footer || "");
          const headers = String(data.headers || "").split("|").map((s) => s.trim()).filter(Boolean);
          const rows = String(data.rows || "")
            .split(/\n+/).map((l) => l.trim()).filter(Boolean)
            .slice(0, 8)  // 最多 8 行（8 行 + 表头超出就溢出了）
            .map((line) => line.split("|").map((s) => s.trim()));
          const thead = headers.length ? `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` : "";
          const tbody = `<tbody>${rows.map((cells) =>
            `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`
          ).join("")}</tbody>`;
          const body = `
            ${title ? `<div class="tb-title">${title}</div>` : ""}
            <div class="tb-wrap"><table class="tb">${thead}${tbody}</table></div>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 56px; padding-top: 140px; padding-bottom: 120px; }
            .tb-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .tb-wrap { flex: 1; display: flex; align-items: flex-start; }
            .tb {
              width: 100%;
              border-collapse: collapse;
              font-family: ${palette.bodyFont};
            }
            .tb th, .tb td {
              padding: 26px 32px;
              text-align: left;
              font-size: 32px;
            }
            .tb thead th {
              font-family: ${palette.titleFont};
              font-size: 28px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
              color: ${palette.titleColor};
              border-bottom: 5px solid ${palette.accent};
            }
            .tb tbody tr {
              border-bottom: 1px solid ${palette.surface};
            }
            .tb tbody tr:nth-child(even) { background: ${palette.surface}; opacity: 0.95; }
            .tb tbody td {
              color: ${palette.bodyColor};
              font-weight: 500;
            }
            .tb tbody td:first-child {
              font-family: ${palette.titleFont};
              font-weight: 700;
              color: ${palette.titleColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // bento: Bento 不对称网格 —— 1 个 hero 大格 + 3 个小格 (2×3 grid: hero 占左 2 行)
      // hero 字段：heroIcon / heroTitle / heroBody
      // items: 每行 "icon|head|body"，3 条小格
      // 例：
      //   heroIcon: rocket, heroTitle: "三周上线", heroBody: "从 idea 到 GA 三周搞定"
      //   items: "users|跨职能团队|3 人前端 + 2 后端 + 1 设计\nshield|稳定可靠|99.9% SLA / 0 dataloss\ntarget|目标驱动|每周 KR 周会"
      // ============================================================
      bento: {
        fields: ["title", "heroIcon", "heroTitle", "heroBody", "items", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const heroIcon = String(data.heroIcon || "sparkles").trim();
          const heroTitle = escapeHtml(data.heroTitle || "");
          const heroBody = multilineHtml(data.heroBody || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { icon: parts[0] || "sparkles", head: parts[1] || "", body: parts[2] || "" };
          });
          const smalls = items.map((it) => `
            <div class="bn-cell bn-small">
              <div class="bn-icon">${icon(it.icon, 40, palette.accent)}</div>
              <div class="bn-head">${escapeHtml(it.head)}</div>
              <div class="bn-body">${escapeHtml(it.body)}</div>
            </div>
          `).join("");
          const body = `
            ${title ? `<div class="bn-title">${title}</div>` : ""}
            <div class="bn-grid">
              <div class="bn-cell bn-hero">
                <div class="bn-hero-icon">${icon(heroIcon, 104, palette.bg)}</div>
                <div class="bn-hero-title">${heroTitle}</div>
                <div class="bn-hero-body">${heroBody}</div>
              </div>
              ${smalls}
            </div>
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 56px; padding-top: 120px; padding-bottom: 120px; }
            .bn-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800; line-height: 1.05;
              letter-spacing: -0.01em;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .bn-grid {
              flex: 1;
              display: grid;
              grid-template-columns: 1.62fr 1fr;
              grid-template-rows: 1fr 1fr 1fr;
              gap: 28px;
            }
            .bn-cell {
              padding: 40px 44px;
              border-radius: 18px;
              display: flex; flex-direction: column;
            }
            .bn-hero {
              grid-row: 1 / span 3;
              background: ${palette.accent};
              color: ${palette.bg};
              justify-content: flex-end;
              gap: 20px;
            }
            .bn-hero-icon { margin-bottom: auto; }
            .bn-hero-title {
              font-family: ${palette.titleFont};
              font-size: 80px; font-weight: 900; line-height: 1.04; letter-spacing: -0.025em;
              color: ${palette.bg};
            }
            .bn-hero-body {
              font-family: ${palette.bodyFont};
              font-size: 32px; line-height: 1.5; font-weight: 500;
              color: ${palette.bg}; opacity: 0.92;
            }
            .bn-small {
              background: ${palette.surface};
              gap: 10px;
              justify-content: center;
            }
            .bn-icon { margin-bottom: 8px; }
            .bn-head {
              font-family: ${palette.titleFont};
              font-size: 34px; font-weight: 800; line-height: 1.15;
              color: ${palette.titleColor};
            }
            .bn-body {
              font-family: ${palette.bodyFont};
              font-size: 26px; font-weight: 500; line-height: 1.5;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // closer: 收尾页 —— 大字"谢谢/Thank You/Q&A" + 联系信息
      // 用于演讲最后一页。
      // contacts: 多行 "标签|值"，例 "邮箱|hello@example.com\n微信|abc123"
      // ============================================================
      closer: {
        fields: ["mainText", "subText", "contacts", "footer", "pageIndex", "brand"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const main = multilineHtml(data.mainText || "Thank You");
          const sub = escapeHtml(data.subText || "");
          const footer = escapeHtml(data.footer || "");
          const contacts = String(data.contacts || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 4).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { label: parts[0] || "", value: parts.slice(1).join(" | ") || "" };
          });
          const contactsHtml = contacts.length ? `
            <div class="cl-contacts">
              ${contacts.map((c) => `
                <div class="cl-contact">
                  <span class="cl-contact-label">${escapeHtml(c.label)}</span>
                  <span class="cl-contact-value">${escapeHtml(c.value)}</span>
                </div>
              `).join("")}
            </div>
          ` : "";
          const body = `
            <div class="cl-wrap">
              <div class="accent-bar" style="position:relative;left:0;margin:0 auto 40px"></div>
              <div class="cl-main">${main}</div>
              ${sub ? `<div class="cl-sub">${sub}</div>` : ""}
              ${contactsHtml}
            </div>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>FIN</span></div>` : ""}
            ${pageIndicatorHtml(data)}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 100px 100px; }
            .cl-wrap { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 24px; max-width: 1500px; }
            .cl-main {
              font-family: ${palette.titleFont};
              font-size: 200px; font-weight: 900; line-height: 1; letter-spacing: -0.04em;
              color: ${palette.titleColor};
            }
            .cl-sub {
              font-family: ${palette.titleFont};
              font-size: 40px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
              color: ${palette.accent};
              margin-top: 12px;
            }
            .cl-contacts {
              margin-top: 64px;
              display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              gap: 32px;
              width: 100%; max-width: 1200px;
            }
            .cl-contact {
              display: flex; flex-direction: column; gap: 6px;
              padding: 20px 24px;
              background: ${palette.surface};
              border-top: 4px solid ${palette.accent};
              /* 有 border-top 就不加 border-radius —— 圆角会把 accent 色条左右两端截掉 */
            }
            .cl-contact-label {
              font-family: ${palette.titleFont};
              font-size: 18px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
              color: ${palette.accent};
            }
            .cl-contact-value {
              font-family: ${palette.bodyFont};
              font-size: 32px; font-weight: 600;
              color: ${palette.titleColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // freeform: 自由排版 —— AI 直接写完整的 body HTML 和自定义 CSS。
      // 适合"现有 8 个 layout 表达不了的丰富设计"，例如:
      //   - 指标卡网格 (像 iPark 那种 6 卡 metric-grid)
      //   - 完成清单 + 状态徽章 (name / desc / status pill)
      //   - 表格 + 优势卡组合 (左 table + 右多卡)
      //   - Gantt / 里程碑时间轴 / 风险矩阵 / 团队结构图 等
      //
      // 渲染规则：
      //   - data.html: 必填，直接作为 body 内容（**不会**被包进 .stage 容器，AI 自己定布局）
      //   - data.css:  可选，作为额外样式注入（追加在默认样式后）
      //   - 可用 CSS 变量：--bg / --surface / --primary / --accent /
      //     --title-color / --body-color / --title-font / --body-font
      //   - stage 已是 1920×1080，AI 写绝对定位或 flex/grid 均可，记得元素超出 1920×1080 会被裁掉
      //   - 不需要写 <html>/<head>/<body>，只给 body 内容
      // ============================================================
      freeform: {
        fields: ["html", "css"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          // 注意：freeform 的 html 是用户/AI 提供的，**不做 escape**（这就是自由的代价）。
          // 上下游链路里这段 HTML 只被塞进 iframe srcdoc 渲染成截图，不直写到主文档，
          // 没有 XSS / RCE 风险面。
          const customHtml = String(data.html || "");
          const customCss = String(data.css || "");
          // 把 .stage 内边距压成 0，让 freeform 自己掌控整个 1920×1080 画布。
          // 默认字号映射 PPT 标准磅值：1920×1080 = 13.333"，144 DPI → **1pt = 2px**。
          //   PPT 风格         | pt  | px (默认)
          //   ---              | --- | ---
          //   Title (h1)       | 54  | 108
          //   Section (h2)     | 40  | 80
          //   Heading (h3)     | 28  | 56
          //   Subheading (h4)  | 22  | 44
          //   Body (p/li/td)   | 18  | 36
          //   Caption (small)  | 14  | 28
          //   Min readable     | 12  | 24
          // AI 写的 CSS 会覆盖这些保底；这些只是"AI 没显式写 font-size 时也不会出现网页尺寸的小字"。
          const css = `
            .stage { padding: 0; font-size: 36px; line-height: 1.5; }
            .stage h1 { font-size: 108px; line-height: 1.1; font-weight: 800; }
            .stage h2 { font-size: 80px; line-height: 1.15; font-weight: 800; }
            .stage h3 { font-size: 56px; line-height: 1.2; font-weight: 700; }
            .stage h4 { font-size: 44px; line-height: 1.25; font-weight: 700; }
            .stage p,
            .stage li,
            .stage td,
            .stage th { font-size: 36px; line-height: 1.5; }
            .stage small,
            .stage .small,
            .stage figcaption { font-size: 28px; line-height: 1.4; }
            ${customCss}
          `;
          return doc(palette, customHtml, css);
        }
      }
    }
  };

  global.WpsAiHtmlTemplates = global.WpsAiHtmlTemplates || { _registry: {} };
  global.WpsAiHtmlTemplates._registry[TEMPLATE.slug] = TEMPLATE;
})(window);
