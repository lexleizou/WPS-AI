"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { extractZip } = require("./zip-extract");
const { buildRemoteImageHeaders } = require("./remote-image-fetch");

const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), ".lingxi-ai", "browser", "chromium");
const DEFAULT_UPDATE_MANIFEST_URL = "https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json";
const DEFAULT_MANIFEST_URL = process.env.LINGXI_CHROMIUM_MANIFEST_URL || DEFAULT_UPDATE_MANIFEST_URL;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/apng"
]);

function buildChromiumImageHeaders(imageUrl, options = {}) {
  const source = buildRemoteImageHeaders(imageUrl, options);
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^sec-fetch-/i.test(key)) continue;
    headers[key] = value;
  }
  return headers;
}

function isTargetImageUrl(candidateUrl, imageUrl) {
  const candidateRaw = String(candidateUrl || "").split("#")[0];
  const targetRaw = String(imageUrl || "").split("#")[0];
  if (!candidateRaw || !targetRaw) return false;
  if (candidateRaw === targetRaw || candidateRaw.startsWith(targetRaw)) return true;
  try {
    const candidate = new URL(candidateRaw);
    const target = new URL(targetRaw);
    if (candidate.protocol !== target.protocol) return false;
    if (candidate.host !== target.host) return false;
    if (candidate.pathname !== target.pathname) return false;
    if (!target.search) return true;
    for (const [key, value] of target.searchParams) {
      if (!candidate.searchParams.getAll(key).includes(value)) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function platformKey(env = process) {
  const platform = env.platform || process.platform;
  const arch = env.arch || process.arch;
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "win32") return "win-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  return `${platform}-${arch}`;
}

function buildBrowserCandidates({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  const fromEnv = String(env.LINGXI_CHROMIUM_PATH || env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  const candidates = [];
  if (fromEnv) candidates.push({ label: "env", path: fromEnv });
  if (platform === "darwin") {
    candidates.push(
      { label: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { label: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { label: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { label: "Google Chrome", path: path.join(homeDir, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome") },
      { label: "Chromium", path: path.join(homeDir, "Applications/Chromium.app/Contents/MacOS/Chromium") }
    );
  } else if (platform === "win32") {
    const pf = env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    candidates.push(
      { label: "Google Chrome", path: path.join(pf, "Google", "Chrome", "Application", "chrome.exe") },
      { label: "Google Chrome", path: path.join(pf86, "Google", "Chrome", "Application", "chrome.exe") },
      { label: "Microsoft Edge", path: path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
      { label: "Microsoft Edge", path: path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
      { label: "Chromium", path: path.join(local, "Chromium", "Application", "chrome.exe") }
    );
  } else {
    candidates.push(
      { label: "Google Chrome", path: "/usr/bin/google-chrome" },
      { label: "Google Chrome Stable", path: "/usr/bin/google-chrome-stable" },
      { label: "Chromium", path: "/usr/bin/chromium" },
      { label: "Chromium Browser", path: "/usr/bin/chromium-browser" },
      { label: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
      { label: "Microsoft Edge Stable", path: "/usr/bin/microsoft-edge-stable" }
    );
  }
  const seen = new Set();
  return candidates.filter((item) => {
    if (!item.path || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function pickChromiumRuntimeSpec(manifest, key = platformKey()) {
  const root = manifest?.chromium || manifest;
  const item = root?.platforms?.[key];
  if (!root?.version || !item?.url || !item?.executablePath) return null;
  return Object.assign({ version: String(root.version), platform: key }, item);
}

function runtimeExecutablePath(spec, runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  if (!spec) return "";
  return path.join(runtimeRoot, spec.version, spec.platform, spec.executablePath);
}

function sha256File(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function httpGetBuffer(url, { timeoutMs = 120000, maxBytes = 1024 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      reject(new Error("仅支持 http/https 下载地址"));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpGetBuffer(next, { timeoutMs, maxBytes }).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          try { req.destroy(); } catch (e) {}
          reject(new Error("下载文件过大"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { try { req.destroy(); } catch (e) {} reject(new Error("download timeout")); });
  });
}

async function downloadAndExtractRuntime(spec, runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  if (!spec?.url) throw new Error("Chromium runtime manifest 缺 url");
  const outDir = path.join(runtimeRoot, spec.version, spec.platform);
  const exePath = runtimeExecutablePath(spec, runtimeRoot);
  if (fs.existsSync(exePath)) return exePath;
  fs.mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(runtimeRoot, `${spec.version}-${spec.platform}${path.extname(new URL(spec.url).pathname) || ".zip"}`);
  const buf = await httpGetBuffer(spec.url);
  fs.writeFileSync(archivePath, buf);
  if (spec.sha256) {
    const actual = sha256File(archivePath);
    if (actual !== String(spec.sha256).toLowerCase()) {
      try { fs.unlinkSync(archivePath); } catch (e) {}
      throw new Error(`Chromium runtime SHA256 校验失败：${actual}`);
    }
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (/\.zip$/i.test(archivePath)) {
    extractZip(archivePath, outDir);
  } else {
    throw new Error("当前仅支持 zip 格式 Chromium runtime");
  }
  if (!fs.existsSync(exePath)) throw new Error("Chromium runtime 解压后未找到浏览器可执行文件");
  try { fs.chmodSync(exePath, 0o755); } catch (e) {}
  return exePath;
}

async function resolveBrowserExecutable(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const homeDir = options.homeDir || os.homedir();
  const fsExists = options.fsExists || fs.existsSync;
  for (const item of buildBrowserCandidates({ platform, env: options.env || process.env, homeDir })) {
    if (fsExists(item.path)) return { source: "system", label: item.label, executablePath: item.path };
  }

  const runtimeRoot = options.runtimeRoot || DEFAULT_RUNTIME_ROOT;
  const key = platformKey({ platform, arch });
  const runtimeManifest = options.runtimeManifest || null;
  const cachedSpec = pickChromiumRuntimeSpec(runtimeManifest, key);
  const cachedPath = runtimeExecutablePath(cachedSpec, runtimeRoot);
  if (cachedSpec && cachedPath && fsExists(cachedPath)) {
    return { source: "cached", label: "Chromium Runtime", executablePath: cachedPath, spec: cachedSpec };
  }
  if (options.disableDownload) throw new Error("未找到本机 Chrome/Chromium/Edge，且已禁用 Chromium runtime 下载");

  let manifest = runtimeManifest;
  if (!manifest) {
    const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
    if (!manifestUrl) throw new Error("未找到本机浏览器，且未配置 LINGXI_CHROMIUM_MANIFEST_URL");
    manifest = JSON.parse((await httpGetBuffer(manifestUrl, { maxBytes: 1024 * 1024 })).toString("utf8"));
  }
  const spec = pickChromiumRuntimeSpec(manifest, key);
  if (!spec) throw new Error(`Chromium runtime manifest 缺少 ${key} 下载项`);
  const exePath = await downloadAndExtractRuntime(spec, runtimeRoot);
  return { source: "downloaded", label: "Chromium Runtime", executablePath: exePath, spec };
}

function waitForDevtools(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chromium 启动超时: ${stderr.slice(-500)}`)), timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chromium 已退出 code=${code} signal=${signal}: ${stderr.slice(-500)}`));
    });
  });
}

function requestJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function cdpSend(ws, state, method, params = {}, timeoutMs = 10000) {
  const id = ++state.nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`CDP 命令超时: ${method}`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
  });
}

async function fetchImageWithChromium(imageUrl, options = {}) {
  if (process.env.LINGXI_CHROMIUM_FETCH_MOCK_DATA_URL) {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(process.env.LINGXI_CHROMIUM_FETCH_MOCK_DATA_URL);
    if (!m) throw new Error("LINGXI_CHROMIUM_FETCH_MOCK_DATA_URL 非法");
    return {
      buf: Buffer.from(m[2], "base64"),
      contentType: m[1].toLowerCase(),
      source: "mock",
      browser: "mock"
    };
  }
  const resolved = await resolveBrowserExecutable(options);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-chromium-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "about:blank"
  ];
  if (process.platform === "linux") args.unshift("--no-sandbox");
  const child = spawn(resolved.executablePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = () => {
    try { child.kill("SIGTERM"); } catch (e) {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 1500).unref();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  };
  try {
    const browserWs = await waitForDevtools(child, options.launchTimeoutMs || 10000);
    const browserUrl = new URL(browserWs);
    const target = await requestJson(`http://${browserUrl.host}/json/new?about:blank`, "PUT");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const state = { nextId: 0, pending: new Map() };
    let targetRequestId = "";
    let targetResponse = null;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium 抓图超时")), options.timeoutMs || 30000);
      ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.id && state.pending.has(msg.id)) {
          const p = state.pending.get(msg.id);
          state.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
          return;
        }
        if (msg.method === "Network.requestWillBeSent") {
          const request = msg.params.request || {};
          if (msg.params.type === "Image" && isTargetImageUrl(request.url, imageUrl)) {
            targetRequestId = msg.params.requestId;
          }
        }
        if (msg.method === "Network.responseReceived") {
          const response = msg.params.response;
          if (msg.params.requestId === targetRequestId || isTargetImageUrl(response.url, imageUrl)) {
            targetRequestId = msg.params.requestId;
            targetResponse = response;
          }
        }
        if (msg.method === "Network.loadingFailed" && msg.params.requestId === targetRequestId) {
          clearTimeout(timer);
          reject(new Error(`Chromium 图片请求失败: ${msg.params.errorText || "unknown"}`));
        }
        if (msg.method === "Network.loadingFinished" && msg.params.requestId === targetRequestId) {
          try {
            const body = await cdpSend(ws, state, "Network.getResponseBody", { requestId: targetRequestId });
            const contentType = String(targetResponse?.mimeType || targetResponse?.headers?.["content-type"] || targetResponse?.headers?.["Content-Type"] || "image/png").split(";")[0].trim().toLowerCase();
            if (!SUPPORTED_IMAGE_TYPES.has(contentType)) throw new Error(`Chromium 返回了暂不支持的图片格式：${contentType}`);
            const buf = body.base64Encoded ? Buffer.from(body.body || "", "base64") : Buffer.from(body.body || "", "utf8");
            clearTimeout(timer);
            resolve({ buf, contentType, source: resolved.source, browser: resolved.label });
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        }
      };
      ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
    });
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("CDP WebSocket 打开失败"));
    });
    await cdpSend(ws, state, "Network.enable");
    await cdpSend(ws, state, "Page.enable");
    const referer = options.referer || options.pageUrl || "";
    await cdpSend(ws, state, "Network.setExtraHTTPHeaders", { headers: buildChromiumImageHeaders(imageUrl, { referer }) });
    const pageHtml = "<!doctype html><meta charset=utf-8><body>lingxi image fetch</body>";
    await cdpSend(ws, state, "Page.navigate", { url: `data:text/html,${encodeURIComponent(pageHtml)}` });
    await cdpSend(ws, state, "Runtime.evaluate", {
      expression: `new Promise((resolve)=>{const img=new Image();img.onload=()=>resolve(true);img.onerror=()=>resolve(false);img.src=${JSON.stringify(imageUrl)};document.body.appendChild(img);setTimeout(()=>resolve(false),25000);})`,
      awaitPromise: false
    });
    return await done;
  } finally {
    cleanup();
  }
}

module.exports = {
  DEFAULT_RUNTIME_ROOT,
  buildChromiumImageHeaders,
  buildBrowserCandidates,
  fetchImageWithChromium,
  isTargetImageUrl,
  pickChromiumRuntimeSpec,
  platformKey,
  resolveBrowserExecutable,
  runtimeExecutablePath
};
