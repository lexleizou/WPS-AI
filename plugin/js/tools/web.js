(function attachWebTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  function proxyUrl(p) {
    return global.WpsAiRuntime?.proxyUrl?.(p) || ("http://127.0.0.1:3890" + p);
  }

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `${url} ${resp.status}`);
    return data;
  }

  async function verifyRemoteImage(url) {
    const data = await postJson(proxyUrl("/fetch-remote-image"), { url });
    if (!data.dataUrl) throw new Error("/fetch-remote-image 未返回 dataUrl");
    return data;
  }

  registry.registerTool({
    name: "web_fetch",
    hosts: ["*"],
    description: [
      "抓取一个网页的正文文本，用于把网页数据作为写作 / PPT 的参考资料或素材。",
      "服务端静态抓取（不执行 JS，不支持纯前端渲染的页面）；已去脚本/样式。返回 { title, text, truncated, nextOffset }。",
      "长页面：正文从 offset 起取 maxLen 字符，truncated=true 时把返回的 nextOffset 作为下次 offset 续读。",
      "includeLinks=true 附带页面内链接列表 links[{url,text}]；includeMeta=true 附带 meta{description/author/published/siteName}。",
      "把 save 设为 true 可将结果作为「网页素材」存入素材库，之后可用 query_materials(kind:\"web\") 检索复用。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "http/https 网页地址" },
        maxLen: { type: "integer", description: "正文最大字符数，默认 8000" },
        offset: { type: "integer", minimum: 0, description: "正文起始字符偏移，用于续读，默认 0" },
        includeLinks: { type: "boolean", description: "是否附带页面内链接列表" },
        includeMeta: { type: "boolean", description: "是否附带页面元信息（描述/作者/发布时间/站点名）" },
        save: { type: "boolean", description: "true 时把结果作为 web 素材存入素材库" },
        tags: { type: "array", items: { type: "string" }, description: "存库时附加的内容标签" }
      }
    },
    handler: async ({ url, maxLen, offset, includeLinks, includeMeta, save, tags } = {}) => {
      const resp = await fetch(proxyUrl("/fetch-web"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxLen, offset, includeLinks, includeMeta })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || `抓取失败：${resp.status}`);
      let savedId = null;
      if (save) {
        try {
          const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
          try { await global.WpsAiProject?.ensure?.(); } catch (e) {}
          const entry = global.WpsAiMaterialLibrary?.add?.({
            url: data.finalUrl || url,
            kind: "web",
            source: "web-fetch",
            title: data.title || "",
            text: data.text || "",
            tags: Array.isArray(tags) ? tags : [],
            project: settings.currentProject || ""
          });
          savedId = entry?.id || null;
        } catch (e) { /* 存库失败不影响抓取结果返回 */ }
      }
      return {
        url: data.url,
        finalUrl: data.finalUrl,
        title: data.title || "",
        text: data.text || "",
        truncated: !!data.truncated,
        nextOffset: data.nextOffset != null ? data.nextOffset : null,
        links: Array.isArray(data.links) ? data.links : undefined,
        meta: data.meta || undefined,
        saved: !!savedId,
        savedId
      };
    }
  });

  registry.registerTool({
    name: "web_image_search",
    hosts: ["*"],
    description: [
      "联网搜索图片作为素材（best-effort，走非官方 keyless 图源，可能因对方变更而暂时失效）。",
      "返回候选图片列表 { url, thumbnail, title, source }。选中合适的后，用 wps_insert_image / wpp_add_picture 传其 url 插图，或写进 freeform HTML 的 src。",
      "如果用户指定某个网站或域名，必须把 site 填成该域名，返回结果会限制为该站点来源。",
      "把 save 设为 true 时，只会把能成功下载校验的图片以 source:\"web-search\" 存入素材库（打上 query 作标签），供 query_materials 复用。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "搜索关键词" },
        site: { type: "string", description: "可选。用户明确要求从某个网站抓取时填域名或 URL，例如 tencent.com / https://www.tencent.com/" },
        count: { type: "integer", minimum: 1, maximum: 30, description: "返回数量，默认 8" },
        save: { type: "boolean", description: "true 时把结果存入素材库" }
      }
    },
    handler: async ({ query, site, count, save } = {}) => {
      const q = String(query || "").trim();
      if (!q) throw new Error("query 必填");
      const siteFilter = String(site || "").trim();
      const n = Math.min(30, Math.max(1, Number(count) || 8));
      let searchUrl = proxyUrl("/image-search?q=" + encodeURIComponent(q) + "&n=" + n);
      if (siteFilter) searchUrl += "&site=" + encodeURIComponent(siteFilter);
      const resp = await fetch(searchUrl);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || `搜索失败：${resp.status}`);
      const results = Array.isArray(data.results) ? data.results : [];
      let savedCount = 0;
      let skippedCount = 0;
      if (save && results.length) {
        const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
        try { await global.WpsAiProject?.ensure?.(); } catch (e) {}
        for (const r of results) {
          if (!r.url) {
            skippedCount += 1;
            continue;
          }
          try {
            await verifyRemoteImage(r.url);
            const entry = global.WpsAiMaterialLibrary?.add?.({
              url: r.url, prompt: r.title || q, source: "web-search", sourceUrl: r.source || "",
              tags: [q], project: settings.currentProject || ""
            });
            if (entry) savedCount += 1;
          } catch (e) {
            skippedCount += 1;
          }
        }
      }
      return { count: results.length, results, saved: savedCount, skipped: skippedCount, source: data.source || "", site: data.site || "" };
    }
  });
})(window);
