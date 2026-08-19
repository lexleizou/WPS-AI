(function attachLingxiAgentReferences(global) {
  "use strict";

  const DEFAULTS = Object.freeze({ maxItems: 4, maxCharsPerItem: 12000, maxContextChars: 36000 });

  function clampText(value, maxChars) {
    const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
    const limit = Math.max(1, Number(maxChars) || DEFAULTS.maxCharsPerItem);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function referenceFingerprint(reference) {
    const input = `${reference.kind || ""}\u0000${reference.label || ""}\u0000${reference.text || ""}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `ref-${(hash >>> 0).toString(36)}`;
  }

  function normalizeReference(input, options) {
    const config = Object.assign({}, DEFAULTS, options || {});
    const kind = input?.kind === "document" ? "document" : "history";
    const text = clampText(input?.text, config.maxCharsPerItem);
    if (!text) return null;
    const fallbackLabel = kind === "document" ? "当前 WPS 文档" : "对话片段";
    const label = clampText(input?.label || fallbackLabel, 120) || fallbackLabel;
    const reference = { id: String(input?.id || ""), kind, label, text, truncated: String(input?.text || "").trim().length > text.length };
    reference.id = reference.id || referenceFingerprint(reference);
    return Object.freeze(reference);
  }

  function buildReferenceContext(references, options) {
    const config = Object.assign({}, DEFAULTS, options || {});
    const parts = [];
    for (const item of Array.isArray(references) ? references : []) {
      const ref = normalizeReference(item, config);
      if (!ref) continue;
      const heading = ref.kind === "document" ? `[@文档：${ref.label}]` : `[Agent 引用：${ref.label}]`;
      const suffix = ref.truncated ? "\n（内容已按安全上限截断）" : "";
      parts.push(`${heading}\n${ref.text}${suffix}`);
    }
    return clampText(parts.join("\n\n"), config.maxContextChars);
  }

  function createReferenceState(options) {
    const config = Object.assign({}, DEFAULTS, options || {});
    const items = [];
    function list() { return items.slice(); }
    function add(input) {
      const reference = normalizeReference(input, config);
      if (!reference) return { added: false, reason: "empty" };
      if (items.some((item) => item.id === reference.id)) return { added: false, reason: "duplicate", reference };
      if (items.length >= config.maxItems) return { added: false, reason: "limit", reference };
      items.push(reference);
      return { added: true, reference };
    }
    function remove(id) {
      const index = items.findIndex((item) => item.id === String(id || ""));
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    }
    function clear() { items.length = 0; }
    function consume() { const snapshot = list(); clear(); return snapshot; }
    function buildContext() { return buildReferenceContext(items, config); }
    return Object.freeze({ add, buildContext, clear, consume, list, remove });
  }

  const api = Object.freeze({ buildReferenceContext, createReferenceState, normalizeReference, referenceFingerprint });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.WpsAiAgentReferences = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
