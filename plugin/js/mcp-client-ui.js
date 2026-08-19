// plugin/js/mcp-client-ui.js
// MCP 客户端设置面板：服务卡片列表、启停开关、工具/参数查看、增删改。
// 纯渲染函数（renderServiceCard/renderToolParams）无 DOM 依赖，便于单测；
// init() 负责真实 DOM 绑定与增删改流程。
(function attachMcpClientUI(global) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderToolParams(inputSchema) {
    const props = (inputSchema && inputSchema.properties) || {};
    const required = new Set((inputSchema && inputSchema.required) || []);
    const keys = Object.keys(props);
    if (!keys.length) return `<div class="mcp-tool-params muted">无参数 —</div>`;
    const rows = keys.map((k) => {
      const p = props[k] || {};
      return `<tr><td class="mcp-p-name">${esc(k)}</td><td class="mcp-p-type">${esc(p.type || "any")}</td>`
        + `<td class="mcp-p-req">${required.has(k) ? "必填" : "可选"}</td>`
        + `<td class="mcp-p-desc">${esc(p.description || "")}</td></tr>`;
    }).join("");
    return `<table class="mcp-tool-params"><thead><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderToolList(tools) {
    if (!Array.isArray(tools) || !tools.length) return `<div class="muted">（无工具）</div>`;
    return tools.map((t) => `
      <div class="mcp-tool-item">
        <button type="button" class="mcp-tool-head" data-mcp-tool="${esc(t.name)}">
          <span class="mcp-tool-name">${esc(t.name)}</span>
          <span class="mcp-tool-desc muted">${esc(t.description || "")}</span>
        </button>
        <div class="mcp-tool-body hidden">${renderToolParams(t.inputSchema)}</div>
      </div>`).join("");
  }

  function renderServiceCard(cfg, status) {
    const st = status || { connected: false, toolCount: 0, error: null, tools: [] };
    const dot = st.connected ? "mcp-dot-on" : (st.error ? "mcp-dot-err" : "mcp-dot-off");
    const stateText = st.connected ? `已连接 (${st.toolCount} tools)` : (st.error ? "错误" : "未连接");
    const errLine = (!st.connected && st.error) ? `<div class="mcp-card-err">${esc(st.error)}</div>` : "";
    const meta = cfg.type === "sse" ? esc(cfg.url || "") : esc([cfg.command].concat(cfg.args || []).join(" "));
    return `
      <div class="mcp-client-card" data-mcp-id="${esc(cfg.id)}">
        <div class="mcp-card-top">
          <label class="mcp-switch">
            <input type="checkbox" class="mcp-enable-toggle" ${cfg.enabled ? "checked" : ""} data-mcp-id="${esc(cfg.id)}" />
            <span class="mcp-name">${esc(cfg.note || cfg.name)}</span>
            ${cfg.note ? `<span class="mcp-subname">${esc(cfg.name)}</span>` : ""}
          </label>
          <span class="mcp-type-badge">${esc(cfg.type)}</span>
          <span class="mcp-state"><i class="mcp-dot ${dot}"></i>${esc(stateText)}</span>
          <span class="mcp-card-actions">
            <button type="button" class="ghost-btn compact-btn mcp-edit-btn" data-mcp-id="${esc(cfg.id)}">编辑</button>
            <button type="button" class="ghost-btn compact-btn mcp-del-btn" data-mcp-id="${esc(cfg.id)}">删除</button>
          </span>
        </div>
        <div class="mcp-card-meta muted">${meta}</div>
        ${errLine}
        <details class="mcp-tools-wrap"><summary>工具清单 (${st.toolCount})</summary>${renderToolList(st.tools)}</details>
      </div>`;
  }

  // ---- 真实 DOM 绑定 ----
  function init(opts) {
    const { getClients, saveClients, mount } = opts || {};
    const listEl = mount || document.getElementById("mcpClientList");
    const addBtn = document.getElementById("mcpClientAddBtn");
    if (!listEl) return;

    function statusFor(id) {
      return (global.WpsAiMcpClient?.getStatus?.() || []).find((s) => s.id === id) || null;
    }
    function render() {
      const clients = getClients() || [];
      listEl.innerHTML = clients.length
        ? clients.map((c) => renderServiceCard(c, statusFor(c.id))).join("")
        : `<div class="muted">尚未配置任何 MCP 服务。点「+ 新增 MCP 服务」开始。</div>`;
    }

    function genId() {
      return "mc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    }
    function upsert(cfg) {
      const clients = (getClients() || []).slice();
      const i = clients.findIndex((c) => c.id === cfg.id);
      if (i >= 0) clients[i] = cfg; else clients.push(cfg);
      saveClients(clients);
    }
    function remove(id) {
      saveClients((getClients() || []).filter((c) => c.id !== id));
    }
    function toggle(id, enabled) {
      const clients = (getClients() || []).map((c) => (c.id === id ? Object.assign({}, c, { enabled }) : c));
      saveClients(clients);
    }

    // 简易表单弹窗（复用项目现有 modal 或 prompt 兜底）
    function openForm(existing) {
      const cfg = existing ? Object.assign({}, existing) : { id: genId(), type: "stdio", enabled: true, trusted: false, args: [], env: {} };
      const modal = buildFormModal(cfg, getClients(), (result) => { if (result) upsert(result); });
      document.body.appendChild(modal);
    }

    // 从 JSON 导入：粘贴 mcpServers 配置 → 解析 → 分配 id、处理重名 → 合并保存
    function openJsonImport() {
      const modal = buildJsonImportModal((clients) => {
        if (!clients || !clients.length) return;
        const existing = (getClients() || []).slice();
        const names = new Set(existing.map((c) => c.name));
        clients.forEach((c) => {
          let n = c.name; let i = 2;
          while (names.has(n)) { n = c.name + "-" + i; i += 1; }
          names.add(n);
          existing.push(Object.assign({}, c, { id: genId(), name: n }));
        });
        saveClients(existing);
      });
      document.body.appendChild(modal);
    }

    // 「+ 新增」下拉菜单：快速创建 / 从 JSON 导入
    let _addMenu = null;
    function closeAddMenu() {
      if (_addMenu) { _addMenu.remove(); _addMenu = null; document.removeEventListener("click", closeAddMenu); }
    }
    function showAddMenu(anchor) {
      closeAddMenu();
      const menu = document.createElement("div");
      menu.className = "mcp-add-menu";
      menu.innerHTML = '<button type="button" class="mcp-add-menu-item" data-action="quick">快速创建</button>'
        + '<button type="button" class="mcp-add-menu-item" data-action="json">从 JSON 导入</button>';
      const rect = anchor.getBoundingClientRect();
      menu.style.top = (rect.bottom + 4) + "px";
      menu.style.left = rect.left + "px";
      menu.addEventListener("click", (e) => {
        const item = e.target.closest(".mcp-add-menu-item");
        if (!item) return;
        const action = item.getAttribute("data-action");
        closeAddMenu();
        if (action === "quick") openForm(null);
        else if (action === "json") openJsonImport();
      });
      document.body.appendChild(menu);
      _addMenu = menu;
      // 下一拍再挂 document 点击关闭，避免本次点击立刻把菜单关掉
      setTimeout(() => document.addEventListener("click", closeAddMenu), 0);
    }
    addBtn?.addEventListener("click", (e) => { e.stopPropagation(); showAddMenu(addBtn); });
    listEl.addEventListener("click", (e) => {
      if (e.target.closest(".mcp-edit-btn")) { const id = e.target.getAttribute("data-mcp-id"); openForm((getClients() || []).find((c) => c.id === id)); return; }
      if (e.target.closest(".mcp-del-btn")) { const id = e.target.getAttribute("data-mcp-id"); if (confirm("删除该 MCP 服务？")) remove(id); return; }
      const head = e.target.closest(".mcp-tool-head");
      if (head) { head.nextElementSibling?.classList.toggle("hidden"); return; }
    });
    listEl.addEventListener("change", (e) => {
      if (e.target.classList.contains("mcp-enable-toggle")) toggle(e.target.getAttribute("data-mcp-id"), e.target.checked);
    });

    global.WpsAiMcpClient?.onStatusChange?.(() => render());
    render();
  }

  // 校验服务配置：名称需合法(生成 AI 工具名 mcp__<name>__<tool>,须符合工具命名规范)且在现有服务中唯一。
  // 返回错误串;通过则返回 null。existingClients 为当前已配置列表(含正在编辑的这条,按 id 排除自身)。
  function validateServiceConfig(cfg, existingClients) {
    const name = (cfg && cfg.name || "").trim();
    if (!/^[a-z0-9-]+$/.test(name)) {
      return "名称只能用小写字母、数字、连字符（会用于生成 AI 工具名 mcp__<名称>__<工具>，需符合工具命名规范）";
    }
    if ((existingClients || []).some((c) => c && c.id !== cfg.id && c.name === name)) {
      return "已存在同名服务，请换一个名称";
    }
    return null;
  }

  // 把任意 key 归一成合法名称 [a-z0-9-]（原 key 作备注名保留）
  function sanitizeName(s) {
    const n = String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    return n || "mcp";
  }

  // 解析粘贴的 MCP 配置 JSON（Claude Desktop/Code 的 { mcpServers: { 名称: {...} } } 或直接 { 名称: {...} }）
  // 返回 { clients:[{name,note,type,command/args/env 或 url/headers,enabled,trusted}], error }。纯函数，不分配 id。
  function parseMcpServersJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { clients: [], error: "JSON 格式错误：" + (e && e.message || e) }; }
    if (!obj || typeof obj !== "object") return { clients: [], error: "顶层必须是一个对象" };
    const map = (obj.mcpServers && typeof obj.mcpServers === "object") ? obj.mcpServers : obj;
    const clients = [];
    Object.keys(map).forEach((key) => {
      const val = map[key];
      if (!val || typeof val !== "object") return;
      const base = { name: sanitizeName(key), note: String(key), enabled: true, trusted: false };
      if (val.url) {
        clients.push(Object.assign(base, {
          type: "sse",
          url: String(val.url),
          headers: (val.headers && typeof val.headers === "object") ? val.headers : {}
        }));
      } else if (val.command) {
        clients.push(Object.assign(base, {
          type: "stdio",
          command: String(val.command),
          args: Array.isArray(val.args) ? val.args.map(String) : [],
          env: (val.env && typeof val.env === "object") ? val.env : {}
        }));
      }
      // 既无 url 又无 command 的条目忽略
    });
    if (!clients.length) return { clients: [], error: "未找到任何含 command 或 url 的服务" };
    return { clients, error: null };
  }

  // 从 JSON 导入弹窗：粘贴配置 → 解析 → 回调 clients（无 id，caller 负责分配/去重）
  function buildJsonImportModal(done) {
    const wrap = document.createElement("div");
    wrap.className = "mcp-form-overlay";
    const ph = '{\n  "mcpServers": {\n    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }\n  }\n}';
    wrap.innerHTML = `
      <div class="mcp-form">
        <h4>从 JSON 导入 MCP 服务</h4>
        <label>粘贴 MCP 配置 JSON（支持 { "mcpServers": { … } } 或直接 { 名称: { … } }）
          <textarea class="mcp-json-input" rows="10" placeholder='${esc(ph)}'></textarea>
        </label>
        <div class="mcp-f-test-result hidden"></div>
        <div class="mcp-form-actions">
          <span class="mcp-form-actions-spacer"></span>
          <button type="button" class="ghost-btn mcp-json-cancel">取消</button>
          <button type="button" class="primary-btn mcp-json-import">导入</button>
        </div>
      </div>`;
    const close = () => wrap.remove();
    const resultEl = wrap.querySelector(".mcp-f-test-result");
    wrap.querySelector(".mcp-json-cancel").addEventListener("click", () => { close(); done(null); });
    wrap.querySelector(".mcp-json-import").addEventListener("click", () => {
      const parsed = parseMcpServersJson(wrap.querySelector(".mcp-json-input").value);
      if (parsed.error) {
        resultEl.className = "mcp-f-test-result err";
        resultEl.textContent = parsed.error;
        return;
      }
      close();
      done(parsed.clients);
    });
    return wrap;
  }

  // 表单 modal：stdio(command/args/env) 或 sse(url/headers) + name/trusted/enabled。
  // 用最小原生 DOM 实现，样式走 .mcp-form-* 类。
  function buildFormModal(cfg, existingClients, done) {
    const wrap = document.createElement("div");
    wrap.className = "mcp-form-overlay";
    wrap.innerHTML = `
      <div class="mcp-form">
        <h4>${cfg.name ? "编辑" : "新增"} MCP 服务</h4>
        <label>备注名（显示用，可留空） <input class="mcp-f-note" value="${esc(cfg.note || "")}" placeholder="例如：我的文件系统" /></label>
        <label>名称（英文标识，用于工具名 mcp__名称__工具） <input class="mcp-f-name" value="${esc(cfg.name || "")}" placeholder="my-filesystem" /></label>
        <label>类型
          <div class="mcp-seg" role="tablist">
            <button type="button" class="mcp-seg-btn" data-type="stdio">stdio · 子进程</button>
            <button type="button" class="mcp-seg-btn" data-type="sse">sse · 远程</button>
          </div>
        </label>
        <div class="mcp-f-stdio">
          <label>命令 <input class="mcp-f-cmd" value="${esc(cfg.command || "")}" placeholder="npx" /></label>
          <label>参数(空格分隔) <input class="mcp-f-args" value="${esc((cfg.args || []).join(" "))}" placeholder="-y @anthropic/mcp-filesystem /path" /></label>
          <label>环境变量(KEY=VALUE 每行一条) <textarea class="mcp-f-env" rows="2">${esc(Object.entries(cfg.env || {}).map(([k, v]) => k + "=" + v).join("\n"))}</textarea></label>
        </div>
        <div class="mcp-f-sse hidden">
          <label>URL <input class="mcp-f-url" value="${esc(cfg.url || "")}" placeholder="http://localhost:3000/mcp/sse" /></label>
          <label>Headers(KEY=VALUE 每行一条) <textarea class="mcp-f-headers" rows="2">${esc(Object.entries(cfg.headers || {}).map(([k, v]) => k + "=" + v).join("\n"))}</textarea></label>
        </div>
        <label class="mcp-f-inline"><input type="checkbox" class="mcp-f-trusted" ${cfg.trusted ? "checked" : ""} /> 信任此服务（工具调用跳过确认）</label>
        <label class="mcp-f-inline"><input type="checkbox" class="mcp-f-enabled" ${cfg.enabled ? "checked" : ""} /> 启用</label>
        <div class="mcp-f-test-result hidden"></div>
        <div class="mcp-form-actions">
          <button type="button" class="ghost-btn mcp-f-test">测试连接</button>
          <span class="mcp-form-actions-spacer"></span>
          <button type="button" class="ghost-btn mcp-f-cancel">取消</button>
          <button type="button" class="primary-btn mcp-f-save">保存</button>
        </div>
      </div>`;
    const stdioBox = wrap.querySelector(".mcp-f-stdio");
    const sseBox = wrap.querySelector(".mcp-f-sse");
    const segBtns = wrap.querySelectorAll(".mcp-seg-btn");
    // 用段选按钮代替原生 <select>：WPS 内嵌 WebView 里原生下拉首次弹出会错位到左侧很远，
    // 且只有两个选项，段选更直观。curType 是当前选中的类型。
    let curType = cfg.type === "sse" ? "sse" : "stdio";
    function setType(t) {
      curType = t;
      segBtns.forEach((b) => b.classList.toggle("active", b.dataset.type === t));
      stdioBox.classList.toggle("hidden", t === "sse");
      sseBox.classList.toggle("hidden", t !== "sse");
    }
    segBtns.forEach((b) => b.addEventListener("click", () => setType(b.dataset.type)));
    setType(curType);

    function parseKV(text) {
      const out = {};
      String(text || "").split("\n").forEach((ln) => { const i = ln.indexOf("="); if (i > 0) out[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); });
      return out;
    }
    // 从表单读出完整 cfg（保存与测试连接共用，避免两份读取逻辑漂移）
    function readForm() {
      const result = {
        id: cfg.id,
        note: wrap.querySelector(".mcp-f-note").value.trim(),
        name: wrap.querySelector(".mcp-f-name").value.trim(),
        type: curType,
        enabled: wrap.querySelector(".mcp-f-enabled").checked,
        trusted: wrap.querySelector(".mcp-f-trusted").checked
      };
      if (curType === "stdio") {
        result.command = wrap.querySelector(".mcp-f-cmd").value.trim();
        result.args = wrap.querySelector(".mcp-f-args").value.trim().split(/\s+/).filter(Boolean);
        result.env = parseKV(wrap.querySelector(".mcp-f-env").value);
      } else {
        result.url = wrap.querySelector(".mcp-f-url").value.trim();
        result.headers = parseKV(wrap.querySelector(".mcp-f-headers").value);
      }
      return result;
    }
    function close() { wrap.remove(); }
    wrap.querySelector(".mcp-f-cancel").addEventListener("click", () => { close(); done(null); });
    wrap.querySelector(".mcp-f-save").addEventListener("click", () => {
      const result = readForm();
      const vErr = validateServiceConfig(result, existingClients);
      if (vErr) { alert(vErr); return; }
      close(); done(result);
    });
    // 测试连接：用当前表单内容临时建连，不保存、不影响已有连接
    wrap.querySelector(".mcp-f-test").addEventListener("click", async () => {
      const testBtn = wrap.querySelector(".mcp-f-test");
      const resultEl = wrap.querySelector(".mcp-f-test-result");
      resultEl.className = "mcp-f-test-result testing";
      resultEl.textContent = "测试连接中…";
      testBtn.disabled = true;
      try {
        const r = (global.WpsAiMcpClient && global.WpsAiMcpClient.testConnection)
          ? await global.WpsAiMcpClient.testConnection(readForm())
          : { ok: false, error: "MCP 客户端未加载" };
        if (r && r.ok) {
          resultEl.className = "mcp-f-test-result ok";
          resultEl.innerHTML = `<i class="mcp-dot mcp-dot-on"></i>连接成功，发现 ${r.toolCount} 个工具`;
        } else {
          resultEl.className = "mcp-f-test-result err";
          resultEl.innerHTML = `<i class="mcp-dot mcp-dot-err"></i>连接失败：${esc((r && r.error) || "未知错误")}`;
        }
      } catch (e) {
        resultEl.className = "mcp-f-test-result err";
        resultEl.innerHTML = `<i class="mcp-dot mcp-dot-err"></i>连接失败：${esc((e && e.message) || String(e))}`;
      } finally {
        testBtn.disabled = false;
      }
    });
    return wrap;
  }

  global.WpsAiMcpClientUI = { renderServiceCard, renderToolParams, renderToolList, validateServiceConfig, parseMcpServersJson, init };
})(window);
