(function attachOpenAIProvider(global) {
  "use strict";

  // 端口由 WpsAiRuntime 在启动时探测得出（默认 3890；被占时自动切到 3891.. 上限 20 个）。
  // 这里每次调用都现拿，不缓存模块级常量——因为探测是异步的，模块加载时还可能未完成。
  function proxyForwardPrefix() {
    return (global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/");
  }

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("请在设置中填写 OpenAI 兼容服务的 Base URL。");
    }
    if (config.useProxy === false) {
      return base;
    }
    return proxyForwardPrefix() + encodeURIComponent(base);
  }

  function allowsEmptyApiKey(config) {
    const text = `${config.id || ""} ${config.label || ""} ${config.baseUrl || ""}`.toLowerCase();
    return text.includes("ollama") || /(^|[/:])11434(\/|$)/.test(text);
  }

  function isOllamaConfig(config) {
    const text = `${config.id || ""} ${config.label || ""} ${config.baseUrl || ""}`.toLowerCase();
    return text.includes("ollama") || /(^|[/:])11434(\/|$)/.test(text);
  }

  function ollamaApiBase(config) {
    const raw = String(config.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (!raw) return "";
    return config.useProxy === false ? raw : proxyForwardPrefix() + encodeURIComponent(raw);
  }

  function devLog(tag, message, data) {
    try { global.WpsAiLog?.dev?.(tag, message, data); } catch (e) {}
    if (!global.WpsAiLog?.dev) {
      try { console.log(`[lingxi-dev][${tag}] ${message}`, data || ""); } catch (e) {}
    }
  }

  function isAzureConfig(config) {
    return config && config.type === "azure";
  }

  // Azure OpenAI 的 chat/completions 走「部署名 + api-version」这套 URL，鉴权用 api-key 头（非 Bearer）。
  // 响应体和标准 OpenAI 完全一致，所以只在「请求端」分叉，解析逻辑整段复用。
  function azureApiVersion(config) {
    return config.apiVersion || "2024-10-21";
  }

  // chat/completions 端点（Azure 感知）。Azure 用选中的 model 当部署名（deployment），
  // 也可用 config.deployment 显式覆盖（部署名和模型名不一致时）。
  function chatCompletionsUrl(config, model) {
    const b = resolveBase(config);
    if (isAzureConfig(config)) {
      const dep = encodeURIComponent(config.deployment || model || config.defaultModel || "");
      return `${b}/openai/deployments/${dep}/chat/completions?api-version=${encodeURIComponent(azureApiVersion(config))}`;
    }
    return `${b}/chat/completions`;
  }

  // 流式 delta.content 兼容：绝大多数服务发字符串，但少数网关（含部分 Azure / 聚合器）
  // 把它发成分片数组 [{type:"text",text:"…"}]。不兼容会整段丢字，这里统一压平成字符串。
  function deltaContentToString(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((p) => (typeof p === "string" ? p : (typeof p?.text === "string" ? p.text : ""))).join("");
    }
    return "";
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey && !allowsEmptyApiKey(config)) {
      throw new Error("请在设置中填写 API Key。");
    }
    const headers = {
      "Content-Type": "application/json"
    };
    if (config.apiKey) {
      // Azure OpenAI 用 api-key 头；其余 OpenAI 兼容端点用 Authorization: Bearer。
      if (isAzureConfig(config)) headers["api-key"] = config.apiKey;
      else headers.Authorization = `Bearer ${config.apiKey}`;
    }
    if (stream) {
      headers.Accept = "text/event-stream";
    }
    return headers;
  }

  // 流式请求发送。默认带 stream_options.include_usage（为了 token 统计），
  // 但少数严格校验请求体的 OpenAI 兼容网关不认这个字段会直接回 400，导致对话整个失败。
  // 因此：先带着发；若回 400，去掉 stream_options 重试一次——对话优先，丢失的只是该网关的 token 统计。
  // makeBody(includeUsage, dropToolChoice, dropTemperature) 需返回请求体对象；由调用方决定 model/messages 等其余字段。
  // 严格网关 / 部分模型会拒绝可选参数，400 时按错误信息定向降级重试：
  //   - stream_options.include_usage：老网关不认 stream_options
  //   - tool_choice：DeepSeek 等自带思考模式的模型只接受 auto，强制指定（required /
  //     指定函数）会 400「Thinking mode does not support this tool_choice」。
  //     这类模型不在我们的 thinking 参数控制范围内（buildThinkingParams 对它们返回 null），
  //     思考模式是服务端自己开的，只能从错误里认出来再降级。
  //   - temperature：GPT-5 / o 系列等推理模型只认 temperature=1，传别的值会 400
  //     「invalid temperature: only 1 is allowed for this model」。去掉 temperature
  //     让它用默认值即可（我们本就只是想要更稳定的输出，默认值也能接受）。
  async function postStream(url, config, makeBody, signal) {
    const attempt = (includeUsage, dropToolChoice, dropTemperature) => fetch(url, {
      method: "POST",
      headers: buildHeaders(config, { stream: true }),
      body: JSON.stringify(makeBody(includeUsage, dropToolChoice, dropTemperature)),
      signal
    });
    const response = await attempt(true, false, false);
    if (response.ok || response.status !== 400) return response;

    let errText = "";
    try { errText = await response.clone().text(); } catch (e) {} // clone 不可用 → 按 include_usage 处理
    // 只在错误确实指向某个可选参数时才去掉它。别的 400（密钥错/模型名错）一律走原来的
    // 单次 include_usage 降级——否则每个真错误都要多打几次 API。
    const blamesTemperature = /temperature/i.test(errText)
    const blamesToolChoice = /tool_choice/i.test(errText)
      || (/thinking/i.test(errText) && /tool/i.test(errText));
    // 每个元组：[带 include_usage?, 去掉 tool_choice?, 去掉 temperature?]
    let ladder
    if (blamesTemperature) ladder = [[true, false, true], [false, false, true]]
    else if (blamesToolChoice) ladder = [[true, true, false], [false, true, false]]
    else ladder = [[false, false, false]]
    for (const [usage, dropTc, dropTemp] of ladder) {
      const retry = await attempt(usage, dropTc, dropTemp).catch(() => null);
      if (retry && retry.ok) return retry;
    }
    return response; // 都失败：返回原始响应，让调用方读取原始错误信息
  }

  function fallbackModels() {
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-3.5-turbo"
    ];
  }

  function modelRecordId(m) {
    return typeof m === "string" ? m : (m && (m.id || m.name || m.slug));
  }

  function textOfModelRecord(m) {
    if (typeof m === "string") return m;
    if (!m || typeof m !== "object") return "";
    const parts = [
      m.id, m.name, m.slug, m.type, m.object, m.mode, m.category, m.family,
      m.endpoint, m.endpoints, m.task, m.tasks, m.owned_by, m.description,
      m.modalities, m.input_modalities, m.output_modalities,
      m.capabilities && Object.keys(m.capabilities).filter((k) => m.capabilities[k]).join(" ")
    ];
    return parts.flatMap((x) => Array.isArray(x) ? x : [x]).filter(Boolean).join(" ").toLowerCase();
  }

  function modelNameLooksImage(id) {
    const s = String(id || "").toLowerCase();
    return /\b(dall[-_ ]?e|gpt[-_ ]?image|imagen|imagegen|image[-_ ]?generation|text[-_ ]?to[-_ ]?image|flux|stable[-_ ]?diffusion|sdxl|sd3|midjourney|recraft|ideogram|seedream|jimeng)\b/.test(s);
  }

  function modelNameLooksVideo(id) {
    const s = String(id || "").toLowerCase();
    return /\b(sora|veo|video[-_ ]?generation|text[-_ ]?to[-_ ]?video|runway|kling|pika|hailuo|wan[-_ ]?\d|luma|ray[-_ ]?2)\b/.test(s);
  }

  function recordLooksImage(m) {
    const id = modelRecordId(m);
    const text = textOfModelRecord(m);
    return modelNameLooksImage(id)
      || /(^|\W)(image_generation|image-generation|images\/generations|image_generation_model|text_to_image|text-to-image)(\W|$)/.test(text)
      || (/(\bimage\b|\bimages\b)/.test(text) && !/vision|image[_-]?input|multimodal|vl\b/.test(text) && !/chat|text/.test(text));
  }

  function recordLooksVideo(m) {
    const id = modelRecordId(m);
    const text = textOfModelRecord(m);
    return modelNameLooksVideo(id)
      || /(^|\W)(video_generation|video-generation|videos\/generations|text_to_video|text-to-video)(\W|$)/.test(text)
      || (/\bvideo\b/.test(text) && !/chat|text/.test(text));
  }

  function recordLooksAudioOnly(m) {
    const text = textOfModelRecord(m);
    return /(^|\W)(audio|speech|tts|transcription|whisper)(\W|$)/.test(text)
      && !/chat|text|multimodal/.test(text);
  }

  function recordLooksChat(m) {
    if (recordLooksImage(m) || recordLooksVideo(m) || recordLooksAudioOnly(m)) return false;
    if (typeof m === "string") return true;
    const text = textOfModelRecord(m);
    if (/(^|\W)(chat|chat_completions|chat-completions|messages|text|language|llm)(\W|$)/.test(text)) return true;
    if (/vision|multimodal|vl\b/.test(text) && !recordLooksImage(m) && !recordLooksVideo(m)) return true;
    // 兼容很多 OpenAI-compatible /models 只返回 { id, object:"model" } 的服务。
    return true;
  }

  function normalizeModelIds(payload, kind = "any") {
    const source = Array.isArray(payload)
      ? payload
      : payload.data || payload.models || payload.items || [];
    const filtered = source.filter((m) => {
      if (kind === "chat") return recordLooksChat(m);
      if (kind === "image") return recordLooksImage(m);
      if (kind === "video") return recordLooksVideo(m);
      return true;
    });
    return filtered
      .map(modelRecordId)
      .filter((id) => typeof id === "string")
      .sort((a, b) => a.localeCompare(b));
  }

  function arrayHasCapability(list, name) {
    return (list || []).some((item) => String(item || "").toLowerCase() === name);
  }

  function ollamaShowToCapabilities(payload) {
    const caps = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
    return {
      image: arrayHasCapability(caps, "vision"),
      thinking: arrayHasCapability(caps, "thinking"),
      tools: arrayHasCapability(caps, "tools"),
      pdf: arrayHasCapability(caps, "pdf") || arrayHasCapability(caps, "document")
    };
  }

  async function refreshOllamaCapabilityOverrides(config, models) {
    if (!isOllamaConfig(config) || !models.length) return;
    const root = ollamaApiBase(config);
    if (!root) return;
    const records = await Promise.all(models.map(async (modelId) => {
      try {
        const response = await fetch(`${root}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Ollama /api/show ${response.status}`);
        return { modelId, capabilities: ollamaShowToCapabilities(payload) };
      } catch (error) {
        devLog("ollama.capabilities.error", "failed to read Ollama model capabilities", {
          providerId: config.id,
          model: modelId,
          error: error?.message || String(error)
        });
        return null;
      }
    }));
    global.WpsAiCapabilities?.setCapabilityOverrides?.(config.id || "", records.filter(Boolean));
  }

  global.WpsAiModelFilters = Object.assign({}, global.WpsAiModelFilters || {}, {
    filterChatModels(modelsOrPayload) { return normalizeModelIds(modelsOrPayload, "chat"); },
    filterImageModels(modelsOrPayload) { return normalizeModelIds(modelsOrPayload, "image"); },
    filterVideoModels(modelsOrPayload) { return normalizeModelIds(modelsOrPayload, "video"); },
    classify(model) {
      if (recordLooksImage(model)) return "image";
      if (recordLooksVideo(model)) return "video";
      if (recordLooksAudioOnly(model)) return "audio";
      if (recordLooksChat(model)) return "chat";
      return "unknown";
    }
  });

  // OpenAI chat/completions 引用 PDF 必须先把 base64 上传到 Files API 拿 file_id。
  // 通过本地 proxy /openai-file-upload 走（避免 multipart 在浏览器里手搓）。
  // 缓存：同一份 base64 + provider 只上传一次，复用 file_id。
  const fileIdCache = new Map(); // hash(apiKey+baseUrl+全量base64) → file_id
  // 修 B39：双哈希（两个不同种子）降低碰撞率，且对全量内容取哈希，不再只取前 256 字符。
  function fullHash(s) {
    let h1 = 0x811c9dc5, h2 = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      h1 = (h1 ^ c) * 0x01000193 | 0;
      h2 = (h2 * 31 + c) | 0;
    }
    return ((h1 >>> 0).toString(16)) + (h2 >>> 0).toString(16) + ":" + s.length;
  }

  async function ensureFileId({ config, base64, filename }) {
    // 修 B39：缓存键纳入 apiKey（换账号/换 org 后旧 file_id 会 404/无权限，不能复用），
    // 并对全量 base64 取哈希（旧的只取前 256 字符会让同头部同长度的不同文件命中同一个错误 file_id）。
    const key = (config.baseUrl || "") + "::" + fullHash(config.apiKey || "") + "::" + fullHash(base64);
    if (fileIdCache.has(key)) return fileIdCache.get(key);
    const res = await fetch(global.WpsAiRuntime.proxyUrl("/openai-file-upload"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: (config.baseUrl || "").replace(/\/+$/, ""),
        apiKey: config.apiKey,
        base64, filename: filename || "file.pdf", purpose: "user_data"
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error?.message || payload.error || `上传文件失败：${res.status}`);
    const fileId = payload.id;
    if (!fileId) throw new Error("Files API 未返回 file_id");
    fileIdCache.set(key, fileId);
    return fileId;
  }

  // OpenAI 官方需要走 Files API，其他 OpenAI 兼容服务（DeepSeek/Kimi/Ollama 等）多数没有
  // /v1/files 端点，强行上传会 404。这里按 baseUrl 选路径：
  //   - api.openai.com 域名：上传 → 拿 file_id → 替换 part.file.file_id
  //   - 其他域名：保持 inline file_data，让 provider 自行处理（支持的会消化，不支持的会回 4xx）
  function isOfficialOpenAI(baseUrl) {
    return /(^|\/\/)api\.openai\.com\b/i.test(String(baseUrl || ""));
  }

  async function resolveAttachments(messages, config) {
    const needUpload = isOfficialOpenAI(config.baseUrl);
    const out = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) { out.push(msg); continue; }
      const parts = [];
      for (const part of msg.content) {
        if (needUpload && part?.type === "file" && part.file?.file_data && !part.file.file_id) {
          const m = /^data:application\/pdf;base64,(.+)$/i.exec(String(part.file.file_data));
          if (m) {
            try {
              const fileId = await ensureFileId({ config, base64: m[1], filename: part.file.filename || "file.pdf" });
              parts.push({ type: "file", file: { file_id: fileId } });
              continue;
            } catch (e) {
              // 上传失败（端点 404 / 鉴权问题）→ 降级到 inline file_data，让 provider 直接吃
              console.warn("[openai-compat] Files API 上传失败，降级 inline file_data:", e.message);
            }
          }
        }
        parts.push(part);
      }
      out.push({ ...msg, content: parts });
    }
    return out;
  }

  function normalizeMessagesForChat(messages) {
    return (messages || []).map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      if (msg.content == null) return { ...msg, content: "" };
      return msg;
    });
  }

  function looksLikeUnfinishedToolPlan(text) {
    const s = String(text || "").trim();
    if (!s) return false;
    if (/已(经)?(完成|写入|插入|创建|设置|添加|调整)|完成了|处理好了|操作完成|已为你/i.test(s)) return false;
    const planning = /(我先|先在|准备|接着|然后|最后|下一步|会|将|一次性写入|写入表头|示例数据|格式美化|自动筛选|调整行列|创建.*表格|整理好)/i.test(s);
    const needsTool = /(写入|插入|创建|设置|添加|筛选|格式|美化|调整|表头|数据|工作表|Sheet|单元格|行列|列宽|行高|冻结|边框)/i.test(s);
    return planning && needsTool;
  }

  function buildToolContinuationPrompt(toolSpecs) {
    const available = new Set((toolSpecs || []).map((tool) => String(tool?.function?.name || "")).filter(Boolean));
    const profiles = [
      { prefix: "wps_", label: "WPS 文字", preferred: ["wps_write_table_range", "wps_insert_text", "wps_replace_selection", "wps_format_paragraph"] },
      { prefix: "et_", label: "WPS 表格", preferred: ["et_write_range", "et_format_range", "et_set_autofilter", "et_autofit"] },
      { prefix: "wpp_", label: "WPS 演示", preferred: ["wpp_replace_shape_text", "wpp_add_slide", "wpp_add_text_box", "wpp_apply_theme"] },
      { prefix: "pdf_", label: "WPS PDF", preferred: [] }
    ];
    const profile = profiles.find((entry) => Array.from(available).some((name) => name.startsWith(entry.prefix)));
    const examples = profile ? profile.preferred.filter((name) => available.has(name)).slice(0, 4) : [];
    const hostLabel = profile?.label || "当前宿主";
    if (examples.length) {
      return `你刚才只说明了计划，还没有实际完成。当前宿主是 ${hostLabel}；请继续执行，并且只调用本轮工具清单中确实存在的同宿主工具（例如 ${examples.join("、")}），不要只回复计划文字，也不要提及其他宿主的工具。`;
    }
    return `你刚才只说明了计划，还没有实际完成。当前宿主是 ${hostLabel}。请只使用本轮工具清单中确实存在的同宿主工具继续执行；如果当前轮没有可用的写入工具，请直接说明限制，不要虚构、探测或提及其他宿主的工具。`;
  }

  function textFromMessages(messages) {
    return (messages || []).map((msg) => {
      const c = msg?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
      }
      return "";
    }).join("\n");
  }

  function looksLikeSpreadsheetReadRequest(messages) {
    const s = textFromMessages(messages).toLowerCase();
    if (!s) return false;
    const hasSpreadsheetTool = /et_get_sheet_info|et_read_range|et_write_range|usedrange/i.test(s);
    const hasSheet = hasSpreadsheetTool || /(当前表格|这个表格|表格|工作表|sheet|spreadsheet|excel|单元格|行|列|数据)/i.test(s);
    const hasRead = /(几个|多少|数量|读取|读一下|看一下|分析|总结|检查|解释|统计|识别|告诉我|查看|read|count|how many|analy[sz]e|inspect|summari[sz]e|check)/i.test(s);
    const hasMutation = /(写入|插入|删除|修改|替换|格式|美化|合并|排序|筛选|生成|write|insert|delete|update|format|merge|sort|filter)/i.test(s);
    return hasSheet && hasRead && !hasMutation;
  }

  function extractJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const candidate = fenced ? fenced[1].trim() : raw;
    try { return JSON.parse(candidate); } catch (e) {}
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) {}
    }
    return null;
  }

  function normalizeTaskPlan(value) {
    if (!value || typeof value !== "object") return null;
    const requiredTools = Array.isArray(value.requiredTools)
      ? value.requiredTools.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const requiresSpreadsheetRead = value.requiresSpreadsheetRead === true
      || requiredTools.includes("et_read_range")
      || requiredTools.includes("et_get_sheet_info");
    return {
      taskType: String(value.taskType || "general"),
      requiresTools: value.requiresTools === true || requiredTools.length > 0,
      requiresSpreadsheetRead,
      requiredTools,
      reason: String(value.reason || "")
    };
  }

  async function planToolUse({ url, config, model, conversation, toolSpecs, signal }) {
    if (!toolSpecs.length) return null;
    const toolNames = toolSpecs.map((tool) => tool?.function?.name || "").filter(Boolean);
    const userText = textFromMessages(conversation).slice(-6000);
    const plannerMessages = [
      {
        role: "system",
        content: [
          "You are a task planner for a WPS Office agent.",
          "Return ONLY one JSON object. Do not answer the user.",
          "Decide whether the user task requires tools and which tools must be called before answering.",
          "If the user asks about current spreadsheet/workbook/sheet/cells/data/statistics/counts, set requiresSpreadsheetRead=true and include et_get_sheet_info and et_read_range.",
          "Schema: {\"taskType\":\"general|spreadsheet_qa|spreadsheet_edit|document_qa|document_edit|presentation|other\",\"requiresTools\":boolean,\"requiresSpreadsheetRead\":boolean,\"requiredTools\":[string],\"reason\":\"short\"}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `Available tools: ${toolNames.join(", ")}`,
          "User/context messages:",
          userText
        ].join("\n\n")
      }
    ];
    const body = {
      model,
      messages: plannerMessages,
      stream: false,
      temperature: 0,
      max_tokens: 512
    };
    if (isOllamaConfig(config)) {
      body.options = { temperature: 0, num_predict: 512 };
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(config),
        body: JSON.stringify(body),
        signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `planner ${response.status}`);
      const content = payload.choices?.[0]?.message?.content || "";
      return normalizeTaskPlan(extractJsonObject(content));
    } catch (error) {
      devLog("openai.task_planner.error", "task planner failed; falling back to rule guard", {
        providerId: config.id,
        model,
        error: error?.message || String(error)
      });
      return null;
    }
  }

  function toolResultReminder(toolResults) {
    const names = Array.from(new Set((toolResults || []).map((r) => r.name).filter(Boolean))).join(", ");
    const sheetInfo = (toolResults || []).find((r) => r.name === "et_get_sheet_info" && r.result?.ok && r.result.value);
    const usedRange = sheetInfo?.result?.value?.usedRange || "";
    const sheetName = sheetInfo?.result?.value?.name || "";
    return [
      "上面是工具返回的真实 JSON 结果。",
      names ? `已调用工具：${names}。` : "",
      usedRange ? `下一步如需读取当前表格数据，必须调用 et_read_range，参数：range="${usedRange}"${sheetName ? `，sheet="${sheetName}"` : ""}。` : "",
      "回答必须只基于这些工具结果；不要猜测、不要编造未出现在工具结果里的单元格、行列、字段或数值。",
      "如果工具结果不足以回答用户问题，请继续调用读取类工具补充信息；如果已经足够，请用简洁中文总结。"
    ].filter(Boolean).join("\n");
  }

  function createOpenAIProvider(config) {
    const base = () => resolveBase(config);

    return {
      type: isAzureConfig(config) ? "azure" : "openai",
      label: config.label || (isAzureConfig(config) ? "Azure OpenAI" : "OpenAI 兼容"),
      defaultModel: config.defaultModel || "gpt-4o-mini",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey && !allowsEmptyApiKey(config)) {
          throw new Error("请在设置中填写 API Key。");
        }
        if (!config.baseUrl) {
          throw new Error("请在设置中填写 Base URL。");
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
        const models = normalizeModelIds(payload, "chat");
        if (models.length === 0) {
          throw new Error("模型接口返回空列表");
        }
        await refreshOllamaCapabilityOverrides(config, models);
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages, temperature }) {
        const url = chatCompletionsUrl(config, model);
        const resolved = normalizeMessagesForChat(await resolveAttachments(messages, config));
        // 修 B40：把上层传下来的 temperature 真正带进请求 body（之前被静默丢弃）。
        const send = (dropTemperature) => {
          const body = { model, messages: resolved, stream: false };
          if (!dropTemperature && typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;
          return fetch(url, { method: "POST", headers: buildHeaders(config), body: JSON.stringify(body) });
        };
        let response = await send(false);
        // GPT-5 / o 系列等只认 temperature=1，传别的值 400「invalid temperature: only 1 is
        // allowed for this model」。错误确实指向 temperature 才去掉它重试（见 postStream 同款处理）。
        if (!response.ok && response.status === 400) {
          let errText = "";
          try { errText = await response.clone().text(); } catch (e) {}
          if (/temperature/i.test(errText)) {
            const retry = await send(true).catch(() => null);
            if (retry) response = retry;
          }
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        try {
          const u = payload.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: u.prompt_tokens, output: u.completion_tokens });
        } catch (e) {}
        return payload.choices?.[0]?.message?.content || "";
      },

      async streamChat({ model, messages, onToken, onActivity, temperature, signal }) {
        const url = chatCompletionsUrl(config, model);
        const resolved = normalizeMessagesForChat(await resolveAttachments(messages, config));
        // 修 B40：透传 temperature。include_usage / temperature 由 postStream 负责
        //（严格网关 / 只认 temperature=1 的模型回 400 时自动去掉对应参数重试）。
        const makeBody = (includeUsage, _dropToolChoice, dropTemperature) => {
          const body = { model, messages: resolved, stream: true };
          if (includeUsage) body.stream_options = { include_usage: true };
          if (!dropTemperature && typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;
          return body;
        };
        const response = await postStream(url, config, makeBody, signal);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        let usage = null;
        await global.WpsAiSse.readSse(response, (_eventType, payload) => {
          if (!payload) return;
          if (payload.usage) { usage = payload.usage; return; }
          const deltaObj = payload.choices?.[0]?.delta || {};
          const reasoning = deltaObj.reasoning_content || deltaObj.reasoning || "";
          if (reasoning) onActivity?.(deltaContentToString(reasoning) || String(reasoning));
          const delta = deltaContentToString(deltaObj.content);
          if (delta) {
            fullText += delta;
            onToken?.(delta, fullText);
          }
        });
        try {
          if (usage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: usage.prompt_tokens, output: usage.completion_tokens });
        } catch (e) {}
        return fullText;
      },

      /**
       * Tool-use 流式循环：
       * - 每轮 /chat/completions 用 stream:true，边接收边触发 assistant_chunk 事件
       * - tool_calls 通过 delta 累积（按 index 拼接 name/arguments）
       * - 文本结束时 emit assistant_text_end；如果有 tool_calls 则执行并继续下一轮
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, signal, thinkingLevel }) {
        const url = chatCompletionsUrl(config, model);
        const conversation = normalizeMessagesForChat(await resolveAttachments(messages.slice(), config));
        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toOpenAIToolSpec(def));
        const thinkingParams = global.WpsAiCapabilities?.buildThinkingParams("openai", thinkingLevel, model);
        let consecutiveEmptyAfterTools = 0;
        let consecutivePlanAfterTools = 0;
        let awaitingToolFollowup = false;
        let executedToolCount = 0;
        const executedToolNames = new Set();
        const fallbackRequiresSpreadsheetReadTool = looksLikeSpreadsheetReadRequest(conversation);
        const taskPlan = await planToolUse({ url, config, model, conversation, toolSpecs, signal });
        const requiresSpreadsheetReadTool = taskPlan?.requiresSpreadsheetRead === true || fallbackRequiresSpreadsheetReadTool;
        devLog("openai.sheet_read_guard", "spreadsheet read guard evaluated", {
          providerId: config.id,
          model,
          enabled: requiresSpreadsheetReadTool,
          source: taskPlan ? "planner" : "rule-fallback",
          planner: taskPlan,
          fallbackEnabled: fallbackRequiresSpreadsheetReadTool,
          toolNames: toolSpecs.map((tool) => tool?.function?.name || "").filter(Boolean).slice(0, 30)
        });

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          // include_usage 由 postStream 负责（严格网关回 400 时自动去掉重试）。
          const makeBody = (includeUsage, dropToolChoice) => {
            const body = { model, messages: normalizeMessagesForChat(conversation), stream: true };
            body.max_tokens = 4096;
            if (isOllamaConfig(config)) {
              body.options = Object.assign({}, body.options || {}, { num_predict: 4096 });
            }
            if (includeUsage) body.stream_options = { include_usage: true };
            if (toolSpecs.length > 0) body.tools = toolSpecs;
            // dropToolChoice：模型拒绝强制 tool_choice 时的降级（见 postStream）。
            // 表格读取守卫失去强制力，但对话能正常进行——模型仍可自行调用工具。
            if (!dropToolChoice && toolSpecs.length > 0 && requiresSpreadsheetReadTool && !executedToolNames.has("et_read_range")) {
              body.tool_choice = executedToolNames.has("et_get_sheet_info")
                ? { type: "function", function: { name: "et_read_range" } }
                : "required";
            }
            if (thinkingParams) Object.assign(body, thinkingParams);
            return body;
          };

          const response = await postStream(url, config, makeBody, signal);

          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || `请求失败：${response.status}`);
          }

          let fullText = "";
          let reasoningText = ""; // DeepSeek deepseek-reasoner: delta.reasoning_content
          let finishReason = null;
          let usage = null;
          const toolCallsByIndex = {};
          const suppressAssistantText = requiresSpreadsheetReadTool && !executedToolNames.has("et_read_range");

          await global.WpsAiSse.readSse(response, async (_eventType, payload) => {
            if (!payload) return;
            if (payload.usage) { usage = payload.usage; return; }
            const choice = payload.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};

            // DeepSeek reasoning 模型的思考过程 token，独立于 content 流
            const reasoningDelta = typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : (typeof delta.reasoning === "string" ? delta.reasoning : "");
            if (reasoningDelta.length > 0) {
              reasoningText += reasoningDelta;
              // 思考 token 按到达顺序实时发出，让时间轴里"思考过程"出现在它真实的位置。
              // 之前是攒到流末尾一次性发 → 思考总排在答案后面（错乱）。
              if (!suppressAssistantText) {
                await onEvent?.({ type: "reasoning_chunk", delta: reasoningDelta, fullText: reasoningText });
              }
            }

            const contentPiece = deltaContentToString(delta.content);
            if (contentPiece.length > 0) {
              fullText += contentPiece;
              if (!suppressAssistantText) {
                await onEvent?.({ type: "assistant_chunk", delta: contentPiece, fullText });
              }
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsByIndex[idx]) {
                  toolCallsByIndex[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCallsByIndex[idx].id = tc.id;
                if (tc.function?.name) toolCallsByIndex[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallsByIndex[idx].function.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          });

          try {
            if (usage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: usage.prompt_tokens, output: usage.completion_tokens });
          } catch (e) {}

          // 按 index 排序得到完整 tool_calls 数组
          const sortedKeys = Object.keys(toolCallsByIndex).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
          const toolCalls = sortedKeys.map((k) => toolCallsByIndex[k]).filter((tc) => tc.function.name);
          devLog("openai.iteration.end", "OpenAI-compatible stream iteration ended", {
            providerId: config.id,
            providerLabel: config.label,
            baseUrl: config.baseUrl,
            model,
            iteration: iter + 1,
            finishReason,
            textLength: fullText.length,
            reasoningLength: reasoningText.length,
            toolCallCount: toolCalls.length,
            toolCallNames: toolCalls.map((tc) => tc.function?.name || "")
          });

          // assistant message 进 conversation。
          // DeepSeek reasoner 要求把上一轮的 reasoning_content 带回，否则下轮报错。
          const assistantMessage = { role: "assistant", content: fullText || "" };
          if (reasoningText) assistantMessage.reasoning_content = reasoningText;
          if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
          conversation.push(assistantMessage);

          // 思考已在流中实时发出，这里只补一个收尾（把状态从 running 收成 ok）。
          // 去掉 toolCalls===0 限制：带工具调用的轮次也会有思考，同样需要收尾。
          if (reasoningText && !suppressAssistantText) {
            await onEvent?.({ type: "reasoning_end", text: reasoningText });
          }

          const wasAwaitingToolFollowup = awaitingToolFollowup;

          if (fullText) {
            awaitingToolFollowup = false;
            consecutiveEmptyAfterTools = 0;
            if (!suppressAssistantText) {
              await onEvent?.({ type: "assistant_text_end", text: fullText });
            }
          }

          if (toolCalls.length === 0) {
            if (requiresSpreadsheetReadTool && toolSpecs.length > 0 && !executedToolNames.has("et_read_range") && consecutivePlanAfterTools < 3) {
              consecutivePlanAfterTools += 1;
              devLog("openai.must_read_sheet.retry", "model answered without reading spreadsheet; forcing tool call", {
                providerId: config.id,
                providerLabel: config.label,
                baseUrl: config.baseUrl,
                model,
                iteration: iter + 1,
                executedTools: Array.from(executedToolNames),
                textPreview: fullText.slice(0, 240)
              });
              conversation.pop();
              conversation.push({
                role: "user",
                content: executedToolNames.has("et_get_sheet_info")
                  ? "你已经获取了工作表基本信息，但还没有读取单元格数据，不能回答“小区”数量。请现在必须调用 et_read_range 读取 UsedRange 或包含小区字段的区域；拿到 values 后再统计并回答。"
                  : "你还没有读取当前 WPS 表格，不能直接回答。请现在必须先调用 et_get_sheet_info 获取 UsedRange，再调用 et_read_range 读取相关区域；拿到工具结果后再回答。"
              });
              continue;
            }
            if (fullText && toolSpecs.length > 0 && looksLikeUnfinishedToolPlan(fullText) && consecutivePlanAfterTools < 2) {
              consecutivePlanAfterTools += 1;
              devLog(wasAwaitingToolFollowup ? "openai.plan_after_tools.retry" : "openai.plan_without_tools.retry", "model returned a plan without executing required tools; asking it to continue", {
                providerId: config.id,
                providerLabel: config.label,
                baseUrl: config.baseUrl,
                model,
                iteration: iter + 1,
                executedToolCount,
                wasAwaitingToolFollowup,
                consecutivePlanAfterTools,
                textPreview: fullText.slice(0, 240)
              });
              conversation.push({
                role: "user",
                content: buildToolContinuationPrompt(toolSpecs)
              });
              awaitingToolFollowup = wasAwaitingToolFollowup;
              continue;
            }
            if (!fullText && wasAwaitingToolFollowup && consecutiveEmptyAfterTools < 2) {
              consecutiveEmptyAfterTools += 1;
              devLog("openai.empty_after_tools.retry", "model returned empty response after tool results; asking it to continue", {
                providerId: config.id,
                providerLabel: config.label,
                baseUrl: config.baseUrl,
                model,
                iteration: iter + 1,
                consecutiveEmptyAfterTools
              });
              conversation.push({
                role: "user",
                content: "工具已经执行并返回结果。请不要再只返回空内容；请根据用户原始需求继续完成任务。如果还需要操作表格/文档，请继续调用合适的工具；如果已经完成，请用一句话说明结果。"
              });
              continue;
            }
            if (suppressAssistantText) {
              const blockedText = "当前模型没有按要求读取表格单元格数据，已停止直接回答，避免基于未读取的数据猜测。请换用工具调用更稳定的模型，或重试一次。";
              await onEvent?.({ type: "assistant_chunk", delta: blockedText, fullText: blockedText });
              await onEvent?.({ type: "assistant_text_end", text: blockedText });
              await onEvent?.({ type: "done", text: blockedText });
              return { content: blockedText, iterations: iter + 1 };
            }
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }
          consecutiveEmptyAfterTools = 0;
          consecutivePlanAfterTools = 0;

          const currentToolResults = [];
          for (const call of toolCalls) {
            // 让出一个宏任务：Excel 等宿主里工具是连续同步 COM，await 只排微任务、不给 DOM 事件机会，
            // 「停止」点击一直派发不出来、signal.aborted 永远置不上。先 setTimeout(0) 让点击落地再检查。
            await new Promise((r) => setTimeout(r, 0));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(call.function?.arguments || "{}");
            } catch (e) {
              devLog("openai.tool_args_parse_error", "failed to parse streamed tool call arguments", {
                providerId: config.id,
                model,
                toolName: call.function?.name,
                rawArguments: call.function?.arguments || "",
                error: e
              });
              parsedArgs = {};
            }

            await onEvent?.({ type: "tool_call", id: call.id, name: call.function?.name, args: parsedArgs });

            const decision = approveTool ? await approveTool({ id: call.id, name: call.function?.name, args: parsedArgs }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(call.function?.name, parsedArgs, { signal });
            }
            await onEvent?.({ type: "tool_result", id: call.id, name: call.function?.name, result });
            currentToolResults.push({ name: call.function?.name, result });

            conversation.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function?.name,
              content: global.WpsAiToolRegistry.serializeResult(result)
            });
            awaitingToolFollowup = true;
            executedToolCount += 1;
            if (call.function?.name) executedToolNames.add(call.function.name);
          }
          if (isOllamaConfig(config) && currentToolResults.length > 0) {
            conversation.push({ role: "user", content: toolResultReminder(currentToolResults) });
          }

          // 修 B23：能走到这里说明本轮有 tool_calls 且已执行（无 tool_calls 时上面 289 行已 return）。
          // 工具结果必须回传给模型再跑一轮，绝不能因 finish_reason==="stop" 提前结束——
          // 很多 OpenAI 兼容实现（vLLM 老版 / 部分中转 / Ollama）即使返回了 tool_calls 也报 stop，
          // 此时工具已真实执行（可能已改了用户文档），提前 return 会丢掉后续总结/确认。
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}），仍未结束。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("openai", createOpenAIProvider);
  // Azure OpenAI 复用整套 chat/completions 解析（响应体一致），仅请求端 URL/鉴权分叉（见 chatCompletionsUrl / buildHeaders）。
  global.WpsAiProviderRegistry?.register("azure", createOpenAIProvider);
})(window);
