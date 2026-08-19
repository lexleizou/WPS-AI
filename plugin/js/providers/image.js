(function attachImageClient(global) {
  "use strict";

  // 端口由 WpsAiRuntime 在启动时探测；这里现取，避免缓存 stale 值。
  function proxyForwardPrefix() {
    return (global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/");
  }
  function proxyBase() {
    return (global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890");
  }

  // 把 baseUrl 包装为本地 CORS 代理转发地址（如果开启了代理）
  function wrapProxy(baseUrl, useProxy) {
    const base = (baseUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    if (useProxy === false) return base;
    return proxyForwardPrefix() + encodeURIComponent(base);
  }

  function authHeaders(apiKey, withContentType = true) {
    const h = { Authorization: `Bearer ${apiKey}` };
    if (withContentType) h["Content-Type"] = "application/json";
    return h;
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort);
    });
  }

  // 从任务状态响应里抠出 0~100 的进度值（toapis 字段可能叫 progress / percent / ...）
  function pickProgress(task) {
    if (!task || typeof task !== "object") return null;
    const candidates = [task.progress, task.percent, task.complete_percent, task.completion_percent];
    for (const v of candidates) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      // 修 B38：先判 0~1 小数（0.5 表示 50%），否则会落进下面的 0~100 分支被 round 成 0/1。
      // 旧条件 `n > 100 && n <= 1` 恒假，是死代码。
      if (n > 0 && n < 1) return Math.round(n * 100);
      if (n >= 0 && n <= 100) return Math.round(n);
    }
    if (Number.isFinite(+task.completed_steps) && Number.isFinite(+task.total_steps) && +task.total_steps > 0) {
      return Math.round((+task.completed_steps / +task.total_steps) * 100);
    }
    return null;
  }

  function pickStatus(task) {
    return String(task?.status || task?.state || "unknown").toLowerCase();
  }

  function mapResultData(data) {
    return data.map((item) => ({
      url: item.url || null,
      b64: item.b64_json || null,
      revisedPrompt: item.revised_prompt || null
    }));
  }

  function extractFailReason(task) {
    const reason = task?.failure_reason
      || task?.error?.message
      || task?.error
      || task?.metadata?.error
      || "未知错误";
    return `图像生成失败：${reason}`;
  }

  // 上层工具只读 r.url 给 AI（AI 再喂给 wps_insert_image / wpp_add_picture）。
  // 但有些模型（gpt-image-1）固定只返回 b64_json 没有 url。这里把 b64 落到本地，
  // 替换 r.url 为本地路径——对调用方完全无感知。
  // 走本地代理 /upload-image，已经做了 fsync 保证 WPS AddPicture 能读到完整文件。
  async function materializeBase64Results(results, signal) {
    const out = [];
    for (const r of results) {
      if (r.url || !r.b64) { out.push(r); continue; }
      try {
        const mime = guessImageMime(r.b64);
        const dataUrl = `data:${mime};base64,${r.b64}`;
        const resp = await fetch(`${proxyBase()}/upload-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
          signal
        });
        if (!resp.ok) {
          const payload = await resp.json().catch(() => ({}));
          throw new Error(payload.error || `upload-image ${resp.status}`);
        }
        const { path: localPath } = await resp.json();
        out.push(Object.assign({}, r, { url: localPath }));
      } catch (err) {
        // 落地失败也别整张作废：保留原 r（无 url），让上层在 mapping 时显式报错。
        console.warn("[image] b64 → 本地文件失败:", err.message);
        out.push(r);
      }
    }
    return out;
  }

  // base64 头部魔数判 png/jpg/webp/gif。对 svg 不处理因为 OpenAI 系不会返 svg。
  function guessImageMime(b64) {
    const head = (b64 || "").slice(0, 16);
    if (head.startsWith("iVBORw0K")) return "image/png";
    if (head.startsWith("/9j/")) return "image/jpeg";
    if (head.startsWith("R0lGOD")) return "image/gif";
    if (head.startsWith("UklGR")) return "image/webp"; // RIFF
    return "image/png"; // 兜底
  }

  function parseImageDataUrl(dataUrl, label) {
    const m = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) throw new Error((label || "图片") + "不是有效的 base64 图片。");
    return { imageMime: m[1], imageBase64: m[2] };
  }

  function pickToapisUploadUrl(payload) {
    if (!payload || typeof payload !== "object") return "";
    const candidates = [
      payload.data?.url,
      payload.url,
      payload.data?.[0]?.url,
      payload.result?.url
    ];
    for (const u of candidates) {
      const s = String(u || "").trim();
      if (s) return s;
    }
    return "";
  }

  function mapToapisTaskResults(task) {
    const data = Array.isArray(task?.result?.data) ? task.result.data : null;
    if (data && data.length) return mapResultData(data);
    const url = String(task?.url || task?.image_url || task?.result?.url || "").trim();
    if (url) return [{ url, b64: null, revisedPrompt: null }];
    return [];
  }

  async function waitForToapisTask({ endpoint, base, task, prompt, start, signal, onProgress }) {
    const reportProgress = (t) => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({
          status: pickStatus(t),
          progress: pickProgress(t),
          elapsedMs: Date.now() - start,
          taskId: t?.id || null,
          prompt
        });
      } catch (e) { /* 上报失败不影响主流程 */ }
    };

    reportProgress(task);

    if (task?.status === "completed") {
      const results = mapToapisTaskResults(task);
      if (results.length === 0) throw new Error("任务完成但未返回任何图片。");
      reportProgress({ ...task, progress: 100 });
      return await materializeBase64Results(results, signal);
    }
    if (task?.status === "failed") {
      throw new Error(extractFailReason(task));
    }
    if (!task?.id) {
      throw new Error("任务创建后未返回 task id，无法继续轮询。");
    }

    const taskUrl = `${base}/images/generations/${encodeURIComponent(task.id)}`;
    const maxWaitMs = 180_000;
    let nextDelay = 1500;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (Date.now() - start > maxWaitMs) {
        throw new Error("图像生成超时（>3 分钟）。可在 toapis 控制台用 task id 继续查询：" + task.id);
      }

      await delay(nextDelay, signal);
      nextDelay = Math.min(nextDelay + 500, 4000);

      const statusResp = await fetch(taskUrl, {
        method: "GET",
        headers: authHeaders(endpoint.apiKey, false),
        signal
      });
      const statusPayload = await statusResp.json().catch(() => ({}));
      if (!statusResp.ok) {
        throw new Error(statusPayload.error?.message || statusPayload.message || `任务查询失败：${statusResp.status}`);
      }
      task = statusPayload;
      reportProgress(task);

      if (task?.status === "completed") {
        const results = mapToapisTaskResults(task);
        if (results.length === 0) throw new Error("任务完成但未返回任何图片。");
        reportProgress({ ...task, progress: 100 });
        return await materializeBase64Results(results, signal);
      }
      if (task?.status === "failed") {
        throw new Error(extractFailReason(task));
      }
    }
  }

  // 把激活渠道的 imageProviders entry 拍成 endpoint。
  // 各渠道 entry 自己已经是扁平结构，这里主要补默认值 + 把 size/resolution 概念对齐。
  function resolveEndpoint(config) {
    const type = config.type || "toapis";
    if (type === "codex-bridge") {
      return {
        type,
        baseUrl: config.baseUrl || "",
        apiKey: config.apiKey || "",
        model: config.model || "gpt-image-1",
        size: config.defaultSize || "1024x1024",
        useProxy: config.useProxy !== false
      };
    }
    // OpenAI 官方：协议同 codex-bridge（同步 /images/generations），但 baseUrl 有官方默认值
    if (type === "openai") {
      return {
        type,
        baseUrl: config.baseUrl || "https://api.openai.com/v1",
        apiKey: config.apiKey || "",
        model: config.model || "gpt-image-1",
        size: config.defaultSize || "1024x1024",
        useProxy: config.useProxy !== false
      };
    }
    // Boogu Image 本地 API：OpenAI 风格同步 /images/generations，但尺寸用 width/height
    // 独立整数、带 steps/seed、本地无鉴权、只生图不支持编辑。
    if (type === "boogu") {
      return {
        type,
        baseUrl: config.baseUrl || "http://127.0.0.1:8000/v1",
        apiKey: config.apiKey || "",
        model: config.model || "",
        size: config.defaultSize || "1:1",
        // 默认分辨率档位（长边）：决定生成图的整体大小；比例决定形状
        resolution: Number(config.resolution) > 0 ? Number(config.resolution) : 1024,
        steps: Number(config.steps) > 0 ? Number(config.steps) : 4,
        useProxy: config.useProxy !== false
      };
    }
    // OpenRouter：没有 images 端点，生图走 chat/completions + modalities:["image","text"]
    if (type === "openrouter") {
      return {
        type,
        baseUrl: config.baseUrl || "https://openrouter.ai/api/v1",
        apiKey: config.apiKey || "",
        model: config.model || "google/gemini-2.5-flash-image",
        size: config.defaultSize || "",
        useProxy: config.useProxy !== false
      };
    }
    // toapis（默认）
    return {
      type: "toapis",
      baseUrl: config.baseUrl || "",
      apiKey: config.apiKey || "",
      model: config.model || "gpt-image-2",
      size: config.defaultSize || "1:1",
      resolution: config.defaultResolution || "1K",
      useProxy: config.useProxy !== false
    };
  }

  /**
   * toapis.com / GPT-Image-2 流程：
   * 1) POST {base}/images/generations 创建任务
   * 2) 轮询 GET {base}/images/generations/{id} 直到 status === "completed"
   */
  async function generateImageToapis({ endpoint, prompt, size, resolution, n, model, signal, onProgress }) {
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写图像生成端点的 Base URL（默认 https://toapis.com/v1）。");

    const body = {
      model: model || endpoint.model,
      prompt,
      size: size || endpoint.size || "1:1",
      resolution: resolution || endpoint.resolution || "1K",
      n: Math.max(1, Math.min(4, n || 1)),
      response_format: "url"
    };

    let createResp;
    try {
      createResp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : `（已走本地代理 ${proxyBase()}，请确认代理服务在运行 / Base URL 域名可达）`;
      throw new Error(`图像服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    const createPayload = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      throw new Error(createPayload.error?.message || createPayload.message || `任务创建失败：${createResp.status}`);
    }

    let task = createPayload;
    const start = Date.now();
    return await waitForToapisTask({ endpoint, base, task, prompt, start, signal, onProgress });
  }

  /**
   * codex-bridge / OpenAI 兼容同步图像 API（sub2api 等中转平台）
   *   POST {base}/images/generations
   *     body: { model, prompt, size:"1024x1024"|"1792x1024"|..., n, response_format }
   *     resp: { data: [{ url } 或 { b64_json }] }
   *
   * 这条路径没有任务 id / 轮询，是阻塞调用。onProgress 在请求开始/结束时各打一次，
   * 让 UI 进度条仍然能动起来。
   */
  // OpenAI 官方 size 白名单映射：上层给的是 "16:9" 这类比例（toapis 风格）时，
  // 折算成该模型允许的像素档；直接给像素值则透传。
  //   gpt-image-1: 1024x1024 / 1536x1024 / 1024x1536
  //   dall-e-3:    1024x1024 / 1792x1024 / 1024x1792
  //   dall-e-2:    只有方图档（256/512/1024），统一取 1024x1024
  function mapSizeForOpenAI(size, model) {
    const s = String(size || "").trim().toLowerCase();
    const isDalle3 = /^dall-?e-?3/i.test(model);
    const isDalle2 = /^dall-?e-?2/i.test(model);
    if (isDalle2) return "1024x1024";
    if (/^\d+x\d+$/.test(s)) return s;
    const wide = isDalle3 ? "1792x1024" : "1536x1024";
    const tall = isDalle3 ? "1024x1792" : "1024x1536";
    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s);
    if (ratio) {
      const w = parseFloat(ratio[1]);
      const h = parseFloat(ratio[2]);
      if (w > 0 && h > 0) {
        if (w / h > 1.15) return wide;
        if (h / w > 1.15) return tall;
      }
      return "1024x1024";
    }
    return "1024x1024";
  }

  async function generateImageCodexBridge({ endpoint, prompt, size, n, model, signal, onProgress }) {
    const isOfficialOpenAI = endpoint.type === "openai";
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) {
      throw new Error(isOfficialOpenAI
        ? "请在设置中填写 OpenAI 官方渠道的 Base URL（默认 https://api.openai.com/v1）。"
        : "请在设置中填写 Codex 桥接的 Base URL（sub2api 等中转平台地址）。");
    }

    const finalModel = model || endpoint.model;
    // gpt-image-1 (OpenAI 新模型) 不支持 response_format 参数 — 它固定返回 b64_json。
    // 老 dall-e-2/3 支持 response_format。我们按 model 名后缀判断是否带这个字段:
    //   带的话 dall-e 才接受;给 gpt-image-1 带会被 OpenAI 返 400, 且 sub2api 在
    //   schedule 出错路径上可能 RST 而不是回 4xx。
    const useDalleResponseFormat = /^dall-?e-?[23]/i.test(finalModel);
    const rawSize = size || endpoint.size || "1024x1024";
    const body = {
      model: finalModel,
      prompt,
      // 官方 API 只收像素白名单，"16:9" 这类比例要折算；sub2api 等中转维持原样透传（有的后端自己认比例）
      size: isOfficialOpenAI ? mapSizeForOpenAI(rawSize, finalModel) : rawSize,
      n: Math.max(1, Math.min(4, n || 1))
    };
    // 官方 dall-e-3 只允许 n=1，多张会直接 400
    if (isOfficialOpenAI && /^dall-?e-?3/i.test(finalModel)) body.n = 1;
    if (useDalleResponseFormat) body.response_format = "url";

    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt });
      } catch (e) { /* ignore */ }
    };

    report("in_progress", null);

    // 心跳：codex-bridge 是阻塞 POST，没有 task id 可轮询。整个请求期间不主动 tick 的话
    // 上层 UI 一直停在 elapsed=0。每秒重新报一次 in_progress，把 elapsedMs 推上去。
    const heartbeat = setInterval(() => {
      report("in_progress", null);
    }, 1000);

    // 诊断日志: 打印实际发出的 URL/body, 不打印 apiKey。出 ECONNRESET 等问题时让用户看清
    // 是不是 model 名错了 / size 不对 / body 有非法字段。
    try {
      console.log("[image/codex-bridge] POST", `${base}/images/generations`, JSON.stringify(body));
    } catch (e) {}

    let resp;
    try {
      resp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      clearInterval(heartbeat);
      // 网络层抛错（fetch 本身就 failed）。给出比浏览器默认 "Failed to fetch" 更可操作的提示。
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : `（已走本地代理 ${proxyBase()}，请确认代理服务在运行 / Base URL 域名可达）`;
      throw new Error(`图像服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    clearInterval(heartbeat);
    const payload = await resp.json().catch(() => ({}));
    try {
      console.log("[image/codex-bridge] ← status", resp.status, "payload:", JSON.stringify(payload).slice(0, 600));
    } catch (e) {}
    if (!resp.ok) {
      // 代理 502 的 body 里已经带可读 message（含 host、ETIMEDOUT/ENOTFOUND 等翻译过的提示）
      // 4xx/5xx 业务错误：附带常见排查项，避免用户继续撞 ECONNRESET 一头雾水。
      const upstreamMsg = payload.error?.message || payload.message || `图像生成失败：${resp.status}`;
      const isAuthLike = resp.status === 401 || resp.status === 403;
      // 关键：代理已经识别出 Cloudflare/TLS 指纹问题时，它的 message 里已经给出明确处置步骤，
      // 这里再附"model 不支持"反而误导。同样 TLS 握手 RST / DNS 错 / 超时这类网络层错误也不归 model。
      const isNetworkLikeUpstream = /Cloudflare|TLS 握手|TLS 指纹|DNS 解析失败|连接被拒绝|网络不可达|超时|证书校验/.test(upstreamMsg);
      let hint = "";
      if (isNetworkLikeUpstream) {
        hint = "";
      } else if (isAuthLike) {
        hint = isOfficialOpenAI
          ? "（请确认 OpenAI API Key 有效、账户有余额，且 Key 有 images 权限）"
          : "（请确认 API Key 在该 sub2api 上有效且开通了图像渠道）";
      } else {
        hint = isOfficialOpenAI
          ? `（model="${finalModel}" 不被 OpenAI 官方图像接口支持，可用：gpt-image-1 / dall-e-3 / dall-e-2；gpt-image-1 可能需要组织验证）`
          : `（model="${finalModel}" 可能不被这条渠道支持，或 sub2api 后端找不到能跑此模型的账号）`;
      }
      throw new Error(`${upstreamMsg}${hint ? " " + hint : ""}`.trim());
    }

    const data = Array.isArray(payload.data) ? payload.data : [];
    if (data.length === 0) throw new Error("接口返回成功但没有任何图片数据。");

    report("completed", 100);
    return await materializeBase64Results(mapResultData(data), signal);
  }

  // Boogu 尺寸：分辨率档位（resolution，长边）+ 比例（size）→ width/height，
  // 都吸附到 Boogu 支持的档位 512/768/1024/1280/1536/2048。
  //   - 显式像素 size（"1024x768"）：忽略 resolution，直接按像素吸附（用户已指定具体大小）
  //   - 比例 size（"16:9"）：长边取 resolution 档位，短边 = 长边 × 短/长比，再吸附
  const BOOGU_STEPS = [512, 768, 1024, 1280, 1536, 2048];
  function snapBoogu(v) {
    const n = Number(v) || 1024;
    let best = BOOGU_STEPS[0];
    for (const s of BOOGU_STEPS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
    return best;
  }
  function mapSizeForBoogu(size, resolution) {
    const longEdge = snapBoogu(Number(resolution) > 0 ? Number(resolution) : 1024);
    const s = String(size || "").trim().toLowerCase();
    const px = /^(\d+)\s*x\s*(\d+)$/.exec(s);
    if (px) return { width: snapBoogu(px[1]), height: snapBoogu(px[2]) }; // 显式像素优先
    let w = 1, h = 1;
    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s);
    if (ratio) { w = parseFloat(ratio[1]) || 1; h = parseFloat(ratio[2]) || 1; }
    // 长边 = 分辨率档位；短边按比例算再吸附
    if (w >= h) return { width: longEdge, height: snapBoogu(longEdge * h / w) };
    return { width: snapBoogu(longEdge * w / h), height: longEdge };
  }

  /**
   * Boogu Image 本地 API：POST {base}/images/generations
   *   body: { prompt, negative_prompt?, width, height, steps, n, response_format:"url" }
   *   resp: { data: [{ url: 本地路径 }] } 或 { data: [{ b64_json }] }
   * 阻塞同步调用（无任务轮询），本地无鉴权。只生图。
   */
  // Boogu 本地生图很慢（CPU offload 60-90s/张），阻塞请求会撞 mac WKWebView 的 ~60s
  // 无数据超时导致中断+重试。改走代理的异步端点：前端毫秒级拿 taskId，代理后台承担长
  // 等待，前端轮询结果，任何 WebView 请求都很短，绝不超时。
  async function generateImageBoogu({ endpoint, prompt, size, n, signal, onProgress }) {
    const targetBase = String(endpoint.baseUrl || "").replace(/\/+$/, "");
    if (!targetBase) throw new Error("请在设置中填写 Boogu 本地服务的 Base URL（默认 http://127.0.0.1:8000/v1）。");
    const { width, height } = mapSizeForBoogu(size || endpoint.size, endpoint.resolution);
    const payload = {
      prompt, width, height,
      steps: Number(endpoint.steps) > 0 ? Number(endpoint.steps) : 4,
      n: Math.max(1, Math.min(4, n || 1)),
      response_format: "url"
    };

    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt }); } catch (e) {}
    };
    report("in_progress", null);

    // 1) 提交任务（毫秒级返回 taskId）
    let taskId;
    try {
      const submit = await fetch(`${proxyBase()}/local-image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${targetBase}/images/generations`,
          payload,
          headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}
        }),
        signal
      });
      const sj = await submit.json().catch(() => ({}));
      if (!submit.ok || !sj.taskId) throw new Error(sj.error || `提交失败 ${submit.status}`);
      taskId = sj.taskId;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new Error(`Boogu 生图提交失败：${err?.message || err}（请确认本地代理在运行、Boogu 服务已启动）`);
    }

    // 2) 轮询结果（每 2s，代理端有 20min 上限；本地图无网络超时压力）
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await delay(2000, signal);
      report("in_progress", null); // 推进度条的 elapsed
      let poll;
      try {
        poll = await fetch(`${proxyBase()}/local-image/result?taskId=${encodeURIComponent(taskId)}`, { signal });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        continue; // 单次轮询失败（网络抖动）→ 重试
      }
      const pj = await poll.json().catch(() => ({}));
      if (!poll.ok) throw new Error(pj.error || `轮询失败 ${poll.status}`);
      if (pj.status === "pending") continue;
      if (pj.status === "error") throw new Error(`Boogu 生图失败：${pj.error || "未知错误"}`);
      // done
      const data = Array.isArray(pj.data?.data) ? pj.data.data : [];
      if (data.length === 0) throw new Error("Boogu 返回成功但没有任何图片数据。");
      report("completed", 100);
      return await materializeBase64Results(mapResultData(data), signal);
    }
  }

  // OpenRouter 返回的 message.images[] → 统一 results 结构。
  // 图片是 dataURL（data:image/png;base64,...）时抠出 b64 交给 materializeBase64Results 落地；
  // 个别模型直接回 http(s) URL 时原样透传。
  function mapOpenRouterImages(images) {
    const out = [];
    (Array.isArray(images) ? images : []).forEach((img) => {
      const u = String(img?.image_url?.url || img?.url || "").trim();
      if (!u) return;
      const m = /^data:[^;]+;base64,(.+)$/i.exec(u);
      if (m) out.push({ url: null, b64: m[1], revisedPrompt: null });
      else out.push({ url: u, b64: null, revisedPrompt: null });
    });
    return out;
  }

  /**
   * OpenRouter 生图：没有 /images/generations 端点，走
   *   POST {base}/chat/completions
   *     body: { model, messages:[{role:"user",content:prompt}], modalities:["image","text"] }
   *     resp: choices[0].message.images = [{ type:"image_url", image_url:{ url:"data:image/png;base64,..." } }]
   * 适用模型：google/gemini-2.5-flash-image（Nano Banana）等支持图像输出的模型。
   * size/n 该协议不收：比例靠 prompt 描述，一次调用回 1~N 张由模型定。
   */
  async function generateImageOpenRouter({ endpoint, prompt, size, model, signal, onProgress }) {
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写 OpenRouter 的 Base URL（默认 https://openrouter.ai/api/v1）。");

    const finalModel = model || endpoint.model;
    // size 传进来是 "1024x1024" / "16:9" 之类；协议不支持参数化，折算成提示词里的比例要求
    const sizeHint = size && /[:x×]/i.test(String(size))
      ? `\n（画面比例要求：${String(size).replace(/x/i, ":")}）`
      : "";
    const body = {
      model: finalModel,
      messages: [{ role: "user", content: prompt + sizeHint }],
      modalities: ["image", "text"]
    };

    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt }); } catch (e) {}
    };
    report("in_progress", null);
    // 阻塞 POST 没有任务可轮询，心跳推 elapsedMs 让 UI 进度条动起来（同 codex-bridge）
    const heartbeat = setInterval(() => report("in_progress", null), 1000);

    try {
      console.log("[image/openrouter] POST", `${base}/chat/completions`, JSON.stringify({ model: finalModel, modalities: body.modalities }));
    } catch (e) {}

    let resp;
    try {
      resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      clearInterval(heartbeat);
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : `（已走本地代理 ${proxyBase()}，请确认代理服务在运行 / openrouter.ai 可达）`;
      throw new Error(`图像服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    clearInterval(heartbeat);
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const upstreamMsg = payload.error?.message || payload.message || `图像生成失败：${resp.status}`;
      const isAuthLike = resp.status === 401 || resp.status === 403;
      const hint = isAuthLike
        ? "（请确认 OpenRouter API Key 有效且账户有额度）"
        : (resp.status === 404
          ? `（model="${finalModel}" 在 OpenRouter 上不存在或已下线）`
          : `（确认 model="${finalModel}" 支持图像输出，如 google/gemini-2.5-flash-image）`);
      throw new Error(`${upstreamMsg} ${hint}`.trim());
    }

    const msg = payload.choices?.[0]?.message || {};
    const results = mapOpenRouterImages(msg.images);
    if (results.length === 0) {
      // 200 但没图：多半是选了纯文本模型。把模型的文字回复带出来帮用户定位。
      const text = String(msg.content || "").trim().slice(0, 120);
      throw new Error(
        `模型未返回图片${text ? `（模型回复：${text}…）` : "。"}` +
        `请确认所选模型支持图像输出（modalities 含 image），如 google/gemini-2.5-flash-image。`
      );
    }
    report("completed", 100);
    return await materializeBase64Results(results, signal);
  }

  /**
   * OpenRouter 图像编辑 / 抠图：同一个 chat/completions 协议，把原图作为多模态输入
   * （content 数组带 image_url dataURL），模型按 prompt 出编辑后的新图。
   * mask 该协议不支持——涂抹语义只能靠 prompt 描述，maskDataUrl 忽略。
   */
  async function editImageOpenRouter({ endpoint, imageDataUrl, prompt, signal, onProgress }) {
    parseImageDataUrl(imageDataUrl, "图像编辑输入"); // 只做合法性校验，dataURL 原样传给模型
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写 OpenRouter 的 Base URL（默认 https://openrouter.ai/api/v1）。");

    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt }); } catch (e) {}
    };
    report("in_progress", null);
    const heartbeat = setInterval(() => report("in_progress", null), 1000);

    let resp;
    try {
      resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }],
          modalities: ["image", "text"]
        }),
        signal
      });
    } catch (err) {
      clearInterval(heartbeat);
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : `（已走本地代理 ${proxyBase()}，请确认代理服务在运行 / openrouter.ai 可达）`;
      throw new Error(`图像编辑服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    clearInterval(heartbeat);
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(payload.error?.message || payload.message || `图像编辑失败：${resp.status}`);
    }
    const results = mapOpenRouterImages(payload.choices?.[0]?.message?.images);
    if (results.length === 0) {
      throw new Error("模型未返回编辑后的图片。请确认所选模型支持图像输出（如 google/gemini-2.5-flash-image）。");
    }
    report("completed", 100);
    return await materializeBase64Results(results, signal);
  }

  /**
   * 统一入口：根据全局配置的 type 字段分发到对应渠道。
   * 调用方完全无感知 - 还是传 { prompt, size, resolution, n, model, signal, onProgress }。
   * resolution 仅对 toapis 生效；codex-bridge / openai 用 size 当 "1024x1024" 这样的实际像素值。
   */
  async function generateImage({ prompt, size, resolution, n = 1, model, signal, onProgress } = {}) {
    if (!prompt || typeof prompt !== "string") throw new Error("生成图片必须提供 prompt。");

    const config = global.WpsAiProviderRegistry.getImageConfig();
    if (!config.enabled) {
      throw new Error("图像生成未启用，请在「设置 → 图像生成」中开启并填写 baseUrl/apiKey。");
    }

    const endpoint = resolveEndpoint(config);
    // Boogu 是本地服务、无鉴权，其余渠道要求 API Key
    if (endpoint.type !== "boogu" && !endpoint.apiKey) throw new Error("请在设置中填写当前渠道的 API Key。");

    if (endpoint.type === "boogu") {
      return generateImageBoogu({ endpoint, prompt, size, n, signal, onProgress });
    }
    if (endpoint.type === "codex-bridge" || endpoint.type === "openai") {
      return generateImageCodexBridge({ endpoint, prompt, size, n, model, signal, onProgress });
    }
    if (endpoint.type === "openrouter") {
      return generateImageOpenRouter({ endpoint, prompt, size, model, signal, onProgress });
    }
    return generateImageToapis({ endpoint, prompt, size, resolution, n, model, signal, onProgress });
  }

  /**
   * 抠图 / 图像编辑：Codex 桥接（sub2api）走 OpenAI 兼容的 /images/edits（multipart）。
   * 经本地代理 /image-edit 服务端手搓 multipart（避免浏览器 FormData 在 WPS WebView 的坑）。
   */
  async function editImageCodexBridge({ endpoint, imageDataUrl, prompt, maskDataUrl, background, signal, onProgress }) {
    const { imageMime, imageBase64 } = parseImageDataUrl(imageDataUrl, "抠图输入");
    let maskBase64 = "";
    if (maskDataUrl) {
      const mm = /^data:[^;]+;base64,(.+)$/i.exec(String(maskDataUrl));
      if (mm) maskBase64 = mm[1];
    }
    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt }); } catch (e) {}
    };
    report("in_progress", null);
    const heartbeat = setInterval(() => report("in_progress", null), 1000);
    const postOnce = async (bg) => {
      const resp = await fetch(`${proxyBase()}/image-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: (endpoint.baseUrl || "").replace(/\/+$/, ""),
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          size: "", // 抠图不强制尺寸，避免把非方形图裁成方形
          background: bg || "",
          prompt, imageBase64, imageMime, maskBase64
        }),
        signal
      });
      const payload = await resp.json().catch(() => ({}));
      return { resp, payload };
    };
    let downgraded = false;
    try {
      let { resp, payload } = await postOnce(background);
      // 该模型不支持透明底 → 去掉 background 重试一次（结果非透明，但不至于直接失败）
      if (!resp.ok && background) {
        const msg = String(payload.error?.message || payload.error || payload.message || "");
        if (/transparent|background|透明/i.test(msg) && /not\s*support|unsupported|不支持/i.test(msg)) {
          downgraded = true;
          ({ resp, payload } = await postOnce(""));
        }
      }
      if (!resp.ok) {
        throw new Error(payload.error?.message || payload.error || payload.message || `抠图失败：${resp.status}`);
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      if (data.length === 0) throw new Error("抠图接口返回成功但没有图片数据。");
      report("completed", 100);
      const out = await materializeBase64Results(mapResultData(data), signal);
      if (downgraded && out[0]) out[0].transparentUnsupported = true; // 让上层给个提示
      return out;
    } finally { clearInterval(heartbeat); }
  }

  async function uploadImageToapis({ endpoint, imageDataUrl, purpose, signal }) {
    const { imageMime, imageBase64 } = parseImageDataUrl(imageDataUrl, "上传图片");
    const resp = await fetch(`${proxyBase()}/toapis-upload-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: (endpoint.baseUrl || "").replace(/\/+$/, ""),
        apiKey: endpoint.apiKey,
        imageBase64,
        imageMime,
        purpose: purpose || "generation"
      }),
      signal
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload.success === false) {
      throw new Error(payload.error?.message || payload.error || payload.message || `图片上传失败：${resp.status}`);
    }
    const url = pickToapisUploadUrl(payload);
    if (!url) throw new Error("图片上传成功但未返回可用 URL。");
    return url;
  }

  /**
   * ToAPI / gpt-image-2 图片编辑：本地图片先上传到 /uploads/images，得到 URL 后
   * 调 /images/generations，带 image_urls 触发编辑模式。
   */
  async function editImageToapis({ endpoint, imageDataUrl, prompt, maskDataUrl, signal, onProgress }) {
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写图像生成端点的 Base URL（默认 https://toapis.com/v1）。");
    const start = Date.now();
    if (typeof onProgress === "function") {
      try { onProgress({ status: "uploading", progress: null, elapsedMs: 0, taskId: null, prompt }); } catch (e) {}
    }
    const imageUrl = await uploadImageToapis({ endpoint, imageDataUrl, purpose: "generation", signal });
    let maskUrl = "";
    if (maskDataUrl) {
      maskUrl = await uploadImageToapis({ endpoint, imageDataUrl: maskDataUrl, purpose: "generation", signal });
    }
    const body = {
      model: endpoint.model || "gpt-image-2",
      prompt,
      image_urls: [imageUrl],
      size: "auto",
      resolution: endpoint.resolution || "1K",
      quality: "medium",
      n: 1,
      response_format: "url",
      output_format: "png"
    };
    if (maskUrl) body.mask_url = maskUrl;

    let createResp;
    try {
      createResp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : `（已走本地代理 ${proxyBase()}，请确认代理服务在运行 / Base URL 域名可达）`;
      throw new Error(`图像编辑服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    const createPayload = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      throw new Error(createPayload.error?.message || createPayload.message || `编辑任务创建失败：${createResp.status}`);
    }

    return await waitForToapisTask({
      endpoint,
      base,
      task: createPayload,
      prompt,
      start,
      signal,
      onProgress
    });
  }

  async function editImage({ imageDataUrl, prompt, maskDataUrl, background, signal, onProgress } = {}) {
    if (!imageDataUrl) throw new Error("抠图需要提供图片。");
    const config = global.WpsAiProviderRegistry.getImageConfig();
    if (!config.enabled) throw new Error("图像生成未启用，请在「设置 → 图像生成」中开启。");
    const endpoint = resolveEndpoint(config);
    // Boogu 只生图，不支持抠图/编辑——明确提示，别落到「填 API Key」的误导上
    if (endpoint.type === "boogu") {
      throw new Error("当前生图渠道（Boogu 本地）只支持生成图片，不支持抠图 / 图像编辑。请切换到 ToAPI / Codex 桥接 / OpenAI 官方 / OpenRouter 渠道。");
    }
    if (!endpoint.apiKey) throw new Error("请在设置中填写当前渠道的 API Key。");
    if (endpoint.type === "toapis") {
      return editImageToapis({
        endpoint,
        imageDataUrl,
        prompt: prompt || "移除背景，只保留主体，输出透明背景 PNG。",
        maskDataUrl,
        background,
        signal, onProgress
      });
    }
    if (endpoint.type === "openrouter") {
      return editImageOpenRouter({
        endpoint,
        imageDataUrl,
        prompt: prompt || "移除背景，只保留主体，输出透明背景 PNG。",
        signal, onProgress
      });
    }
    if (endpoint.type !== "codex-bridge" && endpoint.type !== "openai") {
      throw new Error("当前图像渠道不支持 AI 抠图。请切换到 ToAPI / Codex 桥接 / OpenAI 官方 / OpenRouter 渠道。");
    }
    return editImageCodexBridge({
      endpoint,
      imageDataUrl,
      prompt: prompt || "移除背景，只保留主体，输出透明背景 PNG。",
      maskDataUrl,
      background,
      signal, onProgress
    });
  }

  global.WpsAiImage = { generateImage, editImage };
})(window);
