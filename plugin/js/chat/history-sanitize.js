(function attachChatHistorySanitize(global) {
  "use strict";

  // 跨模型安全边界：一轮对话可由不同模型/供应商接力完成（用户中途切模型、或本轮临时
  // override）。发给模型的历史必须是通用的 {role, content}，绝不能带某一家特有的工具
  // 结构——OpenAI 的 tool_calls / role:"tool" / tool_call_id / function 角色等。否则切到
  // Anthropic 或不支持工具调用的模型时，这些结构会让请求 400 或语义错乱。
  //
  // 正常情况下共享历史本就只存 user/assistant 文本（工具往返只活在 provider
  // runWithTools 的轮内 conversation，不回灌）。这里显式兜底并锁成不变量：
  //   - 只放行 user / assistant / system；tool / function 等供应商特有角色一律丢弃
  //   - 每条只取 role + content，剥掉 tool_calls / tool_call_id / name 等附加字段
  // 这样即便未来有人往历史里塞了工具结构、或加载的旧对话带了这些字段，跨模型也不会崩。
  // 注意：不动 content 本身（字符串或多模态数组都原样保留，交给各 provider 自己归一化），
  // 也不删空 content 的轮（避免破坏 user/assistant 交替——那是 Anthropic 的硬要求）。
  const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

  function sanitizeForModel(history) {
    return (history || [])
      .filter((m) => m && typeof m === "object" && ALLOWED_ROLES.has(m.role))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  global.WpsAiChatHistory = { sanitizeForModel };
})(window);
