/**
 * 多对话管理：把每次 AI 助手的对话保存成独立 conversation，
 * 可以新建、切换、删除。
 *
 * 数据条目结构：
 *   {
 *     id: 'c-...',
 *     title: '帮我润色这段...',   // 从第一句 user message 自动生成
 *     createdAt: 1683830400000,
 *     updatedAt: 1683830900000,
 *     messages: [
 *       { role: 'user', content: '...' },
 *       { role: 'assistant', content: '...' },
 *       ...
 *     ]
 *   }
 *
 * 持久化：localStorage 'lingxi_conversations_v1'，限 MAX 条 FIFO；
 *         当前激活 id 存 'lingxi_current_conversation_v1'。
 *
 * 注意：messages 只存原始 user/assistant 文本（即 chatHistory 数组本身）。
 * 工具调用 / tool_result / 推理这些过程不进 conversation，因为切换重放
 * 它们没意义（旧调用不会被复执行，且会污染上下文）。
 */
(function attachConversations(global) {
  "use strict";

  const STORAGE_KEY = "lingxi_conversations_v1";
  const CURRENT_KEY = "lingxi_current_conversation_v1";
  const MAX_CONVS = 50;
  const TITLE_MAX_LEN = 40;
  const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "skipped"]);

  let conversations = [];
  let currentId = null;
  const listeners = new Set();

  function normalizeTodoStatus(status) {
    const s = String(status || "").trim();
    return TODO_STATUSES.has(s) ? s : "pending";
  }

  function normalizeTodos(todos) {
    if (!Array.isArray(todos)) return [];
    return todos.map((todo, index) => {
      const now = Date.now();
      const src = todo && typeof todo === "object" ? todo : {};
      const title = String(src.title || src.text || src.content || "").trim().slice(0, 200);
      if (!title) return null;
      return {
        id: String(src.id || `todo-${index + 1}`),
        title,
        status: normalizeTodoStatus(src.status),
        detail: src.detail != null ? String(src.detail).slice(0, 1000) : "",
        updatedAt: Number(src.updatedAt) || now
      };
    }).filter(Boolean).slice(0, 30);
  }

  function normalizeTodoMeta(meta) {
    const src = meta && typeof meta === "object" ? meta : {};
    return {
      enabled: !!src.enabled,
      createdAt: Number(src.createdAt) || 0,
      updatedAt: Number(src.updatedAt) || 0,
      source: src.source ? String(src.source).slice(0, 40) : ""
    };
  }

  function normalizeConversation(conv) {
    if (!conv || typeof conv !== "object") return conv;
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
    conv.events = Array.isArray(conv.events) ? conv.events : [];
    conv.eventsV2 = Array.isArray(conv.eventsV2) ? conv.eventsV2 : [];
    conv.todos = normalizeTodos(conv.todos);
    conv.todoMeta = normalizeTodoMeta(conv.todoMeta);
    return conv;
  }

  function loadAll() {
    try {
      const raw = global.WpsAiStore.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(normalizeConversation).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  // 排序（updatedAt 升序）+ 限 MAX 条尾部保留 —— 合并后统一收口本地视图。
  function capConvs(arr) {
    const sorted = (Array.isArray(arr) ? arr.slice() : []).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return sorted.length > MAX_CONVS ? sorted.slice(-MAX_CONVS) : sorted;
  }

  // 修 Critical 1：4 个宿主共用同一 SQLite。把"读-合并-写"放到服务端（DB 唯一属主）原子完成，
  // 前端只把本地对话数组交给 WpsAiStore.mergeList（sqlite → POST /kv/merge-list；localStorage/降级
  // → 本地读 Map + 客户端合并 + setItem），避免各宿主互相覆盖对方的 SQLite 写入。
  // 各调用方均不 await persist，这里 fire-and-forget；合并是服务端原子的，安全。
  //
  // P0-3 idle 错峰：persistNow 里的全量 JSON.stringify + 网络合并挪出关键路径。
  // persist() 变成调度入口（debounce 250ms + requestIdleCallback），读的是调用时刻之后的
  // 最新 conversations（模块级引用），延迟执行不会写旧快照；beforeunload 强制 flush +
  // sendBeacon 兜底（unload 时 fetch 可能被杀，beacon 能送达）。
  let _persistScheduler = null;
  function persist() {
    if (!_persistScheduler && global.WpsAiIdlePersist?.createIdlePersister) {
      _persistScheduler = global.WpsAiIdlePersist.createIdlePersister(persistNow, { wait: 250 });
      try {
        global.addEventListener && global.addEventListener("beforeunload", () => {
          try { _persistScheduler.flushSync(); } catch (e) {}
          // beacon 双保险：unload 中 fetch 常被浏览器杀掉，sendBeacon 保证请求发出。
          // 与 /kv/merge-list 请求体同形；服务端合并幂等，多发一次无害。
          try {
            const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
            const payload = JSON.stringify({ key: STORAGE_KEY, items: conversations, idKey: "id", tsKey: "updatedAt" });
            global.navigator?.sendBeacon?.(base + "/kv/merge-list", new Blob([payload], { type: "application/json" }));
          } catch (e) {}
        });
      } catch (e) {}
    }
    if (_persistScheduler) _persistScheduler.schedule();
    else persistNow(); // idle-persist 未加载（极早期/单测环境）退回立即执行
  }

  function persistNow() {
    let p;
    try { p = global.WpsAiStore.mergeList(STORAGE_KEY, conversations, "id", "updatedAt"); } catch (e) { return; }
    Promise.resolve(p).then((arr) => {
      if (Array.isArray(arr)) {
        const capped = capConvs(arr);
        conversations = capped;
        if (capped.length !== arr.length) persistExact();
        notify();
      }
    }).catch((e) => {
      // localStorage 满了 → 砍一半重试一次（仅降级到 localStorage 后端时可能发生）
      if (e?.name === "QuotaExceededError" && conversations.length > 5) {
        conversations = conversations.slice(-Math.floor(conversations.length / 2));
        try { global.WpsAiStore.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch (_) {}
      }
    });
  }

  // mergeList is intentionally upsert-only. Paths that actually remove rows
  // (delete and MAX_CONVS pruning) must replace the stored list exactly.
  function persistExact() {
    try {
      conversations = capConvs(conversations);
      global.WpsAiStore.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch (e) {}
  }

  function loadCurrentId() {
    try { return global.WpsAiStore.getItem(CURRENT_KEY) || null; } catch (e) { return null; }
  }

  function persistCurrentId() {
    try {
      if (currentId) global.WpsAiStore.setItem(CURRENT_KEY, currentId);
      else global.WpsAiStore.removeItem(CURRENT_KEY);
    } catch (e) {}
  }

  // 模块脚本解析时（top-level）就会跑到这一段，早于 app.js boot 里 WpsAiStore.init()
  // 把 sqlite 数据灌进内存 Map —— 那时候读到的必然是空表。暴露 reloadFromStore()，
  // 让 app.js 在 init() 完成后再补一次读，把 conversations/currentId 换成真实数据。
  function reloadFromStore() {
    conversations = loadAll();
    currentId = loadCurrentId();
  }
  reloadFromStore();

  function notify() {
    listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  }

  function newId() {
    return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function deriveTitle(messages) {
    const firstUser = messages.find((m) => m.role === "user");
    const text = firstUser ? String(firstUser.content || "").trim().replace(/\s+/g, " ") : "";
    if (!text) return "新对话";
    return text.length > TITLE_MAX_LEN ? text.slice(0, TITLE_MAX_LEN) + "…" : text;
  }

  function getCurrent() {
    if (!currentId) return null;
    return conversations.find((c) => c.id === currentId) || null;
  }

  // 命中判断：conv 的 docKey 跟 primary 一致 → 命中主。
  // primary 是新式 "id:<uuid>" 时，还允许 conv.docKey === legacy（裸路径）也算命中 ——
  // 这条命中记为 legacy hit，用于迁移：找到就把 conv.docKey 就地升级成 primary，
  // 之后就永远按新 key 匹配，用户零感知。
  function matchAndMigrate(conv, primary, legacy) {
    const own = String(conv.docKey || "");
    const pri = String(primary || "");
    if (own === pri) return "primary";
    if (legacy && own === String(legacy)) {
      conv.docKey = pri;   // 就地升级
      conv.updatedAt = conv.updatedAt || Date.now();
      return "legacy";
    }
    return null;
  }

  // 拿当前文档"应该"激活的对话：currentId 对应条目的 docKey 跟当前 docKey 匹配才算
  // 否则返回 null（调用方就该开新对话）。docKey 为 "" 时 = "没打开文件场景"，
  // 此时也只匹配 docKey="" 的对话（避免误关联到别的文件历史）。
  // legacyDocKey：向后兼容 —— 之前按裸路径存的老对话，当前 docKey 是 "id:<uuid>" 时
  // 顺带把匹配到裸路径的记录升级过来（迁移场景，只需第一次点回来一次）。
  function getCurrentForDoc(docKey, legacyDocKey) {
    if (!currentId) return null;
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return null;
    const hit = matchAndMigrate(conv, docKey, legacyDocKey);
    if (!hit) return null;
    if (hit === "legacy") persist();  // 落盘升级后的 docKey
    return conv;
  }

  // 返回按 updatedAt 倒序的副本；不暴露内部引用。
  // opts.docKey:
  //   - 传 "C:/foo.docx" 等具体路径 → 严格匹配 c.docKey === 该路径
  //   - 传 "" 或 null（显式）        → 只返回 c.docKey 为空（含旧版没标 docKey 的 legacy 对话）
  //   - 整个 opts 不传                → 全部返回（兼容老调用方）
  // opts.legacyDocKey：新 docKey 是 "id:<uuid>" 时，把 docKey===裸路径 的老对话也算命中，
  //                    并当场升级 docKey 到新式（迁移一次就完事）。
  function listConversations(opts) {
    let list = conversations.slice();
    const hasDocKeyArg = opts && Object.prototype.hasOwnProperty.call(opts, "docKey");
    if (hasDocKeyArg) {
      const primary = String(opts.docKey || "");
      const legacy = opts.legacyDocKey ? String(opts.legacyDocKey) : "";
      let migrated = 0;
      list = list.filter((c) => {
        const hit = matchAndMigrate(c, primary, legacy);
        if (hit === "legacy") migrated += 1;
        return !!hit;
      });
      if (migrated > 0) persist();
    }
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 创建新对话，立刻成为 current。返回新对话对象。
  // opts.docKey: 当前活动文档的绝对路径，让该对话跟文件绑定 —— 切到别的文件就不显示这条
  function createNew(opts) {
    const docKey = (opts && opts.docKey != null) ? String(opts.docKey) : "";
    const conv = {
      id: newId(),
      title: "新对话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      todos: [],
      todoMeta: { enabled: false, createdAt: 0, updatedAt: 0, source: "" },
      eventsV2: [],
      events: [],     // UI 重放所需：user / reasoning / tool_call / tool_result / assistant
      docKey         // 绑定到具体文件路径；空串/null = 未关联文件（兼容老条目）
    };
    conversations.push(conv);
    let pruned = false;
    if (conversations.length > MAX_CONVS) {
      conversations = conversations.slice(-MAX_CONVS);
      pruned = true;
    }
    currentId = conv.id;
    if (pruned) persistExact();
    else persist();
    persistCurrentId();
    notify();
    return conv;
  }

  // 事件入库前压一遍：去掉 base64 大图、裁掉超长正文、丢弃 tool_result 里可能巨大的 value，
  // 只保留 replay 真正要用的字段（reasoning/assistant 的 text、tool_result 的 {ok,error}）。
  // 否则一轮巨型 PPT（十几次渲染工具、超长推理）会把单条对话撑到 MB 级、撑爆 localStorage。
  function sanitizeEvent(ev) {
    if (!ev || typeof ev !== "object") return ev;
    const stripB64 = (t) => String(t == null ? "" : t).replace(/data:[a-z0-9/+.\-]+;base64,[A-Za-z0-9+/=]+/gi, "[base64]");
    const clip = (t, max) => { const s = stripB64(t); return s.length > max ? s.slice(0, max) + "…[截断]" : s; };
    if (ev.type === "reasoning") return { type: "reasoning", ts: ev.ts, text: clip(ev.text, 6000) };
    if (ev.type === "assistant") {
      const out = { type: "assistant", ts: ev.ts, text: clip(ev.text, 12000) };
      if (ev.model != null) out.model = clip(ev.model, 120);
      if (Number.isFinite(ev.elapsedMs)) out.elapsedMs = Math.max(0, Math.round(ev.elapsedMs));
      return out;
    }
    if (ev.type === "tool_call") {
      let args = ev.args;
      try { const s = JSON.stringify(args); if (s && s.length > 2000) args = clip(s, 2000); } catch (e) { args = String(args).slice(0, 2000); }
      return { type: "tool_call", ts: ev.ts, name: ev.name, args };
    }
    if (ev.type === "tool_result") {
      const r = ev.result;
      let result = r;
      if (r && typeof r === "object") {
        result = { ok: r.ok };                                  // 保 replay 需要的 ok
        if (r.error != null) result.error = clip(r.error, 800); // 保错误摘要；丢弃可能巨大的 value/正文
      } else if (typeof r === "string") {
        result = clip(r, 2000);
      }
      return { type: "tool_result", ts: ev.ts, name: ev.name, result };
    }
    return ev;
  }

  // 按总体积裁：单条对话的 events 序列化后不超过 ~600KB，从最旧开始丢，直到进预算。
  function trimEventsBySize(conv, budget = 600000) {
    let events = conv.events || [];
    let size = 0;
    try { size = JSON.stringify(events).length; } catch (e) { size = 0; }
    while (events.length > 1 && size > budget) {
      const drop = Math.max(1, Math.floor(events.length * 0.15));
      events = events.slice(drop);
      try { size = JSON.stringify(events).length; } catch (e) { break; }
    }
    conv.events = events;
  }

  // 追加本轮事件流（user/reasoning/tool_call/tool_result/assistant）到当前对话
  // events: [{ type, ... }] 由 app.js 在 runChatTurn 里收集
  function appendTurnEvents(events) {
    if (!events || !events.length) return;
    let current = getCurrent();
    if (!current) current = createNew();
    current.events = (current.events || []).concat(events.map(sanitizeEvent));
    // 限事件数：单条对话最多保留 500 条（防止巨型 PPT 一轮调几十次工具撑爆 storage）
    if (current.events.length > 500) {
      current.events = current.events.slice(-500);
    }
    trimEventsBySize(current); // 再按体积兜底，防止少量超大事件仍撑爆
    current.updatedAt = Date.now();
    persist();
    notify();
  }

  function trimEventsV2BySize(conv, budget = 800000) {
    let events = conv.eventsV2 || [];
    let size = 0;
    try { size = JSON.stringify(events).length; } catch (e) { size = 0; }
    while (events.length > 1 && size > budget) {
      const drop = Math.max(1, Math.floor(events.length * 0.15));
      events = events.slice(drop);
      try { size = JSON.stringify(events).length; } catch (e) { break; }
    }
    conv.eventsV2 = events;
  }

  function sanitizeEventV2(ev) {
    if (global.WpsAiChatEvents?.sanitizeStandardEvent) {
      return global.WpsAiChatEvents.sanitizeStandardEvent(ev);
    }
    return ev;
  }

  // 立即把待写的对话刷到存储（触发被 250ms 防抖挂起的 persistNow 马上跑）。用于「每轮结束」这种
  // 自然空闲点做确定性落盘——mac 的 WPS WebView 关文档时 beforeunload 常不触发，光靠防抖 + beforeunload
  // 可能把最后一轮的 events 丢掉，导致重开后历史回放没有事件流。
  function flush() {
    try {
      if (_persistScheduler && typeof _persistScheduler.flushSync === "function") _persistScheduler.flushSync();
      else persistNow();
    } catch (e) { /* 尽力而为，失败不影响对话 */ }
  }

  function appendTurnEventsV2(events) {
    if (!events || !events.length) return;
    let current = getCurrent();
    if (!current) current = createNew();
    current.eventsV2 = (current.eventsV2 || []).concat(events.map(sanitizeEventV2));
    if (current.eventsV2.length > 800) {
      current.eventsV2 = current.eventsV2.slice(-800);
    }
    trimEventsV2BySize(current);
    current.updatedAt = Date.now();
    persist();
    notify();
  }

  function switchTo(id) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return null;
    currentId = id;
    persistCurrentId();
    notify();
    return conv;
  }

  // 把 currentId 清掉（不删任何对话）。文档切换后用：
  // 让下一次发消息触发 lazy createNew，新对话挂到新 docKey 下而不是误写到旧文件的对话。
  function clearCurrent() {
    if (!currentId) return;
    currentId = null;
    persistCurrentId();
    notify();
  }

  function deleteById(id) {
    conversations = conversations.filter((c) => c.id !== id);
    if (currentId === id) {
      currentId = null;
      persistCurrentId();
    }
    persistExact();
    notify();
  }

  function rename(id, newTitle) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return false;
    conv.title = String(newTitle || "").trim().slice(0, TITLE_MAX_LEN * 2) || conv.title;
    conv.updatedAt = Date.now();
    persist();
    notify();
    return true;
  }

  // 长对话压缩状态：{ summary, upTo }。upTo = 已被摘要覆盖的 messages 条数，
  // 与 conv.messages / app.js chatHistory 的索引对齐（syncMessages 全量存储，不裁剪）。
  function getCompression(id) {
    const conv = id ? conversations.find((c) => c.id === id) : getCurrent();
    const c = conv && conv.compression;
    if (!c || typeof c.summary !== "string" || !c.summary.trim()) return null;
    const upTo = Math.max(0, c.upTo | 0);
    if (upTo <= 0 || upTo > (conv.messages || []).length) return null; // 索引失效则视为无压缩
    return { summary: c.summary, upTo };
  }

  function setCompression(id, comp) {
    const conv = id ? conversations.find((c) => c.id === id) : getCurrent();
    if (!conv) return false;
    if (comp && typeof comp.summary === "string" && comp.summary.trim() && (comp.upTo | 0) > 0) {
      conv.compression = {
        summary: comp.summary.trim().slice(0, 8000),
        upTo: comp.upTo | 0,
        updatedAt: Date.now()
      };
    } else {
      conv.compression = null;
    }
    conv.updatedAt = Date.now();
    persist();
    return true;
  }

  // 项目名：AI 每对话总结一次，存在对话上，获取素材时作为项目标签复用。
  function setProjectName(id, projectName) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return false;
    const name = String(projectName || "").trim().slice(0, 40);
    if (!name || conv.projectName === name) return false;
    conv.projectName = name;
    conv.updatedAt = Date.now();
    persist();
    notify();
    return true;
  }

  // 把 app.js 的 chatHistory 数组同步到当前对话（每轮结束 + 清空时调用）
  // 如果没有 current，自动创建一个
  function rebindCurrentDocKey(docKey) {
    const conv = getCurrent();
    if (!conv) return false;
    const key = String(docKey || "");
    if (conv.docKey === key) return true;
    conv.docKey = key;
    conv.updatedAt = Date.now();
    persist();
    notify();
    return true;
  }

  function syncMessages(messages) {
    let current = getCurrent();
    if (!current) {
      current = createNew();
    }
    current.messages = (messages || []).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));
    current.updatedAt = Date.now();
    // 标题：只在还是默认"新对话"时根据首句用户消息自动生成
    if (current.title === "新对话" && messages && messages.length > 0) {
      current.title = deriveTitle(messages);
    }
    persist();
    notify();
  }

  // 切到某对话并把 messages + events 返回给调用方
  // app.js 优先用 events 重布完整流，没 events 才退到 messages-only
  function loadAsActive(id) {
    const conv = switchTo(id);
    if (!conv) return null;
    return {
      messages: (conv.messages || []).slice(),
      events: (conv.events || []).slice(),
      eventsV2: (conv.eventsV2 || []).slice(),
      todos: normalizeTodos(conv.todos),
      todoMeta: normalizeTodoMeta(conv.todoMeta)
    };
  }

  function getConversationTodos(conversationId) {
    const conv = conversationId
      ? conversations.find((c) => c.id === conversationId)
      : getCurrent();
    if (!conv) return { todos: [], meta: normalizeTodoMeta(null) };
    conv.todos = normalizeTodos(conv.todos);
    conv.todoMeta = normalizeTodoMeta(conv.todoMeta);
    return {
      todos: conv.todos.slice(),
      meta: Object.assign({}, conv.todoMeta)
    };
  }

  function setConversationTodos(conversationId, todos, meta) {
    const conv = conversationId
      ? conversations.find((c) => c.id === conversationId)
      : getCurrent();
    if (!conv) return false;
    const now = Date.now();
    const prevMeta = normalizeTodoMeta(conv.todoMeta);
    conv.todos = normalizeTodos(todos);
    conv.todoMeta = Object.assign(prevMeta, normalizeTodoMeta(meta), {
      enabled: conv.todos.length > 0,
      createdAt: prevMeta.createdAt || now,
      updatedAt: now
    });
    conv.updatedAt = now;
    persist();
    notify();
    return true;
  }

  function patchConversationTodo(conversationId, todoId, patch) {
    const conv = conversationId
      ? conversations.find((c) => c.id === conversationId)
      : getCurrent();
    if (!conv || !todoId) return false;
    conv.todos = normalizeTodos(conv.todos);
    const item = conv.todos.find((t) => t.id === String(todoId));
    if (!item) return false;
    const p = patch && typeof patch === "object" ? patch : {};
    if (p.title != null) item.title = String(p.title).trim().slice(0, 200) || item.title;
    if (p.status != null) item.status = normalizeTodoStatus(p.status);
    if (p.detail != null) item.detail = String(p.detail).slice(0, 1000);
    item.updatedAt = Date.now();
    conv.todoMeta = Object.assign(normalizeTodoMeta(conv.todoMeta), { enabled: true, updatedAt: item.updatedAt });
    conv.updatedAt = item.updatedAt;
    persist();
    notify();
    return true;
  }

  function clearConversationTodos(conversationId) {
    return setConversationTodos(conversationId, [], { enabled: false, source: "" });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  global.WpsAiConversations = {
    listConversations,
    getCurrent,
    getCurrentForDoc,
    getCurrentId: () => currentId,
    createNew,
    switchTo,
    clearCurrent,
    loadAsActive,
    deleteById,
    rename,
    setProjectName,
    getCompression,
    setCompression,
    rebindCurrentDocKey,
    getConversationTodos,
    setConversationTodos,
    patchConversationTodo,
    clearConversationTodos,
    syncMessages,
    appendTurnEvents,
    appendTurnEventsV2,
    flush,
    subscribe,
    reloadFromStore,
    MAX_CONVS
  };
})(window);
