(function attachMaterialTagger(global) {
  "use strict";

  // 素材内容打标：生成图用 prompt 走文本 chat；本地/网络图走视觉模型。best-effort，失败返回 []。
  // 解析逻辑 parseTagsReply 为纯函数、可单测；网络调用可注入 opts.chat 以便测试。

  const SYSTEM_PROMPT = "你是图像内容打标助手。只输出 3-6 个简洁的中文内容标签，用逗号分隔，不要任何解释、前缀或标点以外的内容。";

  function normalizeTags(input) {
    const M = global.WpsAiMaterialLibrary;
    if (M && typeof M.normalizeTags === "function") return M.normalizeTags(input);
    // 兜底（正常运行时 material-library 已加载）
    const arr = Array.isArray(input) ? input : String(input || "").split(/[,，、;；]+/);
    const seen = new Set(); const out = [];
    arr.map((t) => String(t == null ? "" : t).trim()).forEach((t) => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } });
    return out.slice(0, 12);
  }

  // 把模型回复清洗成标签数组：去掉「标签：」等前缀、项目符号/序号/引号，换行当分隔符，最多 8 个。
  function parseTagsReply(text) {
    let s = String(text || "").trim();
    s = s.replace(/^(标签|tags?|关键词|如下|以下[^:：]*)[:：]\s*/i, "");
    s = s.replace(/["'`#]/g, "");
    // 先按行去掉项目符号/序号（此时换行还在，^ 的 m 标志能逐行匹配），再把换行/竖线当分隔符。
    // 只在“数字后跟 . ) 、”时当序号删，避免把 "3D" "2K" "5G" 这类以数字开头的标签首位数字吞掉。
    s = s.replace(/^\s*(?:[-*·]|\d+[.)、])\s*/gm, "");
    s = s.replace(/[|\n\r]+/g, "，");
    return normalizeTags(s).slice(0, 8);
  }

  function currentModel() {
    try {
      const reg = global.WpsAiProviderRegistry;
      const cfg = reg.getActiveConfig();
      return cfg.defaultModel || reg.loadSettings().activeChatModel || "";
    } catch (e) { return ""; }
  }

  function currentProviderId() {
    try {
      return global.WpsAiProviderRegistry.getActiveConfig().id || "";
    } catch (e) { return ""; }
  }

  async function defaultChat(messages) {
    const reg = global.WpsAiProviderRegistry;
    const cfg = reg.getActiveConfig();
    const provider = reg.buildProvider(cfg);
    const model = cfg.defaultModel || reg.loadSettings().activeChatModel;
    return await provider.chat({ model, messages });
  }

  // opts: { prompt?, dataUrl?, url?, chat? } → Promise<string[]>
  async function tagImage(opts) {
    const o = opts || {};
    const chat = typeof o.chat === "function" ? o.chat : defaultChat;
    try {
      let messages;
      const sys = { role: "system", content: SYSTEM_PROMPT };
      if (o.prompt) {
        messages = [sys, { role: "user", content: "根据这段配图描述生成内容标签：" + String(o.prompt) }];
      } else if (o.dataUrl || o.url) {
        const model = currentModel();
        if (!global.WpsAiCapabilities?.getCapabilities?.(model, currentProviderId())?.image) return [];
        messages = [sys, { role: "user", content: [
          { type: "text", text: "为这张图片生成内容标签" },
          { type: "image_url", image_url: { url: o.dataUrl || o.url } }
        ] }];
      } else {
        return [];
      }
      const reply = await chat(messages);
      return parseTagsReply(reply);
    } catch (e) {
      return [];
    }
  }

  global.WpsAiMaterialTagger = { tagImage, parseTagsReply };
})(window);
