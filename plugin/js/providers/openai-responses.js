(function attachOpenAIResponsesProvider(global) {
  "use strict";

  // 通用 OpenAI Responses API（POST /v1/responses）——用普通 API Key + baseUrl 接入，
  // 不走 codex.js 那套 ChatGPT OAuth。响应是 SSE 事件流（response.*），和 chat/completions 不同。
  // 事件解析整体沿用 codex.js 的成熟实现，另外补上 reasoning 流式回显（codex 里被忽略了）。

  function proxyForwardPrefix() {
    return (global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/");
  }

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("请在设置中填写 OpenAI Responses 服务的 Base URL。");
    }
    if (config.useProxy === false) return base;
    return proxyForwardPrefix() + encodeURIComponent(base);
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey) {
      throw new Error("请在设置中填写 API Key。");
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    };
    if (stream) headers.Accept = "text/event-stream";
    return headers;
  }

  function splitMessages(messages) {
    const systemPrompt = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const inputMessages = messages.filter((m) => m.role !== "system");
    return { systemPrompt, inputMessages };
  }

  // OpenAI/app.js 风格 part → Responses API 风格（input_text / input_image / input_file）。
  function normalizeContent(content) {
    if (content == null) return [{ type: "input_text", text: "" }];
    if (typeof content === "string") return [{ type: "input_text", text: content }];
    if (!Array.isArray(content)) return [{ type: "input_text", text: String(content) }];
    return content.map((part) => {
      if (!part || typeof part !== "object") return { type: "input_text", text: String(part) };
      if (part.type === "text") return { type: "input_text", text: part.text || "" };
      if (part.type === "image_url" && part.image_url?.url) {
        return { type: "input_image", image_url: part.image_url.url };
      }
      if (part.type === "file" && part.file) {
        if (part.file.file_id) return { type: "input_file", file_id: part.file.file_id };
        if (part.file.file_data) {
          return { type: "input_file", filename: part.file.filename || "file.pdf", file_data: part.file.file_data };
        }
      }
      return part; // 已是 Responses 原生形态：直传
    });
  }

  function toResponseInput(messages) {
    return messages.map((m) => ({ role: m.role, content: normalizeContent(m.content) }));
  }

  function getResponseText(payload) {
    if (payload.output_text) return payload.output_text;
    return (payload.output || [])
      .flatMap((item) => item.content || [])
      .map((c) => c.text || "")
      .join("");
  }

  function fallbackModels() {
    return ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1", "o4-mini"];
  }

  function normalizeModelIds(payload) {
    const source = Array.isArray(payload) ? payload : (payload.data || payload.models || []);
    return source
      .map((m) => (typeof m === "string" ? m : m.id || m.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function createResponsesProvider(config) {
    const base = () => resolveBase(config);
    const responsesUrl = () => `${base()}/responses`;

    // 思考参数：Responses 用 reasoning.effort，与 codex 同族。开思考时额外要 summary:"auto"
    // 才会流式吐 reasoning_summary_text，否则拿不到可回显的思考文本。
    function thinkingBody(model, thinkingLevel) {
      const tp = global.WpsAiCapabilities?.buildThinkingParams("openai-responses", thinkingLevel, model);
      if (!tp?.reasoning) return null;
      return { reasoning: Object.assign({ summary: "auto" }, tp.reasoning) };
    }

    return {
      type: "openai-responses",
      label: config.label || "OpenAI Responses",
      defaultModel: config.defaultModel || "gpt-5.1",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey) throw new Error("请在设置中填写 API Key。");
        if (!config.baseUrl) throw new Error("请在设置中填写 Base URL。");
      },

      async listModels() {
        const response = await fetch(`${base()}/models`, { method: "GET", headers: buildHeaders(config) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `获取模型列表失败：${response.status}`);
        }
        const models = normalizeModelIds(payload);
        if (models.length === 0) throw new Error("模型接口返回空列表");
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages }) {
        const { systemPrompt, inputMessages } = splitMessages(messages);
        const body = {
          model, store: false, stream: false,
          instructions: systemPrompt,
          input: toResponseInput(inputMessages)
        };
        const response = await fetch(responsesUrl(), {
          method: "POST", headers: buildHeaders(config), body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || `请求失败：${response.status}`);
        try {
          const u = payload.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "openai-responses", model, input: u.input_tokens, output: u.output_tokens });
        } catch (e) {}
        return getResponseText(payload);
      },

      async streamChat({ model, messages, onToken, onActivity, signal }) {
        const { systemPrompt, inputMessages } = splitMessages(messages);
        const body = {
          model, store: false, stream: true,
          instructions: systemPrompt,
          input: toResponseInput(inputMessages)
        };
        const response = await fetch(responsesUrl(), {
          method: "POST", headers: buildHeaders(config, { stream: true }), body: JSON.stringify(body), signal
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        let usage = null;
        await global.WpsAiSse.readSse(response, (eventType, payload) => {
          if (!payload) return;
          const t = eventType || payload.type;
          if (t === "response.output_text.delta") {
            const token = payload.delta || "";
            if (token) { fullText += token; onToken?.(token, fullText); }
            return;
          }
          if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
            if (typeof payload.delta === "string" && payload.delta) onActivity?.(payload.delta);
            return;
          }
          if (t === "response.completed") {
            const u = payload.response?.usage;
            if (u) usage = u;
          }
        });
        try {
          if (usage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai-responses", model, input: usage.input_tokens, output: usage.output_tokens });
        } catch (e) {}
        return fullText;
      },

      /**
       * Responses API 流式 tool-use 循环。关键事件：
       *   response.output_text.delta             → 正文增量
       *   response.reasoning_summary_text.delta  → 思考摘要增量（codex 忽略了，这里回显）
       *   response.output_item.added             → 新输出项（function_call 等）
       *   response.function_call_arguments.delta → 工具参数 JSON 片段（按 item_id 累积）
       *   response.completed                     → 完整 output 数组 + usage
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, signal, thinkingLevel }) {
        const { systemPrompt, inputMessages } = splitMessages(messages);
        const inputItems = toResponseInput(inputMessages);
        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toCodexToolSpec(def));
        const tp = thinkingBody(model, thinkingLevel);

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = {
            model, store: false, stream: true,
            instructions: systemPrompt,
            input: inputItems,
            tool_choice: "auto",
            parallel_tool_calls: true
          };
          if (toolSpecs.length > 0) body.tools = toolSpecs;
          if (tp) Object.assign(body, tp);

          const response = await fetch(responsesUrl(), {
            method: "POST", headers: buildHeaders(config, { stream: true }), body: JSON.stringify(body), signal
          });
          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || `请求失败：${response.status}`);
          }

          let fullText = "";
          let reasoningText = "";
          const fnCallByItemId = {}; // item_id → { call_id, name, argumentsAcc }
          let completedOutput = [];
          let completedUsage = null;

          await global.WpsAiSse.readSse(response, async (eventType, payload) => {
            if (!payload) return;
            const t = eventType || payload.type;
            switch (t) {
              case "response.output_text.delta": {
                if (typeof payload.delta === "string" && payload.delta.length > 0) {
                  fullText += payload.delta;
                  await onEvent?.({ type: "assistant_chunk", delta: payload.delta, fullText });
                }
                break;
              }
              case "response.reasoning_summary_text.delta":
              case "response.reasoning_text.delta": {
                if (typeof payload.delta === "string" && payload.delta.length > 0) {
                  reasoningText += payload.delta;
                  await onEvent?.({ type: "reasoning_chunk", delta: payload.delta, fullText: reasoningText });
                }
                break;
              }
              case "response.output_item.added": {
                const item = payload.item;
                if (item?.type === "function_call") {
                  fnCallByItemId[item.id] = { call_id: item.call_id || item.id, name: item.name, argumentsAcc: "" };
                }
                break;
              }
              case "response.function_call_arguments.delta": {
                const slot = fnCallByItemId[payload.item_id];
                if (slot && typeof payload.delta === "string") slot.argumentsAcc += payload.delta;
                break;
              }
              case "response.completed": {
                completedOutput = payload.response?.output || [];
                const u = payload.response?.usage;
                if (u) completedUsage = u;
                break;
              }
              default:
                break;
            }
          });

          try {
            if (completedUsage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai-responses", model, input: completedUsage.input_tokens, output: completedUsage.output_tokens });
          } catch (e) {}

          // 思考收尾（在正文收尾之前发，和 openai.js 一致：turnEvents 里 reasoning 排在 assistant 前）
          if (reasoningText) await onEvent?.({ type: "reasoning_end", text: reasoningText });

          const usedCompleted = completedOutput.length > 0;
          if (usedCompleted) {
            for (const item of completedOutput) inputItems.push(item);
          }

          if (fullText) await onEvent?.({ type: "assistant_text_end", text: fullText });

          let functionCalls = completedOutput.filter((it) => it.type === "function_call");
          if (functionCalls.length === 0 && Object.keys(fnCallByItemId).length > 0) {
            functionCalls = Object.values(fnCallByItemId).map((slot) => ({
              call_id: slot.call_id, name: slot.name, arguments: slot.argumentsAcc
            }));
            // response.completed 缺失时补齐 assistant 文本 + function_call 项，保持和 function_call_output 配对，避免下一轮 400。
            if (!usedCompleted) {
              if (fullText) inputItems.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] });
              for (const fc of functionCalls) {
                inputItems.push({ type: "function_call", call_id: fc.call_id, name: fc.name, arguments: fc.arguments || "" });
              }
            }
          }

          if (functionCalls.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          for (const call of functionCalls) {
            // 让出宏任务：连续同步 COM（Excel）下 await 只排微任务，「停止」点击派发不出来。见 openai.js 同注。
            await new Promise((r) => setTimeout(r, 0));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(call.arguments || "{}"); } catch (e) { parsedArgs = {}; }
            const callId = call.call_id || call.id;
            await onEvent?.({ type: "tool_call", id: callId, name: call.name, args: parsedArgs });

            const decision = approveTool ? await approveTool({ id: callId, name: call.name, args: parsedArgs }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(call.name, parsedArgs, { signal });
            }
            await onEvent?.({ type: "tool_result", id: callId, name: call.name, result });

            inputItems.push({
              type: "function_call_output",
              call_id: callId,
              output: global.WpsAiToolRegistry.serializeResult(result)
            });
          }
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}）。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("openai-responses", createResponsesProvider);
})(window);
