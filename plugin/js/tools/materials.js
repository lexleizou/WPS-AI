(function attachMaterialsTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  // 纯过滤：project/kind/source 精确、tags 任一命中、query 子串命中 prompt/标签/标题/正文/项目。
  function filterMaterials(list, opts) {
    const o = opts || {};
    const q = String(o.query || "").trim().toLowerCase();
    const project = String(o.project || "").trim();
    const kind = String(o.kind || "").trim();
    const source = String(o.source || "").trim();
    const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];
    return (Array.isArray(list) ? list : []).filter((it) => {
      if (project && String(it.project || "") !== project) return false;
      if (kind && String(it.kind || "image") !== kind) return false;
      if (source && String(it.source || "") !== source) return false;
      if (tags.length) {
        const itags = (it.tags || []).map((t) => String(t).toLowerCase());
        if (!tags.some((t) => itags.includes(t))) return false;
      }
      if (q) {
        const hay = [it.prompt, it.revisedPrompt, it.title, it.text, (it.tags || []).join(" "), it.project]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // 纯排序（不改原数组）：recent 按 ts 降序；relevance/缺省保持原顺序（稳定）。
  function sortMaterials(list, sortBy) {
    const arr = Array.isArray(list) ? list.slice() : [];
    if (sortBy === "recent") {
      return arr
        .map((it, i) => [it, i])
        .sort((a, b) => {
          const d = (Number(b[0] && b[0].ts) || 0) - (Number(a[0] && a[0].ts) || 0);
          return d !== 0 ? d : a[1] - b[1]; // ts 相等时按原序稳定
        })
        .map((pair) => pair[0]);
    }
    return arr;
  }

  registry.registerTool({
    name: "query_materials",
    hosts: ["*"],
    description: [
      "检索素材库里已有的素材（图片/网页），按内容标签、项目、关键词、类型过滤。",
      "**做文档/PPT 需要配图或引用资料时，先调本工具**看有没有可复用素材，命中合适的就直接用它的 url（传给 wps_insert_image / wpp_add_picture，或写进 freeform HTML 的 src），避免重复生成。",
      "返回精简条目：{ id, url, kind, prompt, title, tags, project, source }。url 为空表示是本地导入的图（仅本地数据，无网络地址），此类请让用户从素材库手动插入。",
      "分页：limit + offset；返回 total（过滤后总数）与 nextOffset（还有更多时为下次 offset，否则 null）。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，匹配提示词/标签/标题/正文/项目" },
        tags: { type: "array", items: { type: "string" }, description: "内容标签，任一命中即可" },
        project: { type: "string", description: "项目名（精确匹配）" },
        kind: { type: "string", enum: ["image", "web"], description: "素材类型" },
        source: { type: "string", description: "来源精确过滤，如 generated / web-search / web-fetch" },
        sortBy: { type: "string", enum: ["recent", "relevance"], description: "recent=最近生成优先；默认按库内原顺序" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "最多返回条数，默认 20" },
        offset: { type: "integer", minimum: 0, description: "分页偏移，默认 0" }
      }
    },
    handler: async ({ query, tags, project, kind, source, sortBy, limit, offset } = {}) => {
      const lib = global.WpsAiMaterialLibrary;
      if (!lib) return { count: 0, total: 0, materials: [], truncated: false, nextOffset: null };
      const matched = sortMaterials(
        filterMaterials(lib.list(), { query, tags, project, kind, source }),
        sortBy
      );
      const win = windowList(matched, { offset: offset || 0, limit: limit || 20 });
      return {
        count: win.window.length,
        total: win.total,
        truncated: win.truncated,
        nextOffset: win.nextOffset,
        materials: win.window.map((e) => ({
          id: e.id,
          url: e.url || "", // 只回 http 地址；dataUrl（本地导入）不回，避免 base64 撑爆上下文
          kind: e.kind || "image",
          prompt: e.prompt || "",
          title: e.title || "",
          tags: e.tags || [],
          project: e.project || "",
          source: e.source || ""
        }))
      };
    }
  });

  // 分页窗口：优先用共享 read-utils，未加载时内联兜底（保证 handler 不因加载顺序崩）。
  function windowList(list, opts) {
    const ru = global.WpsAiReadUtils;
    if (ru && typeof ru.applyListWindow === "function") return ru.applyListWindow(list, opts);
    const arr = Array.isArray(list) ? list : [];
    const total = arr.length;
    let off = Math.max(0, Math.floor(Number(opts && opts.offset) || 0));
    if (off > total) off = total;
    const lim = Math.floor(Number(opts && opts.limit) || 0);
    if (!(lim > 0)) return { window: arr.slice(off), truncated: false, nextOffset: null, total };
    const end = off + lim;
    return { window: arr.slice(off, end), truncated: end < total, nextOffset: end < total ? end : null, total };
  }

  // 供单测
  global.WpsAiMaterialsToolInternals = { filterMaterials, sortMaterials };
})(window);
