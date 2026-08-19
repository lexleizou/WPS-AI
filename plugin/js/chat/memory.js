// WpsAiChatMemory：跨对话记忆（P2-4，参考察元 chatMemoryStore 轻量版）。
//
// 机制：对话被归档（新对话 / 切文档）时抽一条记忆——优先用长对话压缩的滚动摘要
// （js/chat/compress.js 产物，白嫖已有结果），没有则取最后一条 AI 回复截断。
// 新对话开场时按当前文档（docKey）取最近 N 条记忆注入 system prompt，
// AI 能接上「上个对话确定过的偏好/结论」。记忆按 docKey 隔离，跨文档不串。
(function attachChatMemory(global) {
  "use strict";

  const STORE_KEY = "lingxi_chat_memory_v1";
  const MAX_RECORDS = 50;
  const SUMMARY_CAP = 600;

  let records = null;

  function load() {
    if (records) return records;
    try {
      const raw = global.WpsAiStore?.getItem?.(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      records = Array.isArray(arr) ? arr : [];
    } catch (e) { records = []; }
    return records;
  }

  let _persister = null;
  function persistNow() {
    try { global.WpsAiStore?.setItem?.(STORE_KEY, JSON.stringify(records || [])); } catch (e) {}
  }
  function persist() {
    if (!_persister && global.WpsAiIdlePersist?.createIdlePersister) {
      _persister = global.WpsAiIdlePersist.createIdlePersister(persistNow, { wait: 300 });
      try {
        global.addEventListener && global.addEventListener("beforeunload", () => {
          try { _persister.flushSync(); } catch (e) {}
        });
      } catch (e) {}
    }
    if (_persister) _persister.schedule();
    else persistNow();
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join(" ");
    return content == null ? "" : String(content);
  }

  /**
   * 从对话记录抽一条记忆。返回记忆对象或 null（内容太少不值得记）。
   * 摘要来源优先级：压缩摘要（最完整）→ 最后一条 assistant 回复截断。
   */
  function captureFromConversation(conv) {
    if (!conv || !conv.id) return null;
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    if (msgs.length < 4) return null; // 少于两轮不值得记
    let summary = String(conv.compression?.summary || "").trim();
    if (!summary) {
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      summary = textOf(lastAssistant?.content).trim();
    }
    summary = summary.slice(0, SUMMARY_CAP);
    if (summary.length < 30) return null; // 摘要太短没信息量
    const list = load();
    const rec = {
      id: "mem-" + conv.id,
      convId: conv.id,
      docKey: String(conv.docKey || ""),
      title: String(conv.title || "对话").slice(0, 40),
      summary,
      ts: Date.now()
    };
    // 同一对话的记忆覆盖更新（对话可能被归档多次）
    const idx = list.findIndex((r) => r.convId === conv.id);
    if (idx >= 0) list.splice(idx, 1);
    list.push(rec);
    if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
    persist();
    return rec;
  }

  /** 当前文档最近的记忆（新的在前，排除当前对话） */
  function listForDoc(docKey, { excludeConvId = "", limit = 3 } = {}) {
    const key = String(docKey || "");
    if (!key) return [];
    return load()
      .filter((r) => r.docKey === key && r.convId !== excludeConvId)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit);
  }

  /** 注入 system prompt 的记忆块 */
  function buildBlock(memories, lang) {
    const list = Array.isArray(memories) ? memories : [];
    if (!list.length) return "";
    const en = lang === "en";
    const head = en
      ? "[Notes from earlier conversations on this document — treat as established context, prefer them over re-asking]"
      : "【历史对话备忘——来自本文档此前的对话，视为既有上下文，优先沿用而不要重新询问】";
    const lines = list.map((m) => `- ${m.title}: ${m.summary}`);
    return head + "\n" + lines.join("\n");
  }

  function reloadFromStore() {
    records = null;
    load();
  }

  function removeById(id) {
    const list = load();
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    persist();
    return true;
  }

  global.WpsAiChatMemory = { captureFromConversation, listForDoc, buildBlock, removeById, reloadFromStore, MAX_RECORDS };
})(window);
