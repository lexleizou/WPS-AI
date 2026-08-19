(function registerTodoTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const STATUSES = new Set(["pending", "in_progress", "completed", "failed", "skipped"]);

  function ensureConversation() {
    const convs = global.WpsAiConversations;
    if (!convs) throw new Error("conversation storage is not ready");
    let id = convs.getCurrentId?.();
    if (!id) {
      convs.createNew?.({ docKey: global.WpsAiApp?.getCurrentDocKey?.() || "" });
      id = convs.getCurrentId?.();
    }
    if (!id) throw new Error("failed to create conversation");
    return id;
  }

  function cleanStatus(status) {
    const s = String(status || "").trim();
    return STATUSES.has(s) ? s : "pending";
  }

  function cleanTodo(item, index) {
    const src = item && typeof item === "object" ? item : {};
    const title = String(src.title || src.text || src.content || "").trim().slice(0, 200);
    if (!title) return null;
    return {
      id: String(src.id || `todo-${index + 1}`),
      title,
      status: cleanStatus(src.status),
      detail: src.detail != null ? String(src.detail).slice(0, 1000) : "",
      updatedAt: Date.now()
    };
  }

  registry.registerTool({
    name: "todo_replace_all",
    hosts: ["*"],
    internal: true,
    description: "Replace the persistent task todo list for the current conversation. Use this before starting long or multi-step tasks.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
              id: { type: "string", description: "Stable id, such as todo-1." },
              title: { type: "string", description: "Short user-visible task title." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "skipped"] },
              detail: { type: "string", description: "Optional short note." }
            }
          }
        },
        source: { type: "string", description: "Why this list was created, e.g. long_task." }
      }
    },
    handler(args) {
      const convs = global.WpsAiConversations;
      const conversationId = ensureConversation();
      const todos = (Array.isArray(args.todos) ? args.todos : [])
        .map(cleanTodo)
        .filter(Boolean);
      if (!todos.length) throw new Error("todos cannot be empty");
      convs.setConversationTodos?.(conversationId, todos, { enabled: true, source: args.source || "long_task" });
      return { conversationId, todos };
    }
  });

  registry.registerTool({
    name: "todo_patch",
    hosts: ["*"],
    internal: true,
    description: "Update one item in the persistent task todo list for the current conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Todo id to update." },
        title: { type: "string", description: "Optional new title." },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "skipped"] },
        detail: { type: "string", description: "Optional progress or failure note." }
      }
    },
    handler(args) {
      const convs = global.WpsAiConversations;
      const conversationId = ensureConversation();
      const patch = {};
      if (args.title != null) patch.title = args.title;
      if (args.status != null) patch.status = cleanStatus(args.status);
      if (args.detail != null) patch.detail = args.detail;
      const ok = convs.patchConversationTodo?.(conversationId, args.id, patch);
      if (!ok) throw new Error(`todo not found: ${args.id}`);
      return convs.getConversationTodos?.(conversationId) || { todos: [] };
    }
  });
})(window);
