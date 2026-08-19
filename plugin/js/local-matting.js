// 本地离线抠图：onnxruntime-web(wasm) + isnet-general-use 模型，输出发丝级软 alpha 蒙版。
// 不联网、不依赖供应商，跟 PS 的"通道/主体抠图"同类（神经网络 matting，连续透明度而非硬边）。
//
  // 资源加载策略：
//   - ort 的 JS 胶水(js/vendor/ort/ort.wasm.min.js) 用 <script> 相对加载（file:// / http 都行）；
//     WPS 老 WebView 不支持 WebAssembly SIMD 时降级到 js/vendor/ort-legacy/ort.wasm.min.js。
//     如果 WebView 完全没有 WebAssembly，则只把 ONNX 推理交给本地 proxy 的 Node runtime。
//   - ort 的 .wasm 与 176MB 的 .onnx 模型走 proxy(3890) 的 /asset 绝对 URL 取——
//     file:// 下 fetch 本地大二进制会被 CORS 挡，走 http 才稳。
//   - 单线程 wasm（无 cross-origin isolation → 无 SharedArrayBuffer）；SIMD 按运行环境检测。
(function attachLocalMatting(global) {
  "use strict";

  const MODEL_SIZE = 1024; // isnet-general-use 训练输入 1024×1024
  const ORT_ASSET_DIR = "js/vendor/ort/";
  const ORT_ASSET_DIR_LEGACY = "js/vendor/ort-legacy/";
  // 模型不随插件包分发（170MB），首次使用时按需从 OSS 拉、proxy 边下边缓存到本地、之后秒开。
  const MODEL_NAME = "isnet-general-use.onnx";
  const DEFAULT_MODEL_URL = "https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/models/isnet-general-use.onnx";

  let _sessionPromise = null;

  function proxyBase() {
    return (global.WpsAiRuntime && global.WpsAiRuntime.proxyBase && global.WpsAiRuntime.proxyBase())
      || "http://127.0.0.1:3890";
  }
  function assetUrl(rel) { return proxyBase() + "/asset/" + rel; }
  function modelSourceUrl() {
    try {
      const s = (global.WpsAiProviderRegistry && global.WpsAiProviderRegistry.loadSettings && global.WpsAiProviderRegistry.loadSettings()) || {};
      if (s.localMattingModelUrl) return String(s.localMattingModelUrl); // 允许设置里覆盖
    } catch (e) {}
    return DEFAULT_MODEL_URL;
  }
  function modelFetchUrl() {
    return proxyBase() + "/model-file?name=" + encodeURIComponent(MODEL_NAME)
      + "&url=" + encodeURIComponent(modelSourceUrl());
  }
  function localMattingInferUrl() { return proxyBase() + "/local-matting-infer"; }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      const e = new Error("已取消"); e.name = "AbortError"; throw e;
    }
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = src;
    });
  }

  function wasmSimdSupported() {
    try {
      // 最小 SIMD wasm：i32.const 0; i8x16.splat; drop
      const bytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b
      ]);
      return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes);
    } catch (e) {
      return false;
    }
  }

  function browserWasmSupported() {
    return typeof WebAssembly !== "undefined";
  }

  function ortWebVersion() {
    try { return String(global.ort && global.ort.env && global.ort.env.versions && global.ort.env.versions.web || ""); }
    catch (e) { return ""; }
  }

  function isLegacyOrtLoaded() {
    return /^1\.17\./.test(ortWebVersion());
  }

  function Float32ArrayToBase64(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function base64ToFloat32Array(b64) {
    const bin = atob(String(b64 || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  async function ensureOrt() {
    const useLegacy = !wasmSimdSupported();
    if (useLegacy && global.ort && !isLegacyOrtLoaded()) {
      // 新版 ORT(1.19+) 已移除 non-SIMD wasm；老 WebView 一旦加载它会在 wasm backend 初始化时失败。
      // 清掉全局对象后再加载 legacy runtime，避免同页重试继续复用失败 backend。
      try { global.ort = undefined; } catch (e) {}
    }
    if (!global.ort) {
      if (!global.WpsAiLazyVendor || !global.WpsAiLazyVendor.ensure) {
        throw new Error("lazy-vendor 未就绪");
      }
      await global.WpsAiLazyVendor.ensure(useLegacy ? "ortLegacy" : "ort");
    }
    if (!global.ort) throw new Error("onnxruntime-web 加载失败");
    // wasm 二进制从 proxy /asset 取（绝对 URL）
    global.ort.env.wasm.wasmPaths = assetUrl(useLegacy ? ORT_ASSET_DIR_LEGACY : ORT_ASSET_DIR);
    global.ort.env.wasm.numThreads = 1; // 无跨源隔离，单线程
    if (useLegacy) global.ort.env.wasm.simd = false;
    global.WpsAiLocalMattingRuntime = {
      simd: !useLegacy,
      vendor: useLegacy ? "ortLegacy" : "ort",
      wasmFile: useLegacy ? "ort-wasm.wasm" : "ort-wasm-simd-threaded.wasm"
    };
    return global.ort;
  }

  // 会话只建一次（模型 170MB，建完常驻内存复用）。真失败才清掉 promise 允许重试。
  // 首次会从 OSS 按需下载模型（经 proxy 边下边缓存），带真实下载进度；之后命中缓存秒开。
  //
  // 模型下载刻意不接调用方的 signal：它是所有抠图共享的资源，绑在单次调用的生命周期上
  // 会变成「谁先取消谁就把这 170MB 废掉」，下次抠图又从零重下、永远收敛不了。
  // 调用方取消只表示「我不等了」，下载继续跑完并落盘（proxy 侧同理，见 clientGone）。
  const _progressListeners = new Set();
  function emitSessionProgress(msg) {
    for (const fn of _progressListeners) { try { fn(msg); } catch (e) {} }
  }

  async function createSession() {
    const ort = await ensureOrt();
    emitSessionProgress("准备模型");
    const resp = await fetch(modelFetchUrl()); // 不接 signal——见上
    if (!resp.ok) {
      let msg = "模型下载失败 " + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg += "：" + j.error; } catch (e) {}
      throw new Error(msg + "（请确认模型已上传到 OSS 对应目录）");
    }
    const total = Number(resp.headers.get("content-length")) || 0;
    let bytes;
    if (resp.body && resp.body.getReader) {
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        received += r.value.length;
        const mb = Math.round(received / 1048576);
        emitSessionProgress(total ? ("下载模型 " + mb + "/" + Math.round(total / 1048576) + "MB") : ("下载模型 " + mb + "MB"));
      }
      bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
    } else {
      bytes = new Uint8Array(await resp.arrayBuffer());
    }
    emitSessionProgress("初始化模型");
    return ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
  }

  function ensureSession(onProgress, signal) {
    if (!_sessionPromise) {
      _sessionPromise = createSession().catch((e) => { _sessionPromise = null; throw e; });
      // 等待方可能全部取消，没人 then 它；挂个空 catch 免得变成 unhandledrejection。
      // 真错误仍会传给每个仍在等的调用方。
      _sessionPromise.catch(() => {});
    }
    const shared = _sessionPromise;
    if (onProgress) _progressListeners.add(onProgress);
    const detach = () => { if (onProgress) _progressListeners.delete(onProgress); };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        detach();
        signal?.removeEventListener?.("abort", onAbort);
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener?.("abort", onAbort);
      shared.then(
        (s) => { cleanup(); resolve(s); },
        (e) => { cleanup(); reject(e); }
      );
    });
  }

  async function inferMaskInBrowser(chw, onProgress, signal) {
    const session = await ensureSession(onProgress, signal);
    throwIfAborted(signal);
    const ort = global.ort;
    if (onProgress) onProgress("抠图计算中");
    const tensor = new ort.Tensor("float32", chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const feeds = {};
    feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    throwIfAborted(signal);
    global.WpsAiLocalMattingRuntime = Object.assign({}, global.WpsAiLocalMattingRuntime || {}, { backend: "browser" });
    return out[session.outputNames[0]].data;
  }

  async function inferMaskViaProxy(chw, onProgress, signal) {
    if (onProgress) onProgress("本地代理推理");
    const resp = await fetch(localMattingInferUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: MODEL_SIZE,
        modelName: MODEL_NAME,
        modelUrl: modelSourceUrl(),
        inputBase64: Float32ArrayToBase64(chw)
      }),
      signal
    });
    let json = null;
    try { json = await resp.json(); } catch (e) {}
    if (!resp.ok || !json || !json.ok) {
      throw new Error((json && json.error) || ("本地代理推理失败 " + resp.status));
    }
    const mask = base64ToFloat32Array(json.maskBase64);
    if (mask.length !== MODEL_SIZE * MODEL_SIZE) throw new Error("本地代理返回的蒙版尺寸无效");
    global.WpsAiLocalMattingRuntime = Object.assign({}, json.runtime || {}, {
      backend: "proxy",
      simd: false,
      vendor: "ort-node",
      wasmFile: "ort-wasm.wasm"
    });
    return mask;
  }

  function inferMask(chw, onProgress, signal) {
    return browserWasmSupported() ? inferMaskInBrowser(chw, onProgress, signal) : inferMaskViaProxy(chw, onProgress, signal);
  }

  // 模型是否已就绪（会话建过）——用于 UI 决定是否显示"本地抠图"。这里恒为 true（按需懒建），
  // 真正能不能用由第一次调用时 ensureSession 决定（会抛错并被上层 catch）。
  function isSupported() { return true; }

  /**
   * 本地抠图：输入任意 dataURL/URL，返回透明 PNG dataURL（主体保留、背景透明，发丝软过渡）。
   * @param {string} dataUrl
   * @param {{signal?:AbortSignal,onProgress?:(label:string)=>void}} [opts]
   */
  async function cutout(dataUrl, opts) {
    opts = opts || {};
    const signal = opts.signal, onProgress = opts.onProgress;
    throwIfAborted(signal);

    const img = await loadImg(dataUrl);
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    if (!W || !H) throw new Error("图片尺寸无效");
    const S = MODEL_SIZE;

    // —— 预处理：缩到 S×S，按 rembg isnet 规范 (im/max - 0.5)/1.0，HWC→CHW ——
    const pre = document.createElement("canvas");
    pre.width = S; pre.height = S;
    const pctx = pre.getContext("2d");
    pctx.drawImage(img, 0, 0, S, S);
    const pd = pctx.getImageData(0, 0, S, S).data;
    let mx = 0;
    for (let i = 0; i < pd.length; i += 4) {
      if (pd[i] > mx) mx = pd[i];
      if (pd[i + 1] > mx) mx = pd[i + 1];
      if (pd[i + 2] > mx) mx = pd[i + 2];
    }
    if (mx <= 0) mx = 255;
    const plane = S * S;
    const chw = new Float32Array(3 * plane);
    for (let p = 0, q = 0; p < pd.length; p += 4, q++) {
      chw[q] = pd[p] / mx - 0.5;             // R 平面
      chw[q + plane] = pd[p + 1] / mx - 0.5; // G 平面
      chw[q + 2 * plane] = pd[p + 2] / mx - 0.5; // B 平面
    }
    throwIfAborted(signal);

    // —— 推理 —— [1,1,S,S] 取最精细的主输出
    const mask = await inferMask(chw, onProgress, signal);

    // —— min-max 归一化成 0..1 蒙版 ——
    let mi = Infinity, ma = -Infinity;
    for (let i = 0; i < plane; i++) { const v = mask[i]; if (v < mi) mi = v; if (v > ma) ma = v; }
    const range = (ma - mi) || 1;

    // 蒙版画进 S×S 灰度 canvas，再用 drawImage 双线性缩放回原尺寸当 alpha
    const mcanvas = document.createElement("canvas");
    mcanvas.width = S; mcanvas.height = S;
    const mctx = mcanvas.getContext("2d");
    const mimg = mctx.createImageData(S, S);
    for (let i = 0; i < plane; i++) {
      const a = ((mask[i] - mi) / range) * 255;
      const j = i * 4;
      mimg.data[j] = mimg.data[j + 1] = mimg.data[j + 2] = a;
      mimg.data[j + 3] = 255;
    }
    mctx.putImageData(mimg, 0, 0);

    // —— 合成：原图 + 缩放后的蒙版当 alpha ——
    const scaled = document.createElement("canvas");
    scaled.width = W; scaled.height = H;
    const sctx = scaled.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(mcanvas, 0, 0, W, H);
    const sd = sctx.getImageData(0, 0, W, H).data;

    const outc = document.createElement("canvas");
    outc.width = W; outc.height = H;
    const octx = outc.getContext("2d");
    octx.drawImage(img, 0, 0, W, H);
    const od = octx.getImageData(0, 0, W, H);
    for (let i = 0, n = W * H; i < n; i++) { od.data[i * 4 + 3] = sd[i * 4]; }
    octx.putImageData(od, 0, 0);
    throwIfAborted(signal);
    return outc.toDataURL("image/png");
  }

  global.WpsAiLocalMatting = { isSupported, cutout, ensureSession };
})(window);
