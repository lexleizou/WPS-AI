// 本地缓存：记录所有用 wpp_render_html_template 生成过的页面 HTML + 参数。
// 用 localStorage 存（一份 JSON），FIFO 至 MAX_ENTRIES 上限，超额淘汰最早的。
//
// 用途：用户在「HTML 模板预览」窗口可以从缓存里召回上次的页面继续微调；
// 也方便回看历史生成记录。每条记录包含：id / ts / templateName / layout / data / palette / slideHint。
//
// 不缓存 rendered PNG（dataURL 巨大；缓存 HTML 参数足够，预览时按需重渲染）。
(function attachHtmlCache(global) {
  "use strict";

  const KEY = "lingxi_html_template_cache_v1";
  const MAX_ENTRIES = 100;

  function genId() {
    return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function readAll() {
    try {
      const raw = global.WpsAiStore.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (e) {
      console.warn("[html-cache] 读取缓存失败，已清空：", e?.message || e);
      try { global.WpsAiStore.removeItem(KEY); } catch (_) {}
      return [];
    }
  }

  function writeAll(entries) {
    try {
      const trimmed = entries.slice(-MAX_ENTRIES);
      global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
    } catch (e) {
      // localStorage 满了：尝试瘦身（只保留最近 30 条）后再试一次；仍失败就放弃
      try {
        const trimmed = entries.slice(-30);
        global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
      } catch (e2) {
        console.error("[html-cache] 写入失败（localStorage 可能已满）：", e2?.message || e2);
      }
    }
  }

  // 保存一条记录。返回写入后的 entry（带 id / ts）。
  // entry: { templateName, layout, data, palette, slideHint?, batchTag?, draft?, docKey? }
  // - batchTag: 一次 wpp_render_full_deck 调用产生的全部 entry 共享一个 tag
  // - draft: preview=true 但用户还没确认时为 true；确认后 update 移除
  // - docKey: 当前 PPT 的文件路径（ActivePresentation.FullName）—— 切到别的 PPT 时
  //           list({ docKey }) 过滤掉别人的历史，让"我的历史"跟当前打开的 PPT 走
  function save(entry) {
    if (!entry?.templateName || !entry?.layout) {
      throw new Error("save: templateName + layout 必填");
    }
    const entries = readAll();
    const saved = {
      id: genId(),
      ts: Date.now(),
      templateName: entry.templateName,
      layout: entry.layout,
      data: entry.data || {},
      palette: entry.palette || {},
      slideHint: entry.slideHint || null,
      batchTag: entry.batchTag || null,
      draft: !!entry.draft,
      docKey: entry.docKey || null
    };
    entries.push(saved);
    writeAll(entries);
    return saved;
  }

  // 按 batchTag 列出一批 entries（最新 batch 在前）。配合「撤销本次批量插入」使用。
  function listByBatch(batchTag) {
    if (!batchTag) return [];
    return readAll().filter((e) => e.batchTag === batchTag);
  }
  // 列出所有已知 batchTag（去重 + 按最近 ts 倒序），UI 显示「最近批次」用
  function listBatches() {
    const map = new Map();
    readAll().forEach((e) => {
      if (!e.batchTag) return;
      const prev = map.get(e.batchTag);
      if (!prev || e.ts > prev.latestTs) {
        map.set(e.batchTag, {
          batchTag: e.batchTag,
          latestTs: e.ts,
          count: (prev?.count || 0) + 1
        });
      } else {
        prev.count += 1;
      }
    });
    return Array.from(map.values()).sort((a, b) => b.latestTs - a.latestTs);
  }
  // 按 batchTag 批量删除
  function removeBatch(batchTag) {
    if (!batchTag) return 0;
    const entries = readAll();
    const remaining = entries.filter((e) => e.batchTag !== batchTag);
    const removedCount = entries.length - remaining.length;
    writeAll(remaining);
    return removedCount;
  }

  // 按 id 更新已有记录（用户在预览窗口微调后保存）
  function update(id, patch) {
    const entries = readAll();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const merged = Object.assign({}, entries[idx], patch, { ts: Date.now() });
    entries[idx] = merged;
    writeAll(entries);
    return merged;
  }

  // 列表（最新优先）。
  // opts.limit: 数量限制
  // opts.docKey: 严格匹配 e.docKey === 入参。
  //   - 具体路径 → 只该文件
  //   - 显式 "" → 只 e.docKey 为空（含 legacy 老条目）
  //   - 不传 opts.docKey 字段 → 不过滤
  function list(opts) {
    // 兼容老用法 list(20) —— 数字当 limit
    if (typeof opts === "number") opts = { limit: opts };
    opts = opts || {};
    let entries = readAll().slice().reverse();
    if (Object.prototype.hasOwnProperty.call(opts, "docKey")) {
      const docKey = String(opts.docKey || "");
      entries = entries.filter((e) => String(e.docKey || "") === docKey);
    }
    return typeof opts.limit === "number" ? entries.slice(0, opts.limit) : entries;
  }

  function get(id) {
    return readAll().find((e) => e.id === id) || null;
  }

  function remove(id) {
    const entries = readAll().filter((e) => e.id !== id);
    writeAll(entries);
  }

  function clear() {
    // 双保险：① removeItem ② 再写入显式空数组（某些 WebView 的 removeItem 持久化有问题）
    try { global.WpsAiStore.removeItem(KEY); } catch (e) {}
    try { global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: [], savedAt: Date.now() })); } catch (e) {}
    // 修 #13: 广播一个 sentinel 给同源的其他窗口（HTML 预览 dialog）：
    // 它们读到这个 key 变化后要把当前 state.id 置 null（变成"新建模式"），不然 Save 会去 update 一个已不存在的 entry。
    try {
      localStorage.setItem("lingxi_html_cache_cleared_at", String(Date.now()));
    } catch (e) {}
  }

  global.WpsAiHtmlCache = {
    save,
    update,
    list,
    listByBatch,
    listBatches,
    get,
    remove,
    removeBatch,
    clear,
    MAX_ENTRIES,
    _key: KEY
  };
})(window);
