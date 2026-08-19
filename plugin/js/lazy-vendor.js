// 懒加载 vendor 脚本：html2canvas / echarts 冷启动全量注入约 ~500KB，
// 但普通 chat 用户根本用不到。改成用到 HTML 模板渲染时才拉进来，
// 让插件启动 & 简单聊天路径更快。
(function attachLazyVendor(global) {
  "use strict";

  // 每个 vendor 一份 Promise 缓存，重复调直接返回已解析的
  const _promises = new Map();

  // src 相对 plugin 根目录；已加载的通过 global check 直接短路（避免重复 script 标签）
  const SPEC = {
    html2canvas: { globalKey: "html2canvas", src: "js/vendor/html2canvas.min.js" },
    echarts:     { globalKey: "echarts",     src: "js/vendor/echarts.min.js" },
    // 文档脑图用 markmap（离线内置）。markmap-view 依赖全局 d3，务必先 ensure("d3") 再 ensure("markmap")。
    d3:          { globalKey: "d3",           src: "js/vendor/d3.min.js" },
    markmap:     { globalKey: "markmap",      src: "js/vendor/markmap-view.min.js" },
    // onnxruntime-web（仅 wasm 后端）。本地离线抠图用；wasm 二进制 & 模型走 proxy /asset 取。
    ort:         { globalKey: "ort",          src: "js/vendor/ort/ort.wasm.min.js" },
    // WPS 老 WebView 可能不支持 WebAssembly SIMD，新版 ORT 已移除 non-SIMD build。
    // 这份 legacy runtime 保留 ort-wasm.wasm，用于本地抠图降级。
    ortLegacy:   { globalKey: "ort",          src: "js/vendor/ort-legacy/ort.wasm.min.js" }
  };

  function _loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      // 同 src 的 <script> 已经注入过就复用（避免竞态多注入）
      const existing = document.querySelector(`script[data-lazy-vendor="${src}"]`);
      if (existing) {
        // 修 B44：不能只看标签存在就 resolve。首次加载失败时旧 <script> 仍留在 head，
        // 直接 resolve 会让 global 仍是 undefined，后续抛"已加载但 global 未挂载"的误导错误，
        // 且此后永远不再真正请求。改为监听已有标签的 load/error；失败标签则移除并重新注入。
        if (existing.dataset.loaded === "1") { resolve(); return; }
        if (existing.dataset.failed === "1") { try { existing.remove(); } catch (e) {} }
        else {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error(`加载 ${src} 失败`)), { once: true });
          return;
        }
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.lazyVendor = src;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => {
        // 修 B44：失败标签打标记（供上面判断），并从 DOM 移除，让下次重试能重新请求。
        script.dataset.failed = "1";
        try { script.remove(); } catch (e) {}
        reject(new Error(`加载 ${src} 失败`));
      };
      document.head.appendChild(script);
    });
  }

  async function ensure(name) {
    const spec = SPEC[name];
    if (!spec) throw new Error(`未知 vendor: ${name}`);
    if (global[spec.globalKey]) return;
    if (_promises.has(name)) return _promises.get(name);
    const p = _loadScriptOnce(spec.src).then(() => {
      if (!global[spec.globalKey]) {
        throw new Error(`${name} 已加载脚本但 global.${spec.globalKey} 未挂载`);
      }
    });
    _promises.set(name, p);
    try {
      await p;
    } catch (e) {
      // 失败要清缓存，让下次重试可以重新拉
      _promises.delete(name);
      throw e;
    }
  }

  function isLoaded(name) {
    const spec = SPEC[name];
    return !!(spec && global[spec.globalKey]);
  }

  global.WpsAiLazyVendor = { ensure, isLoaded, SPEC };
})(window);
