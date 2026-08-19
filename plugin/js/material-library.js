(function attachMaterialLibrary(global) {
  "use strict";

  const KEY = "lingxi_material_library_v1";
  const MAX_ENTRIES = 80;
  const ALL_GROUP_ID = "all";
  const DEFAULT_GROUP_ID = "default";

  function nowId() {
    return "img-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function readStore() {
    try {
      const raw = global.WpsAiStore.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
        .map(normalizeEntry)
        .filter(Boolean);
      const groups = normalizeGroups(parsed.groups);
      return { entries, groups };
    } catch (e) {
      return { entries: [], groups: normalizeGroups([]) };
    }
  }

  function normalizeGroups(groups) {
    const seen = new Set();
    const out = [];
    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!id || id === ALL_GROUP_ID || seen.has(id)) return;
      out.push({ id, name: name || "未命名分组", ts: Number(group.ts) || Date.now() });
      seen.add(id);
    });
    if (!seen.has(DEFAULT_GROUP_ID)) {
      out.unshift({ id: DEFAULT_GROUP_ID, name: "未分组", ts: 0 });
    }
    return out;
  }

  function normalizeGroupId(groupId) {
    const id = String(groupId || "").trim();
    if (!id || id === ALL_GROUP_ID) return DEFAULT_GROUP_ID;
    return id;
  }

  function writeStore(storeOrEntries) {
    const store = Array.isArray(storeOrEntries)
      ? { entries: storeOrEntries, groups: readStore().groups }
      : (storeOrEntries || {});
    const trimmed = (Array.isArray(store.entries) ? store.entries : [])
      .filter((item) => item && (item.url || item.dataUrl))
      .map(normalizeEntry)
      .filter(Boolean)
      .slice(0, MAX_ENTRIES);
    const groups = normalizeGroups(store.groups);
    try {
      global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed, groups, savedAt: Date.now() }));
      return true;
    } catch (e) {
      try {
        global.WpsAiStore.setItem(KEY, JSON.stringify({ entries: trimmed.slice(0, 30), groups, savedAt: Date.now() }));
        return true;
      } catch (e2) {
        console.warn("[material-library] 写入失败:", e2?.message || e2);
        return false;
      }
    }
  }

  // 把数组或分隔字符串（逗号/中文顿号/分号）规整成标签数组：trim、去空、去重、限量。
  function normalizeTags(input) {
    let arr = [];
    if (Array.isArray(input)) arr = input;
    else if (typeof input === "string") arr = input.split(/[,，、;；]+/);
    const seen = new Set();
    const out = [];
    arr.map((t) => String(t == null ? "" : t).trim()).forEach((t) => {
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out.slice(0, 12);
  }

  function normalizeEntry(input) {
    const item = input || {};
    const url = String(item.url || "").trim();
    const dataUrl = String(item.dataUrl || "").trim();
    if (!url && !dataUrl) return null;
    return {
      id: item.id || nowId(),
      url,
      dataUrl,
      sourceUrl: String(item.sourceUrl || "").trim(),
      prompt: String(item.prompt || "").trim(),
      revisedPrompt: String(item.revisedPrompt || "").trim(),
      size: String(item.size || "").trim(),
      resolution: String(item.resolution || "").trim(),
      model: String(item.model || "").trim(),
      providerType: String(item.providerType || "").trim(),
      groupId: normalizeGroupId(item.groupId),
      // 标签化 + 多来源：全部有默认值，旧条目读出即补全（向后兼容）。
      tags: normalizeTags(item.tags),
      // 没显式带项目时，用「AI 每对话总结的项目名」自动打标签（替代原手填当前项目）
      project: String(item.project || "").trim() || (global.WpsAiProject && global.WpsAiProject.name ? global.WpsAiProject.name() : ""),
      source: String(item.source || "generated").trim() || "generated",
      kind: String(item.kind || "image").trim() || "image",
      title: String(item.title || "").trim(),
      text: String(item.text || "").trim(),
      ts: Number(item.ts) || Date.now()
    };
  }

  function add(input, options) {
    const entry = normalizeEntry(input);
    if (!entry) return null;
    const store = readStore();
    const key = entry.url || entry.dataUrl;
    const allowDuplicate = !!(options && options.allowDuplicate);
    const next = allowDuplicate
      ? store.entries.slice()
      : store.entries.filter((it) => (it.url || it.dataUrl) !== key);
    next.unshift(entry);
    // 写失败（localStorage 配额）时返回 null，避免上层误报"已保存"（内存里没持久化、UI 也读不到）。
    if (!writeStore({ entries: next, groups: store.groups })) return null;
    notify();
    // 获取素材即触发「本对话项目名」生成（一对话一次，异步、幂等），下一条素材起就能带上
    try { if (global.WpsAiProject && global.WpsAiProject.ensure) global.WpsAiProject.ensure(); } catch (e) {}
    return entry;
  }

  function addMany(items, meta = {}) {
    const added = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      const entry = add(Object.assign({}, meta, item));
      if (entry) added.push(entry);
    });
    return added;
  }

  function list(opts = {}) {
    const store = readStore();
    const groupId = opts?.groupId || ALL_GROUP_ID;
    if (!groupId || groupId === ALL_GROUP_ID) return store.entries;
    return store.entries.filter((item) => normalizeGroupId(item.groupId) === groupId);
  }

  function listGroups() {
    const store = readStore();
    const counts = new Map();
    store.entries.forEach((item) => {
      const id = normalizeGroupId(item.groupId);
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return [
      { id: ALL_GROUP_ID, name: "全部", virtual: true, count: store.entries.length },
      ...store.groups.map((group) => Object.assign({}, group, { count: counts.get(group.id) || 0 }))
    ];
  }

  function find(id) {
    return list().find((item) => item.id === id) || null;
  }

  function remove(id) {
    const store = readStore();
    const next = store.entries.filter((item) => item.id !== id);
    if (next.length === store.entries.length) return false;
    writeStore({ entries: next, groups: store.groups });
    notify();
    return true;
  }

  function clear() {
    const store = readStore();
    writeStore({ entries: [], groups: store.groups });
    notify();
  }

  function createGroup(name) {
    const clean = String(name || "").trim();
    if (!clean) return null;
    const store = readStore();
    const exists = store.groups.find((group) => group.name === clean);
    if (exists) return exists;
    const group = {
      id: "grp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      name: clean,
      ts: Date.now()
    };
    writeStore({ entries: store.entries, groups: store.groups.concat(group) });
    notify();
    return group;
  }

  function renameGroup(id, name) {
    const groupId = String(id || "").trim();
    const clean = String(name || "").trim();
    if (!groupId || groupId === ALL_GROUP_ID || groupId === DEFAULT_GROUP_ID || !clean) return false;
    const store = readStore();
    let changed = false;
    const groups = store.groups.map((group) => {
      if (group.id !== groupId) return group;
      changed = true;
      return Object.assign({}, group, { name: clean });
    });
    if (!changed) return false;
    writeStore({ entries: store.entries, groups });
    notify();
    return true;
  }

  function deleteGroup(id) {
    const groupId = String(id || "").trim();
    if (!groupId || groupId === ALL_GROUP_ID || groupId === DEFAULT_GROUP_ID) return false;
    const store = readStore();
    const groups = store.groups.filter((group) => group.id !== groupId);
    if (groups.length === store.groups.length) return false;
    const entries = store.entries.map((entry) => {
      if (normalizeGroupId(entry.groupId) !== groupId) return entry;
      return Object.assign({}, entry, { groupId: DEFAULT_GROUP_ID });
    });
    writeStore({ entries, groups });
    notify();
    return true;
  }

  // 合并 patch 到条目并经 normalizeEntry 规整（用于 setTags/setProject 等后补标签场景）。
  function update(id, patch) {
    const store = readStore();
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const merged = normalizeEntry(Object.assign({}, store.entries[idx], patch || {}, { id }));
    if (!merged) return null;
    const entries = store.entries.slice();
    entries[idx] = merged;
    writeStore({ entries, groups: store.groups });
    notify();
    return merged;
  }

  function moveEntries(ids, groupId) {
    const idSet = new Set(Array.isArray(ids) ? ids.map(String) : [String(ids || "")]);
    idSet.delete("");
    if (!idSet.size) return 0;
    const targetGroupId = normalizeGroupId(groupId);
    const store = readStore();
    let moved = 0;
    const entries = store.entries.map((entry) => {
      if (!idSet.has(entry.id)) return entry;
      moved += 1;
      return Object.assign({}, entry, { groupId: targetGroupId });
    });
    if (!moved) return 0;
    writeStore({ entries, groups: store.groups });
    notify();
    return moved;
  }

  const listeners = new Set();
  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    listeners.forEach((fn) => {
      try { fn(list()); } catch (e) {}
    });
  }

  global.WpsAiMaterialLibrary = {
    add,
    addMany,
    list,
    listGroups,
    find,
    remove,
    clear,
    createGroup,
    renameGroup,
    deleteGroup,
    moveEntries,
    update,
    normalizeTags,
    ALL_GROUP_ID,
    DEFAULT_GROUP_ID,
    subscribe
  };
})(window);
