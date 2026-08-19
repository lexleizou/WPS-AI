// 组件库：把生成过的 freeform 幻灯片里"可复用的视觉单元"按 name + html + css 存下来，
// 之后做新页时，用户可以挑几个组件让 AI 在新页里复用 —— 全册 PPT 视觉就更一致。
//
// 数据形状：
//   { id, ts, name, description, html, css, sourceSlideId?, thumbnail? }
//
// 用 localStorage 一份 JSON 存（lingxi_html_components_v1），FIFO 到 MAX_ENTRIES。
(function attachHtmlComponents(global) {
  "use strict";

  const KEY = "lingxi_html_components_v1";
  const MAX_ENTRIES = 200;

  function genId() {
    return "comp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function readAll() {
    try {
      const raw = global.WpsAiStore.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (e) {
      console.warn("[html-components] 读取缓存失败，已清空：", e?.message || e);
      try { global.WpsAiStore.removeItem(KEY); } catch (_) {}
      return [];
    }
  }

  function writeAll(entries) {
    try {
      const trimmed = entries.slice(-MAX_ENTRIES);
      global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
    } catch (e) {
      // 满了就瘦身到最近 50 条再写
      try {
        const trimmed = entries.slice(-50);
        global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
      } catch (e2) {
        console.error("[html-components] 写入失败：", e2?.message || e2);
      }
    }
  }

  function save(entry) {
    if (!entry?.name) throw new Error("save: name 必填");
    if (typeof entry.html !== "string") throw new Error("save: html 必填");
    const entries = readAll();
    // 修 #10: 满了不再静默 FIFO 淘汰老组件（用户辛苦攒的组件会突然消失）。
    // 直接抛错，让 UI 弹"组件库已满，请先删除一些"。
    if (entries.length >= MAX_ENTRIES) {
      const err = new Error(`组件库已满 (${entries.length}/${MAX_ENTRIES})，请先删除一些不再用的组件再存。`);
      err.code = "COMPONENT_STORE_FULL";
      throw err;
    }
    const saved = {
      id: genId(),
      ts: Date.now(),
      name: entry.name,
      description: entry.description || "",
      html: entry.html,
      css: entry.css || "",
      sourceSlideId: entry.sourceSlideId || null,
      thumbnail: entry.thumbnail || null,
      // docKey: 提取/保存时所在 PPT 的 FullName。同 cache.js 的设计，
      // list({ docKey }) 时只返回当前 PPT 的组件 + 没标 docKey 的 legacy 条目
      docKey: entry.docKey || null
    };
    entries.push(saved);
    writeAll(entries);
    return saved;
  }

  function update(id, patch) {
    const entries = readAll();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const merged = Object.assign({}, entries[idx], patch, { ts: Date.now() });
    entries[idx] = merged;
    writeAll(entries);
    return merged;
  }

  // 严格按 docKey 过滤：c.docKey === 入参（含 "" 匹配 ""/legacy）
  function list(opts) {
    if (typeof opts === "number") opts = { limit: opts };
    opts = opts || {};
    let entries = readAll().slice().reverse(); // 最新优先
    if (Object.prototype.hasOwnProperty.call(opts, "docKey")) {
      const docKey = String(opts.docKey || "");
      entries = entries.filter((e) => String(e.docKey || "") === docKey);
    }
    return typeof opts.limit === "number" ? entries.slice(0, opts.limit) : entries;
  }

  function get(id) {
    return readAll().find((e) => e.id === id) || null;
  }

  function getMany(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const set = new Set(ids);
    return readAll().filter((e) => set.has(e.id));
  }

  function remove(id) {
    const entries = readAll().filter((e) => e.id !== id);
    writeAll(entries);
  }

  function clear() {
    try { global.WpsAiStore.removeItem(KEY); } catch (e) {}
    try { global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: [], savedAt: Date.now() })); } catch (e) {}
  }

  global.WpsAiHtmlComponents = {
    save, update, list, get, getMany, remove, clear,
    MAX_ENTRIES,
    _key: KEY
  };
})(window);
