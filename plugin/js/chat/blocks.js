(function attachChatBlocks(global) {
  "use strict";

  function makeBlock(kind, data) {
    return Object.assign({
      kind,
      id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now()
    }, data || {});
  }

  function getToolName(ev) {
    return ev?.tool?.name || ev?.name || "";
  }

  function fromEvents(events) {
    const out = [];
    const assistantDelta = { text: "", ts: 0, model: "", provider: "" };
    const reasoningDelta = { text: "", ts: 0 };

    (Array.isArray(events) ? events : []).forEach((ev) => {
      if (!ev || typeof ev !== "object") return;
      switch (ev.type) {
        case "message.delta":
          if ((ev.role || "assistant") === "assistant") {
            assistantDelta.text = ev.text || ((assistantDelta.text || "") + (ev.delta || ""));
            assistantDelta.ts = ev.ts || assistantDelta.ts;
            assistantDelta.model = ev.model || assistantDelta.model;
            assistantDelta.provider = ev.provider || assistantDelta.provider;
          }
          break;
        case "message.end":
          out.push(makeBlock("text", {
            role: ev.role || "assistant",
            text: ev.text || assistantDelta.text || "",
            attachments: ev.attachments || [],
            quickAction: ev.quickAction || null, // ribbon 快捷指令：回放折叠成操作盒子
            model: ev.model || assistantDelta.model || "",
            provider: ev.provider || assistantDelta.provider || "",
            elapsedMs: ev.elapsedMs,
            ts: ev.ts || Date.now()
          }));
          assistantDelta.text = "";
          break;
        case "reasoning.delta":
          reasoningDelta.text = ev.text || ((reasoningDelta.text || "") + (ev.delta || ""));
          reasoningDelta.ts = ev.ts || reasoningDelta.ts;
          break;
        case "reasoning.end":
          out.push(makeBlock("reasoning", {
            text: ev.text || reasoningDelta.text || "",
            provider: ev.provider || "",
            model: ev.model || "",
            ts: ev.ts || Date.now()
          }));
          reasoningDelta.text = "";
          break;
        case "tool.start":
          out.push(makeBlock("tool-call", {
            name: getToolName(ev),
            args: ev.tool?.args || {},
            toolId: ev.tool?.id || ev.id || "",
            provider: ev.provider || "",
            model: ev.model || "",
            ts: ev.ts || Date.now()
          }));
          break;
        case "tool.end":
          out.push(makeBlock("tool-result", {
            name: getToolName(ev),
            result: ev.tool?.result || ev.result || { ok: false, error: "missing result" },
            toolId: ev.tool?.id || ev.id || "",
            provider: ev.provider || "",
            model: ev.model || "",
            ts: ev.ts || Date.now()
          }));
          break;
        case "source.add":
          out.push(makeBlock("source", { source: ev.source || {}, ts: ev.ts || Date.now() }));
          break;
        case "attachment.add":
          out.push(makeBlock("file", { attachment: ev.attachment || {}, ts: ev.ts || Date.now() }));
          break;
        case "status":
          out.push(makeBlock("status", {
            status: ev.status || "",
            text: ev.text || "",
            data: ev.data,
            ts: ev.ts || Date.now()
          }));
          break;
        case "error":
          out.push(makeBlock("error", {
            error: ev.error || { message: ev.message || "Unknown error" },
            ts: ev.ts || Date.now()
          }));
          break;
        default:
          break;
      }
    });

    if (assistantDelta.text) {
      out.push(makeBlock("text", {
        role: "assistant",
        text: assistantDelta.text,
        model: assistantDelta.model,
        provider: assistantDelta.provider,
        ts: assistantDelta.ts || Date.now()
      }));
    }
    if (reasoningDelta.text) {
      out.push(makeBlock("reasoning", {
        text: reasoningDelta.text,
        ts: reasoningDelta.ts || Date.now()
      }));
    }
    return out;
  }

  global.WpsAiChatBlocks = { fromEvents };
})(window);
