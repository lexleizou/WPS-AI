(function attachToolRegistry(global) {
  "use strict";

  /**
   * 统一工具注册表，桥接到各宿主的实际操作。
   *
   * 工具定义结构：
   *   {
   *     name: "et_write_range",
   *     hosts: ["et"],                      // 适用宿主，"*" 表示通用
   *     description: "...",
   *     parameters: { ... JSON Schema },    // OpenAI/Anthropic 通用
   *     handler: async (args) => result     // 实际执行
   *   }
   */

  const registry = new Map();

  function registerTool(definition) {
    if (!definition?.name) throw new Error("tool definition missing name");
    if (typeof definition.handler !== "function") throw new Error(`tool ${definition.name} missing handler`);
    registry.set(definition.name, definition);
  }

  function unregisterTool(name) {
    registry.delete(name);
  }

  function getDefinition(name) {
    return registry.get(name) || null;
  }

  function applicableHosts(definition) {
    if (!definition?.hosts) return ["*"];
    return Array.isArray(definition.hosts) ? definition.hosts : [definition.hosts];
  }

  /**
   * 列出当前宿主可用的工具定义（用于发给模型）。
   */
  function listForHost(host) {
    const out = [];
    registry.forEach((def) => {
      const hosts = applicableHosts(def);
      if (hosts.includes("*") || hosts.includes(host)) {
        out.push(def);
      }
    });
    return out;
  }

  /**
   * 列出 plugin 注册的全部工具（跨所有宿主），MCP 桥用 —— 外部 agent 不应被
   * 当前宿主限制看到的工具集合，能看到完整 API surface（执行时 def.hosts 决定可不可用）
   */
  function listAll() {
    const out = [];
    registry.forEach((def) => {
      if (!def.internal) out.push(def);
    });
    return out;
  }

  function toOpenAIToolSpec(def) {
    return {
      type: "function",
      function: {
        name: def.name,
        description: def.description || "",
        parameters: def.parameters || { type: "object", properties: {} }
      }
    };
  }

  /**
   * Codex 用的 Responses API 工具结构（顶层 type/name/parameters，不嵌套 function）。
   */
  function toCodexToolSpec(def) {
    return {
      type: "function",
      name: def.name,
      description: def.description || "",
      parameters: def.parameters || { type: "object", properties: {} }
    };
  }

  function toAnthropicToolSpec(def) {
    return {
      name: def.name,
      description: def.description || "",
      input_schema: def.parameters || { type: "object", properties: {} }
    };
  }

  /**
   * 执行工具调用，返回 { ok, value, error }。永不抛错。
   * 如果是修改型工具，自动把"调用前 → 调用后"快照写入 WpsAiHistory，
   * 用户在面板「改动记录」Tab 能看到 AI 做了什么。
   */
  async function execute(name, args = {}, ctx = {}) {
    const def = registry.get(name);
    if (!def) {
      return { ok: false, error: `未知工具：${name}` };
    }

    const history = global.WpsAiHistory;
    const snap = global.WpsAiSnapshot;
    const recordable = history && snap && history.isMutatingTool(name);

    let target = null;
    let before = null;
    let captureAfterFn = null;
    let host = "*";
    let docPath = null;

    if (recordable) {
      try {
        host = snap.detectHost();
        // 修改型工具调用前的"必须先保存"前置检查：临时文档/新建未存盘的不让 AI 改
        docPath = global.WpsAiBackup?.getCurrentDocPath?.() || null;
        if (!docPath) {
          return {
            ok: false,
            error: "当前文档尚未保存到磁盘（临时文档）,AI 拒绝执行修改型操作。请先按 Ctrl-S / Cmd-S 把文档存到磁盘,所有改动会关联到这个具体文件。"
          };
        }
        // 修改型工具调用前确保本轮已有文档备份（首个修改型工具触发，懒备份）
        try { await history.ensureBackupForTurn?.(); } catch (e) {}
        const pre = await snap.captureBefore(host, name, args);
        target = pre?.target || null;
        before = pre?.before || null;
        captureAfterFn = pre?._captureAfter || null;
      } catch (e) { /* snapshot 失败不影响主流程 */ }
    }

    let result;
    try {
      // Word 用 Document.Protect 锁住后 COM 也写不了，要临时解锁执行后再加锁
      // Excel 用 UserInterfaceOnly 不需要 tempUnlock；PPT 没硬锁也不需要。
      // WpsAiLock.tempUnlock 自动判断：没锁 / 非 Word / 解锁失败 都直接调 fn
      const runner = global.WpsAiLock?.tempUnlock
        ? () => global.WpsAiLock.tempUnlock(() => def.handler(args || {}, ctx))
        : () => def.handler(args || {}, ctx);
      const value = await runner();
      result = { ok: true, value };
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }

    if (recordable) {
      // AI 操作跟随提示：修改成功后把改动位置滚动/选中到可见（Word 滚动跟随 / Excel 选中区域）。
      // 失败静默，绝不影响工具主流程。
      if (result.ok) {
        try { global.WpsAiFollow?.afterMutatingTool?.(host, name, args, result.value); } catch (e) {}
      }
      try {
        const after = result.ok ? await snap.captureAfter(captureAfterFn) : null;
        // 裁剪 params 里特别大的字段（如 body / svg 等）
        const slimParams = sanitizeParams(args);
        const summary = summarizeResult(result);
        history.addEntry({
          host, toolName: name,
          friendlyName: history.getFriendlyName(name),
          target,
          params: slimParams,
          before, after,
          ok: result.ok,
          resultSummary: summary,
          error: result.ok ? null : (result.error || "未知错误"),
          docPath
        });
      } catch (e) {
        console.warn("[tools] history.addEntry 失败", e);
      }
    }

    return result;
  }

  function sanitizeParams(p) {
    if (!p || typeof p !== "object") return p;
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string" && v.length > 500) {
        out[k] = v.slice(0, 500) + `…（共 ${v.length} 字符）`;
      } else if (typeof v === "object") {
        try {
          const s = JSON.stringify(v);
          out[k] = s.length > 1000 ? `[object ${s.length} 字符]` : v;
        } catch (e) { out[k] = "[object]"; }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function summarizeResult(result) {
    if (!result) return "";
    if (!result.ok) return `失败：${result.error}`;
    const v = result.value;
    if (v == null) return "完成";
    if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "…" : v;
    if (typeof v === "object") {
      // 优先一些常见字段
      if (v.slide && v.template) return `第 ${v.slide} 页 → 模板 ${v.template}`;
      if (v.slide && v.chartType) return `第 ${v.slide} 页 → 图表 ${v.chartType}`;
      if (v.slide && v.added) return `第 ${v.slide} 页 → 加了 ${v.added} 项`;
      if (v.affected != null) return `影响 ${v.affected} 项`;
      try {
        const s = JSON.stringify(v);
        return s.length > 100 ? s.slice(0, 100) + "…" : s;
      } catch (e) { return "完成"; }
    }
    return String(v);
  }

  /**
   * 把工具结果序列化成模型能消费的字符串（JSON）。
   */
  function serializeResult(result) {
    if (!result) return JSON.stringify({ ok: false, error: "no result" });
    if (result.ok) {
      return JSON.stringify({ ok: true, value: result.value });
    }
    return JSON.stringify({ ok: false, error: result.error });
  }

  global.WpsAiToolRegistry = {
    registerTool,
    unregisterTool,
    getDefinition,
    listForHost,
    listAll,
    toOpenAIToolSpec,
    toCodexToolSpec,
    toAnthropicToolSpec,
    execute,
    serializeResult
  };
})(window);
