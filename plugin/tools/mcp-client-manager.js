// plugin/tools/mcp-client-manager.js
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 60 * 1000;
const MCP_TOKEN_FILE = path.join(os.homedir(), ".lingxi-ai", "mcp-token");

// 共享的 JSON-RPC 请求/响应匹配逻辑。子类实现 _write(line) 与 close()，
// 并在收到完整一行时调 _onLine(line)。
class JsonRpcClient {
  constructor() {
    this._nextId = 1;
    this._pending = new Map(); // id → {resolve, reject, timer}
    this.connected = false;
    this.lastError = null;
  }
  _request(method, params) {
    const id = this._nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }
      }, CALL_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try { this._write(payload); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  _notify(method, params) {
    this._write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  }
  _onLine(line) {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch (e) { this.lastError = "非法 JSON-RPC 行: " + (s.length > 80 ? s.slice(0, 80) + "…" : s); return; }
    if (msg.id == null || !this._pending.has(msg.id)) return; // server 主动通知/请求：忽略
    const { resolve, reject, timer } = this._pending.get(msg.id);
    clearTimeout(timer);
    this._pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "MCP error"));
    else resolve(msg.result);
  }
  _rejectAll(err) {
    this._pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(err); });
    this._pending.clear();
  }
  async initialize() {
    const result = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wps-ai", version: "1.0" }
    });
    this._notify("notifications/initialized", {});
    this.connected = true;
    return result;
  }
  async listTools() {
    const result = await this._request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }
  async call(name, args) {
    return await this._request("tools/call", { name, arguments: args || {} });
  }
}

const IS_WIN = process.platform === "win32";
// Windows：npx/npm/uvx 这类"裸命令"实际是 .cmd 脚本，spawn 不走 shell 时按 PATHEXT 找不到 → ENOENT。
// 裸命令（无路径分隔符、非 .exe/.com）或显式 .cmd/.bat → 经 cmd.exe /c 解析；
// 绝对路径可执行文件（含带空格的 process.execPath）仍直接 spawn，避免 shell:true 把路径拆断。
// 分离 argv（不用 shell:true）交给 Node 自动给带空格的参数加引号。isWin 可注入以便测试。
function resolveSpawn(command, args, isWin = IS_WIN) {
  if (isWin) {
    const bare = !/[\\/]/.test(command);
    const isCmdScript = /\.(cmd|bat)$/i.test(command);
    const isDirectExe = /\.(exe|com)$/i.test(command);
    if (isCmdScript || (bare && !isDirectExe)) {
      return { file: process.env.ComSpec || "cmd.exe", args: ["/c", command, ...(args || [])] };
    }
  }
  return { file: command, args: args || [] };
}

class StdioMcpClient extends JsonRpcClient {
  constructor({ command, args, env }) {
    super();
    this._command = command;
    this._args = Array.isArray(args) ? args : [];
    this._env = env || {};
    this._proc = null;
    this._buf = "";
    this._stderr = "";
    this._dead = false;
  }
  start() {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        const { file, args } = resolveSpawn(this._command, this._args);
        proc = spawn(file, args, {
          env: Object.assign({}, process.env, this._env),
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (e) { reject(e); return; }
      this._proc = proc;
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        this._buf += chunk;
        let nl;
        while ((nl = this._buf.indexOf("\n")) >= 0) {
          const line = this._buf.slice(0, nl);
          this._buf = this._buf.slice(nl + 1);
          this._onLine(line);
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => { this._stderr = (this._stderr + chunk).slice(-2000); });
      proc.on("error", (err) => {
        this.connected = false;
        this._dead = true;
        this.lastError = err.message;
        this._rejectAll(err);
        reject(err);
      });
      proc.on("exit", (code) => {
        this.connected = false;
        this._dead = true;
        if (code && !this.lastError) this.lastError = `子进程退出 code=${code}；${this._stderrHint()}`;
        this._rejectAll(new Error("子进程已退出"));
      });
      // spawn 成功即认为 start 完成（initialize 单独调）
      setImmediate(() => { if (this._proc && !this._proc.killed) resolve(); });
    });
  }
  _write(line) {
    if (this._dead || !this._proc || this._proc.killed) throw new Error("子进程未运行");
    this._proc.stdin.write(line);
  }
  _stderrHint() {
    const first = (this._stderr || "").split("\n").map((l) => l.trim()).filter(Boolean)[0];
    return first ? `stderr: ${first}` : "无 stderr 输出";
  }
  close() {
    this.connected = false;
    this._dead = true;
    const proc = this._proc;
    this._proc = null;
    if (!proc) return;
    // Windows：经 cmd.exe /c 起的 npx 会派生 node 子孙进程，只 kill cmd 会留孤儿 MCP server → 杀整棵树
    if (IS_WIN && proc.pid) {
      try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" }); return; } catch (e) {}
    }
    try { proc.kill(); } catch (e) {}
  }
}

class SseMcpClient extends JsonRpcClient {
  constructor({ url, headers, startTimeoutMs }) {
    super();
    this._url = url;
    this._headers = headers || {};
    this._sseReq = null;
    this._postUrl = null;   // endpoint 事件解析出的 POST 目标（绝对 URL）
    this._sseBuf = "";
    this._startTimeoutMs = (typeof startTimeoutMs === "number" && startTimeoutMs > 0) ? startTimeoutMs : 5000;
  }
  start() {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(this._url); } catch (e) { reject(new Error("URL 非法")); return; }
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(u, {
        method: "GET",
        headers: Object.assign({ Accept: "text/event-stream" }, this._headers)
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`SSE HTTP ${res.statusCode}`)); return; }
        res.setEncoding("utf8");
        res.on("data", (chunk) => this._onSseChunk(chunk, u, resolve));
        res.on("end", () => { this.connected = false; this._rejectAll(new Error("SSE 流结束")); });
      });
      req.on("error", (err) => { this.connected = false; this.lastError = err.message; this._rejectAll(err); reject(err); });
      req.end();
      this._sseReq = req;
      // 兜底：超时内没收到 endpoint 事件视为失败，并销毁 SSE 连接避免泄漏
      this._startTimer = setTimeout(() => {
        if (!this._postUrl) {
          try { this._sseReq && this._sseReq.destroy(); } catch (e) {}
          reject(new Error("SSE 未在 " + (this._startTimeoutMs / 1000) + "s 内返回 endpoint"));
        }
      }, this._startTimeoutMs);
    });
  }
  _onSseChunk(chunk, baseUrl, resolveStart) {
    this._sseBuf += chunk;
    const sep = /\r?\n\r?\n/;
    let m;
    while ((m = sep.exec(this._sseBuf)) !== null) {
      const raw = this._sseBuf.slice(0, m.index);
      this._sseBuf = this._sseBuf.slice(m.index + m[0].length);
      let event = "message";
      const dataLines = [];
      raw.split(/\r?\n/).forEach((ln) => {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).replace(/^ /, ""));
      });
      const data = dataLines.join("\n");
      if (event === "endpoint") {
        this._postUrl = new URL(data, baseUrl).toString();
        if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
        resolveStart();
      } else if (event === "message") {
        this._onLine(data);
      }
    }
  }
  _write(line) {
    if (!this._postUrl) throw new Error("SSE endpoint 未就绪");
    const u = new URL(this._postUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this._headers)
    }, (res) => { res.resume(); }); // 响应从 SSE 回，这里丢弃
    req.on("error", (err) => { this.lastError = err.message; this._rejectAll(err); });
    req.write(line);
    req.end();
  }
  close() {
    this.connected = false;
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this._sseReq) { try { this._sseReq.destroy(); } catch (e) {} this._sseReq = null; }
  }
}

function fingerprint(cfg) {
  return JSON.stringify({ t: cfg.type, c: cfg.command, a: cfg.args, e: cfg.env, u: cfg.url, h: cfg.headers });
}

class McpClientManager {
  constructor() {
    this._conns = new Map(); // id → { cfg, fp, client, tools, error }
  }
  async _connectOne(cfg) {
    const client = cfg.type === "sse"
      ? new SseMcpClient({ url: cfg.url, headers: cfg.headers })
      : new StdioMcpClient({ command: cfg.command, args: cfg.args, env: cfg.env });
    const entry = { cfg, fp: fingerprint(cfg), client, tools: [], error: null };
    this._conns.set(cfg.id, entry);
    try {
      await client.start();
      await client.initialize();
      entry.tools = await client.listTools();
    } catch (e) {
      entry.error = e.message || String(e);
      try { client.close(); } catch (_) {}
    }
  }
  async reconcile(clients) {
    const wanted = new Map((clients || []).map((c) => [c.id, c]));
    // 移除不再需要的（配置里完全不存在了）/ 关闭已禁用的（保留条目以便查状态）
    for (const [id, entry] of Array.from(this._conns.entries())) {
      const cfg = wanted.get(id);
      if (!cfg) {
        try { entry.client.close(); } catch (e) {}
        this._conns.delete(id);
      } else if (!cfg.enabled) {
        try { entry.client.close(); } catch (e) {}
        entry.tools = [];
        entry.error = null;
        entry.cfg = cfg;
      }
    }
    // 新增 / 变更
    for (const cfg of clients || []) {
      if (!cfg.enabled) continue;
      const existing = this._conns.get(cfg.id);
      if (existing && existing.fp === fingerprint(cfg) && existing.client.connected) continue; // 无变化
      if (existing) { try { existing.client.close(); } catch (e) {} this._conns.delete(cfg.id); }
      await this._connectOne(cfg);
    }
    return this.getStatusList();
  }
  getStatusList() {
    return Array.from(this._conns.values()).map((e) => ({
      id: e.cfg.id,
      name: e.cfg.name,
      connected: !!e.client.connected,
      toolCount: e.tools.length,
      error: e.error,
      tools: e.tools
    }));
  }
  async call(id, name, args) {
    const entry = this._conns.get(id);
    if (!entry || !entry.client.connected) throw new Error(`MCP 服务 ${id} 未连接或不存在`);
    return await entry.client.call(name, args);
  }
  async disconnect(id) {
    const entry = this._conns.get(id);
    if (entry) { try { entry.client.close(); } catch (e) {} this._conns.delete(id); }
  }
  closeAll() {
    this._conns.forEach((e) => { try { e.client.close(); } catch (_) {} });
    this._conns.clear();
  }
  // 一次性连通性测试：按 cfg 临时建连 → initialize → tools/list，拿到工具数后立刻关闭，
  // 不进 _conns、不影响已有连接。用于「新增/编辑」弹窗里的「测试连接」按钮。
  async testConnection(cfg) {
    const client = (cfg && cfg.type === "sse")
      ? new SseMcpClient({ url: cfg.url, headers: cfg.headers })
      : new StdioMcpClient({ command: cfg.command, args: cfg.args, env: cfg.env });
    try {
      await client.start();
      await client.initialize();
      const tools = await client.listTools();
      return { ok: true, toolCount: tools.length, tools };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      try { client.close(); } catch (_) {}
    }
  }
}

async function handleMcpcRequest(pathname, method, body, manager) {
  if (!pathname.startsWith("/mcpc/")) return null;
  try {
    if (pathname === "/mcpc/reconcile" && method === "POST") {
      const clients = Array.isArray(body?.clients) ? body.clients : [];
      const status = await manager.reconcile(clients);
      return { status: 200, body: { ok: true, status } };
    }
    if (pathname === "/mcpc/status" && method === "GET") {
      return { status: 200, body: { ok: true, status: manager.getStatusList() } };
    }
    if (pathname === "/mcpc/call" && method === "POST") {
      try {
        const result = await manager.call(body.id, body.name, body.args || {});
        return { status: 200, body: { ok: true, result } };
      } catch (e) {
        return { status: 200, body: { ok: false, error: e.message || String(e) } };
      }
    }
    if (pathname === "/mcpc/disconnect" && method === "POST") {
      await manager.disconnect(body?.id);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/mcpc/test" && method === "POST") {
      const result = await manager.testConnection(body?.client || {});
      return { status: 200, body: { ok: true, result } };
    }
    return { status: 404, body: { ok: false, error: "未知 /mcpc 路由" } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message || String(e) } };
  }
}

const sharedManager = new McpClientManager();

// TOFU token 门：首个带 token 的请求建立信任并落盘,之后要求匹配。
// load()=从持久层读已存 token(无则 null); persist(t)=落盘。注入以便单测。
function makeTokenGate(load, persist) {
  let token = null;
  try { token = load() || null; } catch (e) { token = null; }
  return {
    check(authHeader) {
      const t = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
      if (!token) {
        if (!t) return { ok: false, reason: "缺少 token,无法建立信任" };
        token = t;
        try { persist(t); } catch (e) {}
        return { ok: true, established: true };
      }
      if (t && t === token) return { ok: true };
      return { ok: false, reason: "token 不匹配" };
    },
    current() { return token; }
  };
}

function fileTokenGate() {
  return makeTokenGate(
    () => (fs.existsSync(MCP_TOKEN_FILE) ? fs.readFileSync(MCP_TOKEN_FILE, "utf8").trim() : null),
    (t) => {
      fs.mkdirSync(path.dirname(MCP_TOKEN_FILE), { recursive: true });
      fs.writeFileSync(MCP_TOKEN_FILE, t, { mode: 0o600 });
    }
  );
}

const sharedTokenGate = fileTokenGate();

module.exports = {
  JsonRpcClient,
  StdioMcpClient,
  SseMcpClient,
  McpClientManager,
  resolveSpawn,
  handleMcpcRequest,
  sharedManager,
  PROTOCOL_VERSION,
  makeTokenGate,
  sharedTokenGate,
  MCP_TOKEN_FILE
};
