(function attachAnthropicProvider(global) {
  "use strict";

  function proxyForwardPrefix() {
    return (global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/");
  }

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("请在设置中填写 Anthropic Claude 服务的 Base URL。");
    }
    if (config.useProxy === false) {
      return base;
    }
    return proxyForwardPrefix() + encodeURIComponent(base);
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey) {
      throw new Error("请在设置中填写 Anthropic API Key。");
    }
    const headers = {
      "x-api-key": config.apiKey,
      "anthropic-version": config.anthropicVersion || "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json"
    };
    if (stream) {
      headers.Accept = "text/event-stream";
    }
    return headers;
  }

  function fallbackModels() {
    return [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest"
    ];
  }

  // 把 app.js / OpenAI 风格的 part 转成 Anthropic 风格
  //   { type:'text', text }                                              → 不变
  //   { type:'image_url', image_url:{url}}                               → { type:'image', source:{...} }
  //   { type:'file', file:{file_data:"data:application/pdf;base64,..."}} → { type:'document', source:{...} }
  //   { type:'document', source:{type:'base64',media_type,data}}         → 直传（已经是 Anthropic 原生格式）
  function normalizeAnthropicContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content || "");
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "image_url" && part.image_url?.url) {
        const url = String(part.image_url.url);
        // dataURL → base64 source；http(s) URL → 直接传 URL（Anthropic 也支持）
        const m = /^data:([\w/+\-.]+);base64,(.+)$/i.exec(url);
        if (m) {
          return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
        }
        return { type: "image", source: { type: "url", url } };
      }
      // OpenAI/通用 file 部分（PDF 等）→ Anthropic document
      if (part.type === "file") {
        const fileData = part.file?.file_data || "";
        const m = /^data:([\w/+\-.]+);base64,(.+)$/i.exec(String(fileData));
        if (m) {
          return { type: "document", source: { type: "base64", media_type: m[1], data: m[2] } };
        }
      }
      return part;
    });
  }

  function splitMessages(messages) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: normalizeAnthropicContent(m.content) }));
    return { system, conversation };
  }

  function createAnthropicProvider(config) {
    const base = () => resolveBase(config);

    return {
      type: "anthropic",
      label: config.label || "Anthropic Claude",
      defaultModel: config.defaultModel || "claude-sonnet-4-6",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey) {
          throw new Error("请在设置中填写 Anthropic API Key。");
        }
      },

      async listModels() {
        const url = `${base()}/models`;
        const response = await fetch(url, {
          method: "GET",
          headers: buildHeaders(config)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `获取模型列表失败：${response.status}`);
        }
        const data = Array.isArray(payload.data) ? payload.data : [];
        const models = data
          .map((m) => m.id || m.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        if (models.length === 0) {
          throw new Error("模型接口返回空列表");
        }
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages, maxTokens = 4096, temperature }) {
        const { system, conversation } = splitMessages(messages);
        const url = `${base()}/messages`;
        // 修 B40：透传 temperature。
        const reqBody = {
          model,
          system: system || undefined,
          messages: conversation,
          max_tokens: maxTokens,
          stream: false
        };
        if (typeof temperature === "number" && Number.isFinite(temperature)) reqBody.temperature = temperature;
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config),
          body: JSON.stringify(reqBody)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        try {
          const u = payload.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: u.input_tokens, output: u.output_tokens });
        } catch (e) {}
        return (payload.content || [])
          .filter((block) => block.type === "text")
          .map((block) => block.text || "")
          .join("");
      },

      async streamChat({ model, messages, onToken, maxTokens = 4096, temperature }) {
        const { system, conversation } = splitMessages(messages);
        const url = `${base()}/messages`;
        // 修 B40：透传 temperature。
        const reqBody = {
          model,
          system: system || undefined,
          messages: conversation,
          max_tokens: maxTokens,
          stream: true
        };
        if (typeof temperature === "number" && Number.isFinite(temperature)) reqBody.temperature = temperature;
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config, { stream: true }),
          body: JSON.stringify(reqBody)
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        let inTok = 0, outTok = 0;
        await global.WpsAiSse.readSse(response, (eventType, payload) => {
          if (!payload) return;
          if (eventType === "message_start") { inTok = payload.message?.usage?.input_tokens || inTok; }
          if (eventType === "message_delta") { outTok = payload.usage?.output_tokens || outTok; }
          if (eventType === "content_block_delta") {
            const delta = payload.delta?.text || "";
            if (delta) {
              fullText += delta;
              onToken?.(delta, fullText);
            }
          }
        });
        try {
          if (inTok || outTok) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: inTok, output: outTok });
        } catch (e) {}
        return fullText;
      },

      /**
       * Anthropic 工具调用流式循环。
       * 协议：content_block_start 给出每个块的类型（text / tool_use），
       *      content_block_delta 给 text_delta（文字）或 input_json_delta（工具参数 JSON 片段），
       *      message_delta 给 stop_reason。
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, maxTokens = 4096, signal, thinkingLevel }) {
        const url = `${base()}/messages`;
        const { system, conversation: initial } = splitMessages(messages);

        const conversation = initial.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content
        }));

        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toAnthropicToolSpec(def));
        // extended thinking 启用时 max_tokens 必须大于 budget_tokens，自动抬高
        const thinkingParams = global.WpsAiCapabilities?.buildThinkingParams("anthropic", thinkingLevel, model);
        let effectiveMaxTokens = maxTokens;
        if (thinkingParams?.thinking?.budget_tokens) {
          effectiveMaxTokens = Math.max(maxTokens, thinkingParams.thinking.budget_tokens + 2048);
        }

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = {
            model,
            system: system || undefined,
            messages: conversation,
            max_tokens: effectiveMaxTokens,
            stream: true
          };
          if (toolSpecs.length > 0) body.tools = toolSpecs;
          if (thinkingParams) Object.assign(body, thinkingParams);

          const response = await fetch(url, {
            method: "POST",
            headers: buildHeaders(config, { stream: true }),
            body: JSON.stringify(body),
            signal
          });

          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || `请求失败：${response.status}`);
          }

          const blockAcc = []; // index → {type, text|tool_use|thinking accumulator}
          let stopReason = null;
          let fullText = "";
          let thinkingText = "";
          let inTok = 0, outTok = 0;

          await global.WpsAiSse.readSse(response, async (eventType, payload) => {
            if (!payload) return;
            const t = eventType || payload.type;

            if (t === "message_start") { inTok = payload.message?.usage?.input_tokens || inTok; }
            if (t === "message_delta") { outTok = payload.usage?.output_tokens || outTok; }

            if (t === "content_block_start") {
              const idx = payload.index ?? 0;
              const block = payload.content_block || {};
              if (block.type === "text") {
                blockAcc[idx] = { type: "text", text: "" };
              } else if (block.type === "tool_use") {
                blockAcc[idx] = { type: "tool_use", id: block.id, name: block.name, inputJson: "" };
              } else if (block.type === "thinking") {
                blockAcc[idx] = { type: "thinking", thinking: "", signature: block.signature || "" };
              } else if (block.type === "redacted_thinking") {
                blockAcc[idx] = { type: "redacted_thinking", data: block.data || "" };
              }
              return;
            }

            if (t === "content_block_delta") {
              const idx = payload.index ?? 0;
              const delta = payload.delta || {};
              const block = blockAcc[idx];
              if (!block) return;

              if (delta.type === "text_delta" && typeof delta.text === "string") {
                block.text = (block.text || "") + delta.text;
                fullText += delta.text;
                await onEvent?.({ type: "assistant_chunk", delta: delta.text, fullText });
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                block.inputJson = (block.inputJson || "") + delta.partial_json;
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                block.thinking = (block.thinking || "") + delta.thinking;
                thinkingText += delta.thinking;
                await onEvent?.({ type: "reasoning_chunk", delta: delta.thinking, fullText: thinkingText });
              } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
                block.signature = (block.signature || "") + delta.signature;
              }
              return;
            }

            if (t === "message_delta") {
              if (payload.delta?.stop_reason) {
                stopReason = payload.delta.stop_reason;
              }
            }
          });

          try {
            if (inTok || outTok) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: inTok, output: outTok });
          } catch (e) {}

          if (thinkingText) {
            await onEvent?.({ type: "reasoning_end", text: thinkingText });
          }

          // 把累积块还原成 Anthropic 格式的 content 数组，回写到 conversation
          // thinking 块必须保留（包括 signature），下轮请求带回；否则 Anthropic 报错
          const contentBlocks = blockAcc.filter(Boolean).map((b) => {
            // 修 B24：空 text 块会被 Anthropic 报 400（text content blocks must be non-empty）。
            // 模型偶尔发一个空 text 块再接 tool_use，或流被截断，都会产生空块，这里丢掉。
            if (b.type === "text") return b.text ? { type: "text", text: b.text } : null;
            if (b.type === "tool_use") {
              let input = {};
              try { input = JSON.parse(b.inputJson || "{}"); } catch (e) { input = {}; }
              return { type: "tool_use", id: b.id, name: b.name, input };
            }
            if (b.type === "thinking") return { type: "thinking", thinking: b.thinking || "", signature: b.signature || "" };
            if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data || "" };
            return null;
          }).filter(Boolean);

          // 修 B24：content 为空数组同样会被下一轮请求 400 拒绝，此时不回写这条 assistant 消息。
          if (contentBlocks.length > 0) {
            conversation.push({ role: "assistant", content: contentBlocks });
          }

          if (fullText) {
            await onEvent?.({ type: "assistant_text_end", text: fullText });
          }

          const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
          if (toolUses.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          const toolResultBlocks = [];
          for (const use of toolUses) {
            // 让出宏任务：连续同步 COM（Excel）下 await 只排微任务，「停止」点击派发不出来。见 openai.js 同注。
            await new Promise((r) => setTimeout(r, 0));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const args = use.input || {};
            await onEvent?.({ type: "tool_call", id: use.id, name: use.name, args });

            const decision = approveTool ? await approveTool({ id: use.id, name: use.name, args }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(use.name, args, { signal });
            }
            await onEvent?.({ type: "tool_result", id: use.id, name: use.name, result });

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: global.WpsAiToolRegistry.serializeResult(result),
              is_error: !result.ok
            });
          }

          conversation.push({ role: "user", content: toolResultBlocks });

          if (stopReason && stopReason !== "tool_use") {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}）。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("anthropic", createAnthropicProvider);
})(window);
