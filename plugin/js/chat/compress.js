// WpsAiChatCompress：长对话自动摘要压缩（纯逻辑，模型调用和持久化由 app.js 负责）。
//
// 思路：对话超过阈值后，把「早期轮次」压成一段滚动摘要（与旧摘要合并），
// 发给模型的消息 = system(附摘要块) + 最近 KEEP_RECENT 条原文。
//   - UI 与 conversations 存储始终保留全量历史，压缩只影响发给模型的内容
//   - 摘要状态 { summary, upTo } 挂在对话记录上（upTo = 已被摘要覆盖的消息数），
//     切换对话/重开 WPS 后随对话恢复，索引与 messages 数组对齐
//   - 摘要生成失败 → 保持原样全量发送，下轮再试，绝不阻塞主流程
(function attachChatCompress(global) {
  "use strict";

  const TRIGGER_MSGS = 24;     // 未压缩部分超过 24 条消息（约 12 轮）触发
  const TRIGGER_CHARS = 50000; // 或未压缩部分文本超 5 万字符触发（长文粘贴场景）
  const KEEP_RECENT = 12;      // 摘要不覆盖最近 12 条——「最近几次聊天」始终原文直达模型
  const SUMMARY_LIMIT = 2400;  // 摘要长度上限（字符）

  // P0-2 预算分级（参考察元 buildContextBudgetPlan）：对话总量越大，压得越狠——
  // 触发阈值降低、保留原文条数收紧、摘要上限缩短。按整段历史（含已压缩部分）分档。
  const BUDGET_LEVELS = [
    // tight：对话已经很重，激进压缩
    { level: "tight", minChars: 120000, minMsgs: 80, triggerMsgs: 16, triggerChars: 30000, keepRecent: 8, summaryLimit: 1600 },
    // standard：中等体量，适度收紧
    { level: "standard", minChars: 60000, minMsgs: 40, triggerMsgs: 20, triggerChars: 40000, keepRecent: 10, summaryLimit: 2000 },
    // balanced：默认档（维持原有阈值）
    { level: "balanced", minChars: 0, minMsgs: 0, triggerMsgs: TRIGGER_MSGS, triggerChars: TRIGGER_CHARS, keepRecent: KEEP_RECENT, summaryLimit: SUMMARY_LIMIT }
  ];

  function budgetFor(history) {
    const list = Array.isArray(history) ? history : [];
    const totalChars = estimateChars(list);
    const n = list.length;
    for (const b of BUDGET_LEVELS) {
      if (totalChars >= b.minChars || n >= b.minMsgs) return b; // balanced 的门槛为 0，兜底必中
    }
    return BUDGET_LEVELS[BUDGET_LEVELS.length - 1];
  }

  // user content 可能是多模态数组（text + image_url + file），只取文本部分
  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && p.type === "text" ? String(p.text || "") : (p && p.type ? `[${p.type}]` : "")))
        .filter(Boolean)
        .join("\n");
    }
    return content == null ? "" : String(content);
  }

  function estimateChars(msgs) {
    let n = 0;
    for (const m of msgs || []) n += textOf(m && m.content).length;
    return n;
  }

  // 是否需要压缩：需要则返回 { start, end, budget }（把 history[start, end) 并入摘要），否则 null。
  // budget 为当前分档（level/keepRecent/summaryLimit），调用方用 budget.summaryLimit 截摘要。
  function plan(history, comp) {
    const list = Array.isArray(history) ? history : [];
    const upTo = Math.max(0, (comp && comp.upTo) | 0);
    const budget = budgetFor(list);
    const pendingCount = list.length - upTo;
    if (pendingCount <= budget.triggerMsgs && estimateChars(list.slice(upTo)) <= budget.triggerChars) return null;
    const end = list.length - budget.keepRecent;
    if (end <= upTo) return null; // 触发了但可压缩区间为空（消息都在"最近"窗口内）
    return { start: upTo, end, budget };
  }

  // 生成摘要请求消息（发给聊天模型，非流式即可）
  function buildSummaryMessages(prevSummary, msgs, lang) {
    const en = lang === "en";
    const lines = (msgs || []).map((m) => {
      const who = m.role === "user" ? (en ? "User" : "用户") : "AI";
      return `${who}: ${textOf(m.content).slice(0, 2000)}`;
    });
    const sys = en
      ? "You compress conversation history. Merge the previous summary (if any) with the new messages into ONE updated summary. Preserve: key facts and numbers, decisions made, document state changes (what the AI wrote/edited), user preferences and constraints, unresolved tasks. Be dense and factual, no pleasantries. Output the summary text only, max 400 words."
      : "你负责压缩对话历史。把旧摘要（如有）与新增消息合并成一份最新摘要。必须保留：关键事实与数字、已做出的决定、文档状态变化（AI 写入/修改了什么）、用户偏好与约束、未完成的任务。写得紧凑客观，不要客套话。只输出摘要正文，不超过 600 字。";
    const user = [
      prevSummary ? (en ? "[Previous summary]\n" : "【旧摘要】\n") + prevSummary : "",
      (en ? "[New messages to merge]\n" : "【需要并入的新消息】\n") + lines.join("\n")
    ].filter(Boolean).join("\n\n");
    return [
      { role: "system", content: sys },
      { role: "user", content: user }
    ];
  }

  // 拼进主 system prompt 的摘要块
  function buildContextBlock(summary, lang) {
    return (lang === "en"
      ? "[Earlier conversation summary — earlier turns were compressed to save context; treat this as established context]\n"
      : "【此前对话摘要——更早的轮次已压缩以节省上下文，请把以下内容当作既有事实】\n") + summary;
  }

  global.WpsAiChatCompress = {
    plan,
    budgetFor,
    textOf,
    estimateChars,
    buildSummaryMessages,
    buildContextBlock,
    TRIGGER_MSGS,
    TRIGGER_CHARS,
    KEEP_RECENT,
    SUMMARY_LIMIT
  };
})(window);
