(function attachChatEvents(global) {
  "use strict";

  const STANDARD_TYPES = new Set([
    "message.delta",
    "message.end",
    "reasoning.delta",
    "reasoning.end",
    "tool.start",
    "tool.end",
    "source.add",
    "attachment.add",
    "status",
    "error",
    "done"
  ]);

  function newId(prefix) {
    return `${prefix || "evt"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function clipText(value, max) {
    const text = String(value == null ? "" : value);
    if (!Number.isFinite(max) || text.length <= max) return text;
    return text.slice(0, max) + "...[truncated]";
  }

  function safeJson(value, max) {
    try {
      const text = JSON.stringify(value);
      return text && text.length > max ? clipText(text, max) : value;
    } catch (e) {
      return clipText(String(value), max);
    }
  }

  function cleanResult(result) {
    if (!result || typeof result !== "object") return result;
    const out = { ok: !!result.ok };
    if (result.error != null) out.error = clipText(result.error, 1000);
    if (result.value != null) out.value = safeJson(result.value, 3000);
    return out;
  }

  function standardEvent(type, payload) {
    const base = payload && typeof payload === "object" ? payload : {};
    return Object.assign({
      schema: "lingxi.chat.event.v1",
      id: base.id || newId(type.replace(/\W+/g, "-")),
      type,
      ts: Number(base.ts) || Date.now()
    }, base, { type });
  }

  function normalizeEvent(ev, context) {
    if (!ev || typeof ev !== "object") return [];
    const ctx = context && typeof context === "object" ? context : {};
    if (STANDARD_TYPES.has(ev.type)) {
      return [standardEvent(ev.type, Object.assign({}, ctx, ev))];
    }

    switch (ev.type) {
      case "assistant_chunk":
        return [standardEvent("message.delta", {
          role: "assistant",
          delta: ev.delta || "",
          text: ev.fullText || ev.text || "",
          provider: ctx.provider,
          model: ctx.model
        })];
      case "assistant_text":
      case "assistant_text_end":
        return [standardEvent("message.end", {
          role: "assistant",
          text: ev.text || "",
          provider: ctx.provider,
          model: ctx.model,
          elapsedMs: ev.elapsedMs
        })];
      case "reasoning_chunk":
        return [standardEvent("reasoning.delta", {
          delta: ev.delta || "",
          text: ev.fullText || ev.text || "",
          provider: ctx.provider,
          model: ctx.model
        })];
      case "reasoning_end":
        return [standardEvent("reasoning.end", {
          text: ev.text || "",
          provider: ctx.provider,
          model: ctx.model
        })];
      case "tool_call":
        return [standardEvent("tool.start", {
          tool: { id: ev.id || "", name: ev.name || "", args: ev.args || {} },
          provider: ctx.provider,
          model: ctx.model
        })];
      case "tool_result":
        return [standardEvent("tool.end", {
          tool: { id: ev.id || "", name: ev.name || "", result: cleanResult(ev.result) },
          provider: ctx.provider,
          model: ctx.model
        })];
      case "source":
      case "citation":
        return [standardEvent("source.add", {
          source: ev.source || ev.citation || ev,
          provider: ctx.provider,
          model: ctx.model
        })];
      case "error":
        return [standardEvent("error", {
          error: {
            message: ev.message || ev.error || "Unknown error",
            code: ev.code || "",
            retryable: !!ev.retryable
          },
          provider: ctx.provider,
          model: ctx.model
        })];
      case "status":
        return [standardEvent("status", {
          status: ev.status || ev.state || "",
          text: ev.text || ev.message || "",
          provider: ctx.provider,
          model: ctx.model
        })];
      case "done":
        return [standardEvent("done", {
          text: ev.text || "",
          aborted: !!ev.aborted,
          provider: ctx.provider,
          model: ctx.model
        })];
      default:
        return [standardEvent("status", {
          status: "unknown_event",
          data: safeJson(ev, 3000),
          provider: ctx.provider,
          model: ctx.model
        })];
    }
  }

  // quickAction={label}：ribbon 快捷指令的模板提示词，回放时折叠成操作盒子
  function userMessageEvent(text, attachments, quickAction) {
    const payload = {
      role: "user",
      text: String(text == null ? "" : text),
      attachments: Array.isArray(attachments) ? attachments : []
    };
    if (quickAction && quickAction.label) payload.quickAction = { label: String(quickAction.label) };
    return standardEvent("message.end", payload);
  }

  function toLegacyEvent(ev) {
    if (!ev || typeof ev !== "object") return ev;
    switch (ev.type) {
      case "message.delta":
        return {
          type: "assistant_chunk",
          delta: ev.delta || "",
          fullText: ev.text || ""
        };
      case "message.end":
        if (ev.role === "user") {
          return { type: "user", text: ev.text || "", attachments: ev.attachments || [], quickAction: ev.quickAction || null, ts: ev.ts };
        }
        return {
          type: "assistant_text_end",
          text: ev.text || "",
          model: ev.model,
          elapsedMs: ev.elapsedMs
        };
      case "reasoning.delta":
        return {
          type: "reasoning_chunk",
          delta: ev.delta || "",
          fullText: ev.text || ""
        };
      case "reasoning.end":
        return { type: "reasoning_end", text: ev.text || "" };
      case "tool.start":
        return {
          type: "tool_call",
          id: ev.tool?.id || ev.id,
          name: ev.tool?.name || "",
          args: ev.tool?.args || {}
        };
      case "tool.end":
        return {
          type: "tool_result",
          id: ev.tool?.id || ev.id,
          name: ev.tool?.name || "",
          result: ev.tool?.result || { ok: false, error: "missing result" }
        };
      case "done":
        return { type: "done", text: ev.text || "", aborted: !!ev.aborted };
      case "error":
        return { type: "error", message: ev.error?.message || "Unknown error", error: ev.error };
      case "status":
      case "source.add":
      case "attachment.add":
      default:
        return ev;
    }
  }

  function sanitizeStandardEvent(ev) {
    if (!ev || typeof ev !== "object") return ev;
    const out = Object.assign({}, ev);
    out.schema = "lingxi.chat.event.v1";
    out.ts = Number(out.ts) || Date.now();
    if (out.text != null) out.text = clipText(out.text, 12000);
    if (out.delta != null) out.delta = clipText(out.delta, 2000);
    if (out.tool) {
      out.tool = Object.assign({}, out.tool);
      if (out.tool.args != null) out.tool.args = safeJson(out.tool.args, 2000);
      if (out.tool.result != null) out.tool.result = cleanResult(out.tool.result);
    }
    if (out.error?.message != null) {
      out.error = Object.assign({}, out.error, { message: clipText(out.error.message, 1000) });
    }
    return out;
  }

  global.WpsAiChatEvents = {
    normalizeEvent,
    toLegacyEvent,
    standardEvent,
    userMessageEvent,
    sanitizeStandardEvent
  };
})(window);
