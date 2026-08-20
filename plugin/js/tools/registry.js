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

  function replacementAllows(definition, previous) {
    const expected = definition?.replaces;
    const previousOrigin = previous?.origin || "legacy";
    if (expected === true || expected === previousOrigin) return true;
    return Array.isArray(expected) && expected.includes(previousOrigin);
  }

  function registerTool(definition) {
    if (!definition?.name) throw new Error("tool definition missing name");
    if (typeof definition.handler !== "function") throw new Error(`tool ${definition.name} missing handler`);
    const previous = registry.get(definition.name);
    if (previous && !replacementAllows(definition, previous)) {
      throw new Error(`duplicate tool registration: ${definition.name}; declare replaces: \"${previous.origin || "legacy"}\" to override it`);
    }
    registry.set(definition.name, Object.assign({ origin: "legacy" }, definition));
  }

  function valueMatchesType(value, type) {
    if (Array.isArray(type)) return type.some((item) => valueMatchesType(value, item));
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  }

  // WPS WebView 无构建步骤；这里只实现现有工具 schema 真正使用到的安全子集，
  // 让 required/type/enum/边界不再只是发给模型看的提示。
  function validateSchema(schema, value, path = "args") {
    if (!schema || typeof schema !== "object") return [];
    if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
      const candidates = schema.anyOf.map((item) => validateSchema(item, value, path));
      return candidates.some((errors) => errors.length === 0) ? [] : candidates[0];
    }
    if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
      const candidates = schema.oneOf.map((item) => validateSchema(item, value, path));
      return candidates.some((errors) => errors.length === 0) ? [] : candidates[0];
    }
    const errors = [];
    if (schema.type && !valueMatchesType(value, schema.type)) {
      errors.push(`${path} 应为 ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`);
      return errors;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
      errors.push(`${path} 不在允许值 ${schema.enum.join("/")} 中`);
    }
    if (typeof value === "string") {
      if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path} 长度不能小于 ${schema.minLength}`);
      if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} 长度不能大于 ${schema.maxLength}`);
      if (schema.pattern) {
        try { if (!(new RegExp(schema.pattern)).test(value)) errors.push(`${path} 格式不匹配`); } catch (e) {}
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path} 不能小于 ${schema.minimum}`);
      if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path} 不能大于 ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${path} 至少需要 ${schema.minItems} 项`);
      if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} 最多允许 ${schema.maxItems} 项`);
      if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      (schema.required || []).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) errors.push(`${path}.${key} 为必填项`);
      });
      Object.entries(schema.properties || {}).forEach(([key, child]) => {
        if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
          errors.push(...validateSchema(child, value[key], `${path}.${key}`));
        }
      });
    }
    return errors;
  }

  async function detectCurrentHost() {
    try {
      const host = global.WpsAiSnapshot?.detectHost?.();
      if (host && host !== "*") return String(host);
    } catch (e) {}
    try {
      const host = await global.WpsAiDocument?.getHost?.();
      if (host) return String(host);
    } catch (e) {}
    return "*";
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

    const schemaErrors = validateSchema(def.parameters || { type: "object" }, args || {});
    if (schemaErrors.length) {
      return { ok: false, error: `INVALID_TOOL_ARGUMENTS: ${schemaErrors.slice(0, 5).join("；")}` };
    }

    let host = await detectCurrentHost();
    const hosts = applicableHosts(def);
    if (!hosts.includes("*") && !hosts.includes(host)) {
      return { ok: false, error: `HOST_MISMATCH: 工具 ${name} 仅适用于 ${hosts.join("/")}，当前宿主为 ${host}` };
    }

    const history = global.WpsAiHistory;
    const snap = global.WpsAiSnapshot;
    const backup = global.WpsAiBackup;
    const inferredMutation = !!history?.isMutatingTool?.(name);
    const sideEffect = def.sideEffect || (inferredMutation ? "document" : "none");
    const mutatesDocument = sideEffect === "document";
    const recordable = mutatesDocument && !!history && !!snap;

    let target = null;
    let before = null;
    let captureAfterFn = null;
    let docPath = null;

    if (mutatesDocument) {
      if (!history || !snap || !backup) {
        return { ok: false, error: "BACKUP_REQUIRED: Writer 修改安全模块未完整加载，本次操作未执行。" };
      }
      if (global.WpsAiDocumentMutation?.prepare) {
        const prepared = await global.WpsAiDocumentMutation.prepare({ label: `external:${name}`, toolName: name });
        if (!prepared.ok) return { ok: false, error: prepared.error || prepared.code || "BACKUP_REQUIRED" };
        docPath = prepared.docPath;
      } else {
        // 独立测试/降级加载路径仍保持严格 fail-closed；正式 main.js 会走上面的统一协调器。
        if (history.isCurrentTurnBlocked?.()) {
          return { ok: false, error: "TURN_MUTATION_BLOCKED: 本轮已有修改失败并已进入回滚状态，请开始新一轮后再操作。" };
        }
        docPath = backup.getCurrentDocPath?.() || null;
        if (!docPath) {
          return {
            ok: false,
            error: "当前文档尚未保存到磁盘（临时文档）,AI 拒绝执行修改型操作。请先按 Ctrl-S / Cmd-S 把文档存到磁盘,所有改动会关联到这个具体文件。"
          };
        }
        try {
          if (!history.getCurrentTurnId?.()) history.startTurn?.(`external:${name}`);
          const backupInfo = await history.ensureBackupForTurn?.();
          const backupError = history.getTurnBackupError?.();
          if (backupError || !backupInfo?.backupPath) {
            return {
              ok: false,
              error: `BACKUP_REQUIRED: 文档备份未成功${backupError ? `（${backupError}）` : ""}，本次修改型操作未执行。`
            };
          }
          const currentPath = backup.getCurrentDocPath?.() || null;
          const samePath = history.pathsEqual ? history.pathsEqual(currentPath, backupInfo.docPath || docPath) : currentPath === (backupInfo.docPath || docPath);
          if (!samePath) {
            return { ok: false, error: "DOCUMENT_CHANGED_DURING_BACKUP: 备份期间活动文档发生变化，本次操作未执行。" };
          }
        } catch (e) {
          return { ok: false, error: `BACKUP_REQUIRED: ${e?.message || e}` };
        }
      }
      try {
        const pre = await snap.captureBefore(host, name, args);
        target = pre?.target || null;
        before = pre?.before || null;
        captureAfterFn = pre?._captureAfter || null;
      } catch (e) { /* 快照只影响历史展示；持久备份已成功，主流程可继续 */ }
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
      if (mutatesDocument && global.WpsAiDocumentMutation?.assessResult) {
        const assessment = global.WpsAiDocumentMutation.assessResult(value);
        if (!assessment.ok) {
          const detail = assessment.issues.map((item) => `${item.label}:${item.detail}`).join("；");
          const rollback = await global.WpsAiDocumentMutation.rollbackCurrentTurn(detail);
          result = { ok: false, error: `PARTIAL_MUTATION: ${detail}`, rollback };
        } else {
          result = { ok: true, value };
        }
      } else {
        result = { ok: true, value };
      }
    } catch (error) {
      const message = error?.message || String(error);
      let rollback = null;
      if (mutatesDocument && global.WpsAiDocumentMutation?.rollbackCurrentTurn) {
        rollback = await global.WpsAiDocumentMutation.rollbackCurrentTurn(message);
      }
      result = { ok: false, error: message, rollback };
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
