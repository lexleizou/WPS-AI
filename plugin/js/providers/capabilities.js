(function attachCapabilities(global) {
  "use strict";

  // 模型能力检测：根据 model id 模式判断
  //   image:    多模态图像输入
  //   pdf:      原生 PDF 附件支持
  //   thinking: 深度思考 / reasoning（可调强度的）
  //
  // 命名约定按各家命名风格 + 通用关键字兜底。新模型默认不识别 → 保守返回 false，
  // 用户可以在 UI 里手动覆盖（未实现）。

  function lc(s) { return String(s || "").toLowerCase(); }

  const capabilityOverrides = new Map();

  function overrideKey(providerId, modelId) {
    return `${lc(providerId)}::${lc(modelId)}`;
  }

  function coerceOverrideCapabilities(cap) {
    if (!cap || typeof cap !== "object") return null;
    const out = {};
    ["image", "pdf", "thinking", "tools"].forEach((key) => {
      if (typeof cap[key] === "boolean") out[key] = cap[key];
    });
    return Object.keys(out).length ? out : null;
  }

  function setCapabilityOverride(providerId, modelId, cap) {
    const normalized = coerceOverrideCapabilities(cap);
    if (!modelId || !normalized) return;
    capabilityOverrides.set(overrideKey(providerId || "", modelId), normalized);
  }

  // 清掉某个具体覆盖（手动「重置为自动判断」用）。cap 传单个键则只清该键，否则整条清。
  function clearCapabilityOverride(providerId, modelId, capKey) {
    const key = overrideKey(providerId || "", modelId);
    if (!capKey) { capabilityOverrides.delete(key); return; }
    const cur = capabilityOverrides.get(key);
    if (!cur) return;
    const next = Object.assign({}, cur);
    delete next[capKey];
    if (Object.keys(next).length) capabilityOverrides.set(key, next);
    else capabilityOverrides.delete(key);
  }

  function setCapabilityOverrides(providerId, records) {
    (records || []).forEach((record) => {
      if (!record || typeof record !== "object") return;
      setCapabilityOverride(providerId, record.modelId || record.id || record.name, record.capabilities || record);
    });
  }

  // 合并全局与供应商专属覆盖，专属按键胜出。这样能分层叠加：
  //   models.dev 目录用全局键("")铺满 image/pdf/tools/thinking；
  //   用户手动改 / 从错误学到的用供应商专属键，只覆盖其中某一项，其余仍取全局。
  // （若专属完全替换全局，手动只改 image 就会丢掉 models.dev 的 pdf/tools/thinking。）
  function getCapabilityOverride(modelId, providerId) {
    if (!modelId) return null;
    const globalHit = capabilityOverrides.get(overrideKey("", modelId));
    const specificHit = providerId ? capabilityOverrides.get(overrideKey(providerId, modelId)) : null;
    if (!globalHit && !specificHit) return null;
    return Object.assign({}, globalHit, specificHit);
  }

  function supportsImage(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    return /(^|[-_/])(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o|chatgpt-5)/.test(s)
      || /(^|[-_/])(o3|o4)([-_]|$)/.test(s)
      || /(claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku)/.test(s)
      || /(gemini.*(pro|flash|vision))/.test(s)
      || /(qwen.*(vl|vision)|qwen3\.5|qwen35)/.test(s)
      || /(deepseek.*(vl|vision|v4))/.test(s)
      // Kimi：K2 及更早是纯文本、视觉走单独的 kimi-vl；K3（2026-07 起）原生多模态，
      // 之后的 K 系默认多模态。匹配 kimi-vl + kimi-k3 及以上（不含 k2，避免误报纯文本）。
      || /(yi-?vision|moonshot-?v1-?vision|glm-4v|kimi-vl|kimi-k([3-9]|\d{2,}))/.test(s)
      || /(vision|multimodal|-vl-|-vl$)/.test(s);
  }

  // PDF 附件支持（白名单，按已验证的协议级支持来）
  //   Anthropic Claude 3.5+ / 4 系：document content block 原生
  //   OpenAI 官方 gpt-4o / gpt-4.1 / gpt-5 / o3+：Files API
  //   Gemini 1.5+ / 2：inline_data 或 file_data
  //   Codex Responses API：input_file 原生
  //
  // 注意：DeepSeek / Kimi / Qwen-VL / GLM-4V 这些 OpenAI 兼容服务的多模态能力
  //       目前仅限 image_url（图片）。它们 chat completions 不接受 type:"file"
  //       内容部分（DeepSeek 会回 "unknown variant `file`, expected `text`"）。
  //       这些模型用户要处理 PDF 得走 Claude / GPT-4o / Codex 等。
  function supportsPdf(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    // Anthropic Claude 3.5+ / 3.7 / 4
    if (/claude-3-5|claude-3\.5|claude-3-7|claude-3\.7|claude-(opus|sonnet|haiku)-[345]|claude-[45]/.test(s)) return true;
    // OpenAI 4o / 4.1 / 5 / o3 / o4
    if (/(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|chatgpt-5)/.test(s)) return true;
    if (/(^|[-_/])(o3|o4)([-_]|$)/.test(s)) return true;
    // Gemini 1.5+ / 2.x
    if (/gemini-(1\.5|2)/.test(s)) return true;
    // 显式带 pdf / document 标签的（少数厂商命名）
    if (/[-_](pdf|document)([-_]|$)/.test(s)) return true;
    return false;
  }

  // 深度思考 / reasoning 支持
  // OpenAI：o1, o3, o4, gpt-5 系列原生 reasoning
  // Anthropic：claude-3-7-sonnet 起（extended thinking）、claude-4 系列
  // DeepSeek：deepseek-reasoner / deepseek-r1 / v4 reasoning
  // Qwen：qwq / qwen-3 thinking
  // 通过模型名识别，命中即视为支持
  function supportsThinking(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    if (/(^|[-_/])o[134]([-_]|$)/.test(s)) return true;
    if (/gpt-5/.test(s)) return true;
    if (/claude-3-7|claude-3\.7|claude-(opus|sonnet)-[45]|claude-[45].*sonnet|claude-[45].*opus/.test(s)) return true;
    if (/deepseek-(reasoner|r1)|deepseek.*-r\d|deepseek.*think/.test(s)) return true;
    if (/qwq|qwen.*think|qwen[-_]?3|qwen3(\.|:|$)|qwen35/.test(s)) return true;
    if (/minicpm5/.test(s)) return true;
    if (/gemini-2\.5|gemini-.*think|gemini-2\.0-flash-thinking/.test(s)) return true;
    if (/thinking|reasoning|reasoner/.test(s)) return true;
    return false;
  }

  // 工具调用 / function calling 支持
  // 默认 true（绝大多数 chat 模型都支持），明确不支持的走 denylist：
  //   - DeepSeek R1 / deepseek-reasoner 系: 官方明确不支持 function calling
  //   - 早期开源模型: llama-2 / mistral-7b-base / qwen 1.x (没经过 function-call 微调)
  //   - 纯 reasoning 模型经常砍掉 tools 接口
  //
  // 命中 denylist 时 chat 入口会:
  //   1) 弹一条 ai-err 提示「当前模型不支持工具调用，AI 无法直接读写文档」
  //   2) 跳过 tools 入参，避免某些 provider 报 400 invalid_function_parameters
  //   3) 用户仍能跟 AI 普通聊天 / 让 AI 输出指令让用户手动操作
  function supportsTools(modelId) {
    const s = lc(modelId);
    if (!s) return true; // 没填默认 true 让用户试
    // DeepSeek 推理系列：reasoner / R1 / R1-distill / R1-zero 全砍掉 tools
    if (/deepseek-(reasoner|r\d|r-?\d|think)/.test(s)) return false;
    if (/(^|[-_/])r1([-_]|$)|r1-distill|r1-zero/.test(s)) return false;
    // 通用纯推理标识
    if (/\b(reasoner|reasoning-only)\b/.test(s)) return false;
    // Qwen QwQ (纯推理预览): 早期版本无 tools
    if (/qwq-32b-preview|qwq-preview/.test(s)) return false;
    // 早期开源 base 模型（未 instruct/chat 调）
    if (/llama-?2(?!.*chat)|llama-?3(?!.*instruct)/.test(s)) return false;
    if (/(^|[-_/])(mistral-7b|mistral-tiny|mixtral-8x7b)(?!.*instruct)/.test(s)) return false;
    if (/qwen-?1\.|qwen-?7b(?!.*chat)/.test(s)) return false;
    // gpt-3.5-turbo-instruct (completions only, 没 chat / tools 接口)
    if (/gpt-3\.5-turbo-instruct/.test(s)) return false;
    // 其他默认认为支持，让 provider 真错了用户能拿到 400 错误明白
    return true;
  }

  // 返回完整能力快照
  function getCapabilities(modelId, providerId) {
    return Object.assign({
      image: supportsImage(modelId),
      pdf: supportsPdf(modelId),
      thinking: supportsThinking(modelId),
      tools: supportsTools(modelId)
    }, getCapabilityOverride(modelId, providerId) || {});
  }

  // 给定 provider 类型 + 用户选的 thinking level（low/medium/high），返回该 provider
  // 对应 API 应该传的参数对象。runWithTools 拿这个塞进 body。
  // 未启用 thinking → 返回 null
  function buildThinkingParams(providerType, level, modelId) {
    if (!supportsThinking(modelId)) return null;
    // 关闭思考：不发任何思考参数（之前 "off"/"none" 不在下方白名单里，会被兜底成 "medium"，
    // 导致"关了思考强度反而按 medium 请求思考"）。
    // app 层已把"关闭思考"归一成 null 再传进来（见 app.js runChatTurn：off→null），
    // 所以 falsy 一律视为关闭；显式 off/none/disabled 同样关闭。
    if (!level || level === "off" || level === "none" || level === "disabled") return null;
    const lv = ["low", "medium", "high"].includes(level) ? level : "medium";

    if (providerType === "anthropic") {
      // Anthropic extended thinking: budget_tokens 控制思考长度
      const budget = { low: 1024, medium: 4000, high: 16000 }[lv];
      return { thinking: { type: "enabled", budget_tokens: budget } };
    }

    if (providerType === "openai") {
      // 修 B41：reasoning_effort 只有 OpenAI 官方 o-系列 / gpt-5 认。走 OpenAI 兼容通道接的
      // qwen3 / deepseek-reasoner / vLLM 等虽然名字匹配"思考型"，但塞 reasoning_effort 会被
      // 严格后端 400 拒绝（用户开了深度思考反而无法对话）。只给真正的 OpenAI 推理模型加。
      const m = String(modelId || "").toLowerCase();
      const isOpenAiReasoning = /(^|[/:])o[1345](-|$|\b)/.test(m) || m.includes("gpt-5");
      return isOpenAiReasoning ? { reasoning_effort: lv } : null;
    }

    if (providerType === "codex" || providerType === "openai-responses") {
      // Responses API: reasoning.effort
      return { reasoning: { effort: lv } };
    }

    if (providerType === "gemini") {
      // Gemini thinkingConfig：includeThoughts 拿到思考文本，thinkingBudget 控制思考长度
      const budget = { low: 1024, medium: 8192, high: 24576 }[lv];
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } };
    }

    return null;
  }

  global.WpsAiCapabilities = {
    supportsImage,
    supportsPdf,
    supportsThinking,
    supportsTools,
    getCapabilities,
    getCapabilityOverride,
    setCapabilityOverride,
    setCapabilityOverrides,
    clearCapabilityOverride,
    buildThinkingParams
  };
})(window);
