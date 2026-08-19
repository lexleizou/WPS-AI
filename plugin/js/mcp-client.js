// plugin/js/mcp-client.js
// MCP Client（plugin 侧）：经 proxy /mcpc/* 连接外部 MCP 服务，把其工具以
// mcp__<service>__<tool> 注册进 WpsAiToolRegistry。stdio/SSE 连接都在 proxy 侧持有。
(function attachMcpClient(global) {
  "use strict";

  function PROXY_BASE() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }
  function authHeaders(extra) {
    const t = global.WpsAiMcpBridge?.getToken?.() || "";
    const h = Object.assign({}, extra || {});
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  }

  const NS_PREFIX = "mcp__";
  function namespacedName(service, tool) { return `${NS_PREFIX}${service}__${tool}`; }

  // MCP result → registry value。content[] 里的 text 拼接；isError=true → {ok:false}
  function normalizeResult(mcpResult) {
    const parts = Array.isArray(mcpResult?.content)
      ? mcpResult.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean)
      : [];
    const text = parts.join("\n");
    if (mcpResult?.isError) return { ok: false, error: text || "MCP 工具返回错误" };
    return { ok: true, value: text };
  }

  let _status = [];
  const _listeners = new Set();
  const _registered = new Set(); // 已注册的命名空间工具名，便于变更时注销
  function emit() { _listeners.forEach((cb) => { try { cb(_status.slice()); } catch (e) {} }); }
  function onStatusChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
  function getStatus() { return _status.slice(); }

  function unregisterAll() {
    const reg = global.WpsAiToolRegistry;
    _registered.forEach((name) => { try { reg?.unregisterTool?.(name); } catch (e) {} });
    _registered.clear();
  }

  function registerToolsFromStatus(status) {
    const reg = global.WpsAiToolRegistry;
    if (!reg?.registerTool) return;
    unregisterAll();
    (status || []).forEach((svc) => {
      if (!svc.connected || !Array.isArray(svc.tools)) return;
      svc.tools.forEach((tool) => {
        const nsName = namespacedName(svc.name, tool.name);
        const originalName = tool.name;
        const serviceId = svc.id;
        reg.registerTool({
          name: nsName,
          hosts: ["*"],
          description: `[mcp: ${svc.name}] ${tool.description || ""}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
          mcpService: svc.name,
          handler: async (args) => {
            const resp = await fetch(`${PROXY_BASE()}/mcpc/call`, {
              method: "POST",
              headers: authHeaders({ "Content-Type": "application/json" }),
              body: JSON.stringify({ id: serviceId, name: originalName, args: args || {} })
            });
            const json = await resp.json();
            if (!json.ok) throw new Error(json.error || "MCP 调用失败");
            const norm = normalizeResult(json.result);
            if (!norm.ok) throw new Error(norm.error); // 让 registry.execute catch 成 {ok:false,error}
            return json.result; // 返回原始 result，保留完整结构给上层/日志
          }
        });
        _registered.add(nsName);
      });
    });
  }

  async function reconcile(clients) {
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcpc/reconcile`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ clients: clients || [] })
      });
      if (!resp.ok) {
        let msg = `代理返回 HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const json = await resp.json();
      if (json && json.ok === false) throw new Error(json.error || "reconcile 失败");
      _status = Array.isArray(json.status) ? json.status : [];
      registerToolsFromStatus(_status);
      emit();
      return _status;
    } catch (e) {
      _status = (clients || []).map((c) => ({ id: c.id, name: c.name, connected: false, toolCount: 0, error: e?.message || "proxy 未响应", tools: [] }));
      unregisterAll();
      emit();
      return _status;
    }
  }

  // 一次性连通性测试：把单条 cfg 发给 proxy /mcpc/test，临时建连拿工具数后关闭。
  // 返回 { ok, toolCount, error }；网络/proxy 层失败也归一化成 { ok:false, error }。
  async function testConnection(cfg) {
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcpc/test`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ client: cfg || {} })
      });
      if (!resp.ok) {
        let msg = `代理返回 HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) {}
        return { ok: false, error: msg };
      }
      const json = await resp.json();
      if (json && json.ok === false) return { ok: false, error: json.error || "测试失败" };
      return json.result || { ok: false, error: "无返回结果" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "proxy 未响应" };
    }
  }

  global.WpsAiMcpClient = { reconcile, testConnection, namespacedName, normalizeResult, getStatus, onStatusChange, PROXY_BASE };
})(window);
