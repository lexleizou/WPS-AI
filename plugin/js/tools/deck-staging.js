(function attachDeckStaging(global) {
  "use strict";

  // 分步生成 PPT 的纯函数工具：HTML 图片槽位解析/占位/回填 + 并发限制 + 每页就绪追踪。
  // 全部字符串/正则实现，不依赖 DOMParser/btoa，便于脱离浏览器单测。

  const IMG_TAG_RE = /<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;

  function eachImgTag(html, fn) {
    return String(html || "").replace(IMG_TAG_RE, (tag) => {
      const r = fn(tag);
      return (r == null) ? tag : r;
    });
  }

  function getAttr(tag, name) {
    let m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i"));
    if (m) return m[1];
    m = tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", "i"));
    return m ? m[1] : null;
  }

  function setAttr(tag, name, value) {
    const esc = String(value).replace(/"/g, "&quot;");
    const re = new RegExp("(" + name + "\\s*=\\s*)(\"[^\"]*\"|'[^']*')", "i");
    if (re.test(tag)) return tag.replace(re, '$1"' + esc + '"');
    return tag.replace(/^<img\b/i, '<img ' + name + '="' + esc + '"');
  }

  function collectImageRequests(html) {
    const requests = [];
    let n = 0;
    const out = eachImgTag(html, (tag) => {
      const prompt = getAttr(tag, "data-gen-prompt");
      if (!prompt) return tag; // 普通 img 不进入分步流程
      let id = getAttr(tag, "data-gen-id");
      let t = tag;
      if (!id) { id = "g" + n; t = setAttr(t, "data-gen-id", id); }
      n += 1;
      requests.push({
        id,
        prompt,
        size: getAttr(tag, "data-gen-size") || undefined,
        resolution: getAttr(tag, "data-gen-resolution") || undefined
      });
      return t;
    });
    return { html: out, requests };
  }

  function buildPlaceholderDataUrl(palette, caption) {
    const p = palette || {};
    const bg = p.surfaceColor || "#F4F4F5";
    const fg = p.bodyColor || "#9AA0A6";
    const text = String(caption || "AI 配图生成中…");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">' +
      '<rect width="800" height="450" fill="' + bg + '"/>' +
      '<g fill="none" stroke="' + fg + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="330" y="175" width="140" height="110" rx="10"/>' +
      '<circle cx="368" cy="212" r="14"/>' +
      '<path d="M330 265 L385 220 L420 250 L450 225 L470 245"/>' +
      '</g>' +
      '<text x="400" y="330" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="26" fill="' + fg + '">' +
      text + '</text></svg>';
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function applyPlaceholders(html, requests, palette) {
    const ids = new Set((requests || []).map((r) => r.id));
    const ph = buildPlaceholderDataUrl(palette || {}, "AI 配图生成中…");
    return eachImgTag(html, (tag) => {
      const id = getAttr(tag, "data-gen-id");
      if (!id || !ids.has(id)) return tag;
      return setAttr(tag, "src", ph);
    });
  }

  function fillImages(html, urlById) {
    const map = urlById || {};
    return eachImgTag(html, (tag) => {
      const id = getAttr(tag, "data-gen-id");
      if (!id || !map[id]) return tag; // 无 URL 的保留原样（占位）
      return setAttr(tag, "src", map[id]);
    });
  }

  function makeLimiter(concurrency) {
    const max = Math.max(1, Number(concurrency) || 1);
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < max && queue.length) {
        const job = queue.shift();
        active += 1;
        Promise.resolve().then(job.thunk).then(
          (v) => { active -= 1; job.resolve(v); pump(); },
          (e) => { active -= 1; job.reject(e); pump(); }
        );
      }
    };
    return function run(thunk) {
      return new Promise((resolve, reject) => {
        queue.push({ thunk, resolve, reject });
        pump();
      });
    };
  }

  function makeImageTracker(pages) {
    const remaining = new Map();
    const results = new Map();
    (pages || []).forEach((p) => {
      remaining.set(p.seq, new Set(p.ids || []));
      results.set(p.seq, {});
    });
    return {
      record(seq, id, url) {
        const rem = remaining.get(seq);
        if (!rem || !rem.has(id)) return null;
        rem.delete(id);
        results.get(seq)[id] = url || null;
        if (rem.size === 0) return { seq, urlById: results.get(seq) };
        return null;
      }
    };
  }

  // 阶段二编排器：对所有页的图片请求受限并发生成，每页图齐后回填 + replace。
  // 纯编排，COM 与生图都经 deps 注入，便于单测。
  async function runImageBackfill(opts) {
    const { pages, concurrency, deps } = opts || {};
    const list = Array.isArray(pages) ? pages : [];
    const run = makeLimiter(concurrency || 3);
    const tracker = makeImageTracker(list.map((p) => ({ seq: p.seq, ids: (p.requests || []).map((r) => r.id) })));
    const pageBySeq = new Map(list.map((p) => [p.seq, p]));
    let imagesOk = 0, imagesFailed = 0, pagesReplaced = 0, skipped = 0;

    const jobs = [];
    for (const page of list) {
      for (const req of (page.requests || [])) {
        jobs.push(run(async () => {
          let url = null;
          try { url = await deps.generateImage(req); } catch (e) { url = null; }
          if (url) imagesOk += 1; else imagesFailed += 1;
          const done = tracker.record(page.seq, req.id, url);
          if (!done) return;
          const p = pageBySeq.get(done.seq);
          const finalById = {};
          for (const id of Object.keys(done.urlById)) {
            finalById[id] = done.urlById[id] || buildPlaceholderDataUrl(p.palette, "配图未生成");
          }
          const filled = fillImages(p.html, finalById);
          try {
            await deps.renderReplace({
              seq: p.seq, cacheId: p.cacheId, templateName: p.templateName, layout: p.layout,
              html: filled, css: p.css, palette: p.palette
            });
            pagesReplaced += 1;
          } catch (e) {
            skipped += 1;
          }
          try { deps.reportProgress && deps.reportProgress({ pagesReplaced, imagesOk, imagesFailed }); } catch (e) {}
        }));
      }
    }
    await Promise.all(jobs);
    return { pagesReplaced, imagesOk, imagesFailed, skipped };
  }

  global.WpsAiDeckStaging = {
    collectImageRequests, applyPlaceholders, fillImages,
    buildPlaceholderDataUrl, makeLimiter, makeImageTracker, runImageBackfill
  };
})(window);
