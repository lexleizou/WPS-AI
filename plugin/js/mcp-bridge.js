// MCP 桥（plugin 侧）：开启后向 proxy-server 注册当前宿主可用工具清单，并长轮询拉取
// 来自外部 agent（Claude Code CLI 等）的工具调用，执行后回写结果。
//
// 启停由 app.js 的 setting "mcpServerEnabled" 控制：
//   - 启用 → start()：先注册工具 → 进入轮询循环
//   - 关闭 → stop()：终止轮询循环、不再注册
//
// 注册：POST /mcp/register 带 [{name, description, parameters}]
// 拉任务：GET /mcp/poll （长轮询）→ { call: {callId, name, args} | null }
// 回结果：POST /mcp/result { callId, ok, value, error }
(function attachMcpBridge(global) {
  "use strict";

  function PROXY_BASE() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }
  const REGISTER_INTERVAL_MS = 30 * 1000;  // 30s 重新注册一次（兼 keep-alive）

  // MCP 共享 token：给 proxy 侧一层"本机进程也不是谁都能调"的口令。
  // plugin 侧生成一次持久保存 → 用户复制到 MCP 客户端 config 的 env.WPS_MCP_TOKEN。
  // proxy 收到 register/poll/result 都校验 Authorization: Bearer <token>。
  // 老版 proxy 忽略 header 也不会 break；新版 proxy 开启后不带 token 就 401。
  const MCP_TOKEN_KEY = "wpsAiMcpBridgeToken";
  function getOrCreateMcpToken() {
    try {
      let t = global.WpsAiStore.getItem(MCP_TOKEN_KEY);
      if (!t) {
        const rnd = crypto?.getRandomValues
          ? Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, "0")).join("")
          : `${Date.now()}${Math.random().toString(36).slice(2)}`;
        t = `wpsai-${rnd}`;
        global.WpsAiStore.setItem(MCP_TOKEN_KEY, t);
      }
      return t;
    } catch (e) {
      return "";
    }
  }
  function mcpAuthHeaders(extra) {
    const t = getOrCreateMcpToken();
    const h = Object.assign({}, extra || {});
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  }

  let _enabled = false;
  let _pollAbort = null;
  let _registerTimer = null;
  let _status = {
    enabled: false,
    connected: false,
    lastRegisteredAt: 0,
    lastError: null,
    toolCount: 0
  };
  const _listeners = new Set();

  // 最近 N 次外部 agent 调用日志：给用户一个「谁 / 什么工具 / 是否成功 / 耗时」的可视化窗口，
  // 之前 MCP 面板只能显示当前状态，用户完全不知道有没有 agent 在调、调了什么。
  //
  // 关键：bridge 只在主面板轮询/执行/记录，但「调用日志」在独立的 ?mode=settings 窗口显示——
  // 那个窗口是**另一个 bridge 实例**，内存 _callLog 永远空。所以日志必须持久化到共享存储
  // （SQLite 受管键），设置窗口从存储读并靠 storage 事件实时刷新，而不是读自己实例的内存。
  const CALL_LOG_CAP = 50;
  const CALL_LOG_KEY = "lingxi_mcp_call_log_v1";
  let _callLog = (() => {
    try {
      const raw = global.WpsAiStore?.getItem?.(CALL_LOG_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, CALL_LOG_CAP) : [];
    } catch (e) { return []; }
  })();
  const _callListeners = new Set();
  function persistCallLog() {
    try { global.WpsAiStore?.setItem?.(CALL_LOG_KEY, JSON.stringify(_callLog)); } catch (e) {}
  }
  function recordCall(entry) {
    _callLog.unshift(entry);
    if (_callLog.length > CALL_LOG_CAP) _callLog.length = CALL_LOG_CAP;
    persistCallLog();
    _callListeners.forEach((cb) => { try { cb(entry, _callLog.slice()); } catch (e) {} });
  }
  // 优先返回共享存储里的最新日志（设置窗口读到的才是主面板记录的），存储不可用退内存
  function listRecentCalls() {
    try {
      const raw = global.WpsAiStore?.getItem?.(CALL_LOG_KEY);
      if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.slice(); }
    } catch (e) {}
    return _callLog.slice();
  }
  function onCall(cb) { _callListeners.add(cb); return () => _callListeners.delete(cb); }
  function clearCallLog() { _callLog = []; persistCallLog(); _callListeners.forEach((cb) => { try { cb(null, []); } catch (e) {} }); }
  // WpsAiStore hydrate 后重灌（boot 时机同其它缓存），否则设置窗口早于 store 就绪读到空
  function reloadCallLogFromStore() {
    try {
      const raw = global.WpsAiStore?.getItem?.(CALL_LOG_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) _callLog = arr.slice(0, CALL_LOG_CAP);
    } catch (e) {}
  }

  function emit() {
    _listeners.forEach((cb) => {
      try { cb({ ..._status }); } catch (e) {}
    });
  }
  function onStatusChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

  // 拿 plugin 注册的**所有**工具（跨宿主），让外部 agent 看到完整 API surface。
  // 每条工具描述前面附上 [host: ...] 标记，agent 能据此选择合适的调用时机。
  function collectAllTools() {
    const reg = global.WpsAiToolRegistry;
    if (!reg?.listAll) return [];
    const defs = reg.listAll();
    return defs.map((d) => {
      const hosts = Array.isArray(d.hosts) ? d.hosts : (d.hosts ? [d.hosts] : ["*"]);
      const hostTag = hosts.includes("*") ? "any" : hosts.join("/");
      const descPrefix = `[host: ${hostTag}] `;
      return {
        name: d.name,
        description: descPrefix + (d.description || ""),
        hosts,
        // MCP 标准字段叫 inputSchema；本插件 def.parameters 已是 JSON Schema
        parameters: d.parameters || { type: "object", properties: {} },
        inputSchema: d.parameters || { type: "object", properties: {} }
      };
    });
  }

  async function registerOnce() {
    const tools = collectAllTools();
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcp/register`, {
        method: "POST",
        headers: mcpAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ tools })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _status.connected = true;
      _status.lastRegisteredAt = Date.now();
      _status.toolCount = tools.length;
      _status.lastError = null;
      emit();
      return true;
    } catch (e) {
      _status.connected = false;
      _status.lastError = e?.message || String(e);
      emit();
      return false;
    }
  }

  async function pollOnce(signal) {
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcp/poll`, { signal, headers: mcpAuthHeaders() });
      if (!resp.ok) {
        _status.connected = false;
        _status.lastError = `poll HTTP ${resp.status}`;
        emit();
        // 修 B11：proxy 在线但返回非 2xx（401/404/500 等）时必须退避，否则 pollLoop 立刻
        // 再发下一个请求形成全速热循环，打满 CPU/连接。
        await new Promise((r) => setTimeout(r, 2000));
        return;
      }
      _status.connected = true;
      _status.lastError = null;
      emit();
      const json = await resp.json();
      const call = json?.call;
      if (!call) return; // 25s 空 poll，回头再 poll
      handleCall(call); // 不 await，让下一轮 poll 尽快回到 server
    } catch (e) {
      if (e?.name === "AbortError") return;
      _status.connected = false;
      _status.lastError = e?.message || String(e);
      emit();
      // 错误时延一拍再 poll，防止打爆 proxy 不在线时的循环
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function handleCall(call) {
    const { callId, name, args } = call;
    const startedAt = Date.now();
    let resultBody;
    try {
      const reg = global.WpsAiToolRegistry;
      if (!reg?.execute) throw new Error("WpsAiToolRegistry 未加载");
      const r = await reg.execute(name, args || {});
      resultBody = { callId, ok: !!r?.ok, value: r?.value, error: r?.error || null };
    } catch (e) {
      resultBody = { callId, ok: false, error: e?.message || String(e) };
    }
    const elapsedMs = Date.now() - startedAt;
    // 记录到最近调用日志：args / value 都取 preview（100 字），完整数据不入 log 避免爆内存
    const preview = (v) => {
      if (v == null) return "";
      try {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return s.length > 120 ? s.slice(0, 120) + "…" : s;
      } catch (e) { return String(v).slice(0, 120); }
    };
    recordCall({
      at: startedAt,
      callId,
      name,
      argsPreview: preview(args),
      ok: !!resultBody.ok,
      error: resultBody.error || null,
      elapsedMs,
      resultPreview: resultBody.ok ? preview(resultBody.value) : ""
    });
    try {
      await fetch(`${PROXY_BASE()}/mcp/result`, {
        method: "POST",
        headers: mcpAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(resultBody)
      });
    } catch (e) {
      console.warn("[mcp-bridge] 回传结果失败：", e?.message || e);
    }
  }

  // 修 B37：防止快速 stop()/start() 产生两条并发 pollLoop 互相覆盖 _pollAbort。
  let _pollLoopRunning = false;
  async function pollLoop() {
    if (_pollLoopRunning) return; // 已有一条在跑，_enabled 恢复后它会自行继续
    _pollLoopRunning = true;
    try {
      while (_enabled) {
        const ac = new AbortController();
        _pollAbort = ac;
        await pollOnce(ac.signal);
      }
    } finally {
      _pollAbort = null;
      _pollLoopRunning = false;
    }
  }

  function start() {
    if (_enabled) return;
    _enabled = true;
    _status.enabled = true;
    emit();
    // 立即注册一次 + 进入轮询；周期性 keep-alive
    registerOnce();
    if (_registerTimer) clearInterval(_registerTimer);
    _registerTimer = setInterval(registerOnce, REGISTER_INTERVAL_MS);
    pollLoop();
  }

  function stop() {
    if (!_enabled) return;
    _enabled = false;
    _status.enabled = false;
    _status.connected = false;
    emit();
    if (_registerTimer) { clearInterval(_registerTimer); _registerTimer = null; }
    if (_pollAbort) {
      try { _pollAbort.abort(); } catch (e) {}
      _pollAbort = null;
    }
  }

  function getStatus() { return { ..._status }; }

  global.WpsAiMcpBridge = {
    start,
    stop,
    getStatus,
    onStatusChange,
    listRecentCalls,
    onCall,
    clearCallLog,
    reloadCallLogFromStore,
    getToken: getOrCreateMcpToken,
    PROXY_BASE
  };
})(window);
