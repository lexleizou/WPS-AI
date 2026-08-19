(() => {
  "use strict";

  const MARKER = "LINGXI_GRAPHITE_TASKPANE_V1";
  const PROMPT_STORE_KEY = "lingxi.graphite.prompt-presets.v1";
  const PROMPT_ACTIVE_KEY = "lingxi.graphite.prompt-presets.active.v1";
  const PROMPT_CORRUPT_KEY = "lingxi.graphite.prompt-presets.corrupt.v1";
  const LEGACY_URS_PROMPT = "请检查当前打开的桓科 URS 文档。先完整扫描并建立文档地图，再按锚点精读高风险章节并核对段落格式；检查字体字号、缩进与间距、表格、页眉页脚、目录与编号、缩写定义。不得改变技术含义、审批结论、业务要求或签批信息；无法可靠判断的内容列入待确认事项，不得猜测。执行中连续推进，不要求我反复回复“继续”；完成后按分类汇报检查范围、已修改问题、未发现问题和待确认事项。";
  const PREVIOUS_URS_PROMPT = "请检查当前打开的桓科 URS 文档。必须在最终答复前连续完成三个只读阶段，并按顺序实际调用工具：① wps_get_document_map 建立完整文档地图；② 根据地图锚点和文档指纹调用 wps_read_by_anchor 精读高风险章节；③ 对已读取的关键范围调用 wps_read_paragraph_format 核对段落格式。不得只建立地图后就结束或询问我是否继续。随后检查字体字号、缩进与间距、表格、页眉页脚、目录与编号、缩写定义。不得改变技术含义、审批结论、业务要求或签批信息；无法可靠判断的内容列入待确认事项，不得猜测。完成后按分类汇报检查范围、已修改问题、未发现问题和待确认事项。";
  const PREVIEW_URS_PREVIOUS_PROMPT = "请检查当前打开的桓科 URS 文档。涉及内容/结构风险时，先调用 wps_get_document_map 建立完整文档地图，再按锚点和文档指纹调用 wps_read_by_anchor 精读高风险章节；涉及字体、字号、行距、缩进、对齐或段前段后时，必须先调用 wps_audit_paragraph_format 审计实际差异。若 mismatchCount 为 0，明确报告无需修改，绝不写入；若大于 0，只调用 wps_apply_paragraph_format_mismatches，再审计复核到 0。不得用 wps_format_paragraph(scope=document) 全量覆盖已符合的段落。检查字体字号、缩进与间距、表格、页眉页脚、目录与编号、缩写定义；但不得改变技术含义、审批结论、业务要求或签批信息。无法可靠判断的内容列入待确认事项，不得猜测。完成后按分类汇报检查范围、实际修改的问题、未发现问题和待确认事项。";
  const URS_PROMPT = "请检查当前打开的桓科 URS 文档，并严格执行两阶段流程。阶段一（只读，禁止任何写入）：必须先调用 wps_get_document_map 建立完整文档地图；再按锚点和文档指纹调用 wps_read_by_anchor 精读高风险章节；涉及字体、字号、行距、缩进、对齐或段前段后时，必须调用 wps_audit_paragraph_format 审计实际差异。随后输出“修改预览”：列出检查范围、每类问题的锚点、拟修改动作、预计影响数量、不会修改的内容和待确认事项；此时必须停止，等待我明确回复“确认按预览修改”。阶段二（只有收到该确认后）：若 mismatchCount 为 0，明确报告无需修改，绝不写入；若大于 0，只调用 wps_apply_paragraph_format_mismatches，再审计复核到 0。不得用 wps_format_paragraph(scope=document) 全量覆盖已符合的段落。检查字体字号、缩进与间距、表格、页眉页脚、目录与编号、缩写定义；但不得改变技术含义、审批结论、业务要求或签批信息。无法可靠判断的内容列入待确认事项，不得猜测。完成后按分类汇报检查范围、实际修改的问题、未发现问题和待确认事项。";
  const DEFAULT_PROMPT_PRESETS = Object.freeze([
    Object.freeze({
      id: "preset-urs-review",
      name: "桓科 URS 检查",
      prompt: URS_PROMPT,
      experience: ""
    }),
    Object.freeze({
      id: "preset-readonly-inspection",
      name: "文档只读体检",
      prompt: "对当前文档执行只读检查：依次使用 wps_get_document_map 建立地图，使用 wps_read_by_anchor 精读关键范围，再用 wps_read_paragraph_format 审计格式。不要修改文档。输出结构问题、格式异常、证据锚点、风险等级和建议处理顺序。",
      experience: ""
    }),
    Object.freeze({
      id: "preset-professional-polish",
      name: "专业润色",
      prompt: "润色当前选区或我随后提供的内容，使表达专业、清晰、简洁。保持事实、技术含义、数字、专有名词和审批结论不变；不要补造信息。先给出修改稿，再简要列出关键调整。",
      experience: ""
    })
  ]);
  const SPECIAL_MODES = [
    "settings-mode", "preview-mode", "stylepreset-mode", "materials-mode",
    "quickprompt-mode", "formatpreview-mode", "selectionpreview-mode",
    "paralleltranslate-mode", "conversations-mode"
  ];
  const SPECIAL_MODE_PARAMS = new Set([
    "settings", "preview", "stylepreset", "materials", "conversations",
    "quickprompt", "formatpreview", "selectionpreview", "paralleltranslate"
  ]);

  function byId(id) { return document.getElementById(id); }
  function isMainTaskPane() {
    const mode = String(new URLSearchParams(window.location.search).get("mode") || "").toLowerCase();
    if (SPECIAL_MODE_PARAMS.has(mode)) return false;
    return !SPECIAL_MODES.some((name) => document.documentElement.classList.contains(name));
  }

  function setTabLabel(button, label) {
    if (!button) return;
    const text = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (text) text.nodeValue = label;
    else button.insertBefore(document.createTextNode(label), button.firstChild || null);
    button.setAttribute("aria-label", label);
  }

  function paperclipSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.8l8.6-8.6"/></svg>';
  }

  const INSPECTION_PHASES = Object.freeze([
    Object.freeze({ key: "map", tool: "wps_get_document_map", aliases: ["wps_get_document_map"], label: "建立文档地图", live: "正在建立文档地图" }),
    Object.freeze({ key: "read", tool: "wps_read_by_anchor", aliases: ["wps_read_by_anchor"], label: "读取锚点范围", live: "正在读取锚点内容" }),
    Object.freeze({ key: "format", tool: "wps_read_paragraph_format", aliases: ["wps_read_paragraph_format", "wps_audit_paragraph_format"], label: "核对段落格式", live: "正在核对段落格式" })
  ]);
  const INSPECTION_BY_TOOL = new Map(INSPECTION_PHASES.flatMap((phase) => (phase.aliases || [phase.tool]).map((tool) => [tool, phase])));
  const inspectionControllers = new Set();
  const promptPresetFilledValues = new WeakMap();
  let inspectionStopRequested = false;

  function createNode(className, text) {
    const node = document.createElement("div");
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatInspectionDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    return `${(ms / 1000).toFixed(1)}秒`;
  }

  function inspectionRange(args = {}) {
    const start = String(args.startAnchor || "").trim();
    const end = String(args.endAnchor || "").trim();
    if (start && end) return start === end ? start : `${start}–${end}`;
    if (start) return start;
    const anchors = Array.isArray(args.anchors) ? args.anchors.filter(Boolean) : [];
    if (anchors.length) return anchors.length === 1 ? String(anchors[0]) : `${anchors.length} 个离散锚点`;
    const keyword = String(args.aroundKeyword || "").trim();
    if (keyword) return `关键词「${keyword}」附近`;
    return "按文档地图定位";
  }

  function inspectionPhaseDetail(phase) {
    let detail;
    if (phase.key === "map") detail = phase.tool;
    else if (phase.key === "read") detail = inspectionRange(phase.args);
    else if (phase.key === "format" && phase.args?.requirements) {
      const mismatches = Number(phase.result?.mismatchCount || 0);
      detail = mismatches ? `格式差异审计 · ${mismatches} 段待处理` : "格式差异审计 · 全部符合";
    } else if (phase.key === "format") {
      const range = inspectionRange(phase.args);
      detail = phase.args?.groupSimilar === false ? range : `${range} · 合并连续相同格式`;
    } else detail = phase.tool;
    if (phase.calls > 1) detail += ` · ${phase.calls} 次调用`;
    if (phase.status === "error" && phase.result?.error) detail += ` · ${String(phase.result.error).slice(0, 120)}`;
    return detail;
  }

  function processInspectionToolNames(process) {
    return Array.from(process?.querySelectorAll?.(".tl-tool-row .tl-step-name") || [])
      .map((node) => String(node.textContent || "").trim())
      .filter(Boolean);
  }

  function ensureInspectionLiveBar() {
    let bar = byId("lingxiInspectionLiveBar");
    if (bar) return bar;
    const inputBox = document.querySelector(".chat-input-box");
    if (!inputBox?.parentNode) return null;
    bar = createNode("lingxi-inspection-live hidden");
    bar.id = "lingxiInspectionLiveBar";

    const pulse = document.createElement("span");
    pulse.className = "lingxi-inspection-live-pulse";
    pulse.setAttribute("aria-hidden", "true");
    const copy = createNode("lingxi-inspection-live-copy");
    copy.setAttribute("role", "status");
    copy.setAttribute("aria-live", "polite");
    const title = createNode("lingxi-inspection-live-title", "正在检查文档");
    const subtitle = createNode("lingxi-inspection-live-subtitle", "只读检查；本步骤不会修改文档内容");
    copy.append(title, subtitle);
    const stop = document.createElement("button");
    stop.id = "lingxiInspectionStop";
    stop.className = "lingxi-inspection-live-stop";
    stop.type = "button";
    stop.textContent = "停止";
    stop.addEventListener("click", () => {
      const original = byId("chatStopBtn");
      if (original && !original.classList.contains("hidden")) original.click();
    });
    bar.append(pulse, copy, stop);
    inputBox.parentNode.insertBefore(bar, inputBox);
    return bar;
  }

  function updateInspectionLiveBar() {
    const bar = ensureInspectionLiveBar();
    if (!bar) return;
    let active = null;
    inspectionControllers.forEach((controller) => {
      const candidate = controller.activePhase();
      if (candidate && (!active || candidate.startedAt > active.startedAt)) active = candidate;
    });
    bar.classList.toggle("hidden", !active);
    if (!active) return;
    const title = bar.querySelector(".lingxi-inspection-live-title");
    if (title) title.textContent = active.live;
  }

  function createInspectionController(turn, options = {}) {
    const phases = new Map(INSPECTION_PHASES.map((meta) => [meta.key, {
      ...meta, status: "pending", args: {}, result: null, startedAt: 0, elapsedMs: 0, calls: 0, nodes: null, originalCalls: []
    }]));
    let card = null;
    let cardBody = null;
    let titleNode = null;
    let summaryNode = null;
    let countNode = null;
    let chevronNode = null;
    let timer = null;
    let finalized = false;
    let stopped = false;

    function ensureCard() {
      if (card) return card;
      card = createNode("lingxi-inspection-card");
      card.dataset.state = "running";
      card.setAttribute("data-lingxi-inspection-progress", "1");
      const header = document.createElement("button");
      header.type = "button";
      header.className = "lingxi-inspection-head";
      header.setAttribute("aria-expanded", "true");
      const badge = document.createElement("span");
      badge.className = "lingxi-inspection-badge";
      badge.setAttribute("aria-hidden", "true");
      const heading = createNode("lingxi-inspection-heading");
      titleNode = createNode("lingxi-inspection-title", "文档检查进行中");
      summaryNode = createNode("lingxi-inspection-summary", "3 个步骤 · 已完成 0 项");
      heading.append(titleNode, summaryNode);
      countNode = createNode("lingxi-inspection-count", "0 / 3");
      chevronNode = createNode("lingxi-inspection-chevron", "⌃");
      chevronNode.setAttribute("aria-hidden", "true");
      header.append(badge, heading, countNode, chevronNode);
      cardBody = createNode("lingxi-inspection-body");
      INSPECTION_PHASES.forEach((meta) => {
        const phase = phases.get(meta.key);
        const row = createNode("lingxi-inspection-step");
        row.dataset.status = "pending";
        const dot = document.createElement("span");
        dot.className = "lingxi-inspection-step-dot";
        dot.setAttribute("aria-hidden", "true");
        const content = createNode("lingxi-inspection-step-content");
        const top = createNode("lingxi-inspection-step-top");
        const label = createNode("lingxi-inspection-step-label", meta.label);
        const state = createNode("lingxi-inspection-step-state", "待执行");
        const detail = createNode("lingxi-inspection-step-detail", meta.tool);
        top.append(label, state);
        content.append(top, detail);
        row.append(dot, content);
        cardBody.appendChild(row);
        phase.nodes = { row, state, detail };
      });
      header.addEventListener("click", () => {
        const collapsed = card.classList.toggle("is-collapsed");
        header.setAttribute("aria-expanded", String(!collapsed));
        chevronNode.textContent = collapsed ? "⌄" : "⌃";
      });
      card.append(header, cardBody);
      const source = Array.from(turn.rail.querySelectorAll(".tl-step-process"))
        .find((node) => processInspectionToolNames(node).some((name) => INSPECTION_BY_TOOL.has(name)));
      if (source) turn.rail.insertBefore(card, source);
      else turn.rail.appendChild(card);
      return card;
    }

    function syncSourceProcesses() {
      if (!card) return;
      let pureSource = null;
      let mixedSource = null;
      turn.rail.querySelectorAll(".tl-step-process").forEach((process) => {
        process.querySelectorAll(".tl-tool-row").forEach((row) => {
          const name = String(row.querySelector(".tl-step-name")?.textContent || "").trim();
          const meta = INSPECTION_BY_TOOL.get(name);
          const phase = meta && phases.get(meta.key);
          if (phase?.status !== "stopped") return;
          const status = row.querySelector(".tl-step-status");
          if (status) status.className = "tl-step-status tl-step-status-stopped";
        });
        const names = processInspectionToolNames(process);
        const inspectorCount = names.filter((name) => INSPECTION_BY_TOOL.has(name)).length;
        const pure = inspectorCount > 0 && inspectorCount === names.length;
        process.classList.toggle("lingxi-inspection-source-hidden", pure);
        if (pure && !pureSource) pureSource = process;
        else if (inspectorCount > 0 && !mixedSource) mixedSource = process;
      });
      if (pureSource && card.nextSibling !== pureSource) turn.rail.insertBefore(card, pureSource);
      else if (!pureSource && mixedSource && mixedSource.nextSibling !== card) turn.rail.insertBefore(card, mixedSource.nextSibling);
    }

    function currentElapsed(phase) {
      const running = phase.status === "running" && phase.startedAt ? Date.now() - phase.startedAt : 0;
      return phase.elapsedMs + running;
    }

    function inspectionPath(values) {
      const called = new Set(values.filter((phase) => phase.status !== "pending").map((phase) => phase.key));
      const succeeded = new Set(values.filter((phase) => phase.status === "ok").map((phase) => phase.key));
      const all = INSPECTION_PHASES.map((phase) => phase.key);
      if (all.every((key) => succeeded.has(key))) return { id: "full", title: "文档检查完成", expected: all, notRequired: new Set(), description: "全面检查" };
      if (succeeded.has("map") && succeeded.has("format") && !called.has("read")) {
        return { id: "format", title: "格式检查完成", expected: ["map", "format"], notRequired: new Set(["read"]), description: "纯格式检查" };
      }
      if (succeeded.has("map") && succeeded.has("read") && !called.has("format")) {
        return { id: "read", title: "内容精读完成", expected: ["map", "read"], notRequired: new Set(["format"]), description: "内容精读" };
      }
      if (succeeded.has("map") && !called.has("read") && !called.has("format")) {
        return { id: "map", title: "文档地图已建立", expected: ["map"], notRequired: new Set(), description: "尚未开始精读或格式审计" };
      }
      const expected = all.filter((key) => called.has(key) || values.find((phase) => phase.key === key)?.status === "running");
      return { id: "partial", title: "文档检查未完成", expected: expected.length ? expected : all, notRequired: new Set(), description: "检查路径未完整" };
    }

    function statusLabel(status, notRequired) {
      if (notRequired) return "无需执行";
      if (status === "pending") return finalized ? "未执行" : "待执行";
      return status === "running" ? "执行中" : status === "ok" ? "完成" : status === "error" ? "失败" : status === "stopped" ? "已停止" : "待执行";
    }

    function render() {
      if (!card) return;
      const values = Array.from(phases.values());
      const completed = values.filter((phase) => phase.status === "ok").length;
      const errors = values.filter((phase) => phase.status === "error").length;
      const running = values.some((phase) => phase.status === "running");
      const path = inspectionPath(values);
      const expectedCompleted = path.expected.filter((key) => phases.get(key)?.status === "ok").length;
      const pathComplete = path.expected.length > 0 && expectedCompleted === path.expected.length && !running;
      const incomplete = finalized && !stopped && !errors && !pathComplete;
      const state = stopped ? "stopped" : errors ? "error" : pathComplete ? "done" : incomplete ? "incomplete" : running ? "running" : "pending";
      card.dataset.state = state;
      card.dataset.path = path.id;
      titleNode.textContent = stopped
        ? "文档检查已停止"
        : errors ? (finalized ? "文档检查结束（有错误）" : "文档检查遇到问题")
          : pathComplete ? path.title : incomplete ? "文档检查未完成" : running ? "文档检查进行中" : "等待后续检查步骤";
      const uncalled = path.expected.length - expectedCompleted;
      const extras = errors ? ` · ${errors} 项失败` : finalized && uncalled > 0 ? ` · ${uncalled} 项未执行` : "";
      summaryNode.textContent = `${path.description} · 已完成 ${expectedCompleted} 项${extras}`;
      countNode.textContent = `${expectedCompleted} / ${path.expected.length || INSPECTION_PHASES.length}`;
      values.forEach((phase) => {
        const notRequired = pathComplete && path.notRequired.has(phase.key);
        phase.nodes.row.dataset.status = notRequired ? "not-required" : phase.status === "pending" && finalized ? "not-run" : phase.status;
        phase.nodes.state.textContent = statusLabel(phase.status, notRequired);
        const duration = phase.status === "pending" ? "" : formatInspectionDuration(currentElapsed(phase));
        const baseDetail = notRequired ? `无需执行（${path.description}）` : inspectionPhaseDetail(phase);
        const detail = baseDetail + (duration ? ` · ${duration}` : "");
        phase.nodes.detail.textContent = detail;
        phase.nodes.detail.title = detail;
      });
      syncSourceProcesses();
      updateInspectionLiveBar();
    }

    function ensureTimer() {
      if (timer) return;
      timer = window.setInterval(() => {
        if (!Array.from(phases.values()).some((phase) => phase.status === "running")) {
          window.clearInterval(timer);
          timer = null;
          return;
        }
        render();
      }, 250);
    }

    function start(toolName, args, originalRef) {
      const meta = INSPECTION_BY_TOOL.get(toolName);
      if (!meta) return null;
      ensureCard();
      finalized = false;
      stopped = false;
      const phase = phases.get(meta.key);
      phase.status = "running";
      phase.args = args || {};
      phase.result = null;
      phase.startedAt = Date.now();
      phase.calls += 1;
      phase.originalCalls.push({ ref: originalRef, terminal: false });
      inspectionControllers.add(api);
      ensureTimer();
      render();
      return { __lingxiInspection: true, key: meta.key, name: toolName, startedAt: phase.startedAt };
    }

    function accepts(ref) {
      if (!ref || finalized || stopped) return false;
      const phase = phases.get(ref.key);
      const call = phase?.originalCalls.find((item) => item.ref === ref.originalRef);
      return !!phase && (!call || !call.terminal);
    }

    function finish(ref, result) {
      if (!accepts(ref)) { render(); return; }
      const phase = phases.get(ref.key);
      const call = phase.originalCalls.find((item) => item.ref === ref.originalRef);
      if (call) call.terminal = true;
      if (phase.startedAt) phase.elapsedMs += Math.max(0, Date.now() - phase.startedAt);
      phase.startedAt = 0;
      phase.result = result;
      phase.status = result?.ok === false ? "error" : "ok";
      render();
    }

    function hydrate(steps) {
      const inspectorSteps = (steps || []).filter((step) => step?.kind === "tool" && INSPECTION_BY_TOOL.has(step.name));
      if (!inspectorSteps.length) return false;
      ensureCard();
      inspectorSteps.forEach((step) => {
        const meta = INSPECTION_BY_TOOL.get(step.name);
        const phase = phases.get(meta.key);
        phase.calls += 1;
        phase.args = step.args || {};
        phase.result = step.result || null;
        phase.elapsedMs += Number.isFinite(step.elapsedMs) ? Math.max(0, step.elapsedMs) : 0;
        phase.status = step.status === "running" ? "stopped" : step.status === "error" ? "error" : "ok";
      });
      stopped = inspectorSteps.some((step) => step.status === "running");
      finalized = true;
      render();
      return true;
    }

    function finishTurn(wasStopped) {
      if (!card || finalized) return;
      stopped = !!wasStopped;
      phases.forEach((phase) => {
        if (phase.status !== "running") return;
        phase.originalCalls.filter((call) => !call.terminal).forEach((call) => {
          try { options.finishOriginal?.(call.ref, { ok: false, error: stopped ? "已停止" : "工具未返回结果" }); } catch (error) {}
          call.terminal = true;
        });
        if (phase.startedAt) phase.elapsedMs += Math.max(0, Date.now() - phase.startedAt);
        phase.startedAt = 0;
        phase.status = stopped ? "stopped" : "error";
      });
      finalized = true;
      if (timer) { window.clearInterval(timer); timer = null; }
      inspectionControllers.delete(api);
      render();
    }

    function expand() {
      if (!card) return;
      card.classList.remove("is-collapsed");
      card.querySelector(".lingxi-inspection-head")?.setAttribute("aria-expanded", "true");
      if (chevronNode) chevronNode.textContent = "⌃";
    }

    const api = {
      start,
      accepts,
      finish,
      hydrate,
      finishTurn,
      expand,
      syncSources: syncSourceProcesses,
      activePhase: () => Array.from(phases.values()).find((phase) => phase.status === "running") || null
    };
    return api;
  }

  function installInspectionTimelineBridge() {
    const timeline = window.WpsAiChatTimeline;
    if (!timeline || typeof timeline.beginAssistantTurn !== "function") {
      window.setTimeout(installInspectionTimelineBridge, 100);
      return;
    }
    if (timeline.__lingxiInspectionBridge) return;
    const originalBegin = timeline.beginAssistantTurn;
    const originalRender = typeof timeline.renderAssistantTurn === "function" ? timeline.renderAssistantTurn : null;
    timeline.beginAssistantTurn = function wrappedInspectionAssistantTurn() {
      const turn = originalBegin.apply(this, arguments);
      if (!turn?.rail || typeof turn.addToolStep !== "function" || typeof turn.finishToolStep !== "function") return turn;
      const originalAdd = turn.addToolStep.bind(turn);
      const originalFinish = turn.finishToolStep.bind(turn);
      const originalExpand = typeof turn.expandToolStep === "function" ? turn.expandToolStep.bind(turn) : null;
      const controller = createInspectionController(turn, { finishOriginal: originalFinish });
      turn.addToolStep = function wrappedInspectionAdd(name, args) {
        const originalRef = originalAdd(name, args);
        if (!INSPECTION_BY_TOOL.has(name)) {
          controller.syncSources();
          return originalRef;
        }
        const inspectionRef = controller.start(name, args, originalRef);
        inspectionRef.originalRef = originalRef;
        return inspectionRef;
      };
      turn.finishToolStep = function wrappedInspectionFinish(ref, result) {
        if (ref?.__lingxiInspection) {
          if (controller.accepts(ref)) originalFinish(ref.originalRef, result);
          controller.finish(ref, result);
        } else {
          originalFinish(ref, result);
          controller.syncSources();
        }
      };
      turn.expandToolStep = function wrappedInspectionExpand(ref) {
        if (ref?.__lingxiInspection) {
          originalExpand?.(ref.originalRef);
          controller.expand();
        } else originalExpand?.(ref);
      };
      return turn;
    };
    if (originalRender) {
      timeline.renderAssistantTurn = function wrappedInspectionReplay(opts) {
        const node = originalRender.apply(this, arguments);
        const rail = node?.querySelector?.(".tl-rail");
        if (!rail) return node;
        const controller = createInspectionController({ rail });
        controller.hydrate(opts?.steps || []);
        return node;
      };
    }
    timeline.__lingxiInspectionBridge = true;
    window.WpsAiGraphiteInspection = { phases: INSPECTION_PHASES.map((phase) => ({ ...phase })) };
  }

  function installInspectionBusyObserver() {
    const stopButton = byId("chatStopBtn");
    if (!stopButton || stopButton.dataset.lingxiInspectionBound === "1") return;
    stopButton.dataset.lingxiInspectionBound = "1";
    let wasBusy = !stopButton.classList.contains("hidden");
    stopButton.addEventListener("click", () => {
      inspectionStopRequested = true;
      inspectionControllers.forEach((controller) => controller.finishTurn(true));
    }, true);
    const observer = new MutationObserver(() => {
      const busy = !stopButton.classList.contains("hidden");
      if (wasBusy && !busy) inspectionControllers.forEach((controller) => controller.finishTurn(inspectionStopRequested));
      if (!busy) inspectionStopRequested = false;
      wasBusy = busy;
    });
    observer.observe(stopButton, { attributes: true, attributeFilter: ["class"] });
  }

  // Document-wide review-and-edit requests use a conversational summary preview, never the full-document rewrite modal.
  const writePreviewGate = { phase: "idle", originalRequest: "", stagedRequest: "", mapSeen: false, autoPreviewPending: false, previewTurnStarted: false };
  const WRITE_PREVIEW_CONFIRM = /^(?:确认|同意|继续)(?:按预览)?(?:修改|执行|处理)?[。！!，,\s]*$/;
  const DOCUMENT_WIDE_REVIEW_EDIT = /(?:URS|需求规格|用户需求|当前文档|整个文档|整份文档|全文|通篇|整篇).{0,120}(?:检查|审查|核对|复核).{0,180}(?:修改|修复|改写|润色|统一|补充|删除)|(?:检查|审查|核对|复核).{0,180}(?:全文|通篇|整篇|当前文档|整个文档|整份文档).{0,180}(?:修改|修复|改写|润色|统一|补充|删除)/i;
  const LONG_REWRITE_ROUTE_TERMS = [[/全文|通篇|整篇|全篇|逐段|各章节|整个文档/g, "当前文档"], [/改写|润色|扩写|精简|缩写|重写|调整结构|重新组织|统一语气|统一术语/g, "处理"]];

  function escapedStagingRequest(request) {
    return LONG_REWRITE_ROUTE_TERMS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(request || ""));
  }

  function ensureWritePreviewGateBar() {
    let bar = byId("lingxiWritePreviewGate");
    if (bar) return bar;
    const inputBox = document.querySelector(".chat-input-box");
    if (!inputBox?.parentNode) return null;
    bar = createNode("div", "");
    bar.id = "lingxiWritePreviewGate";
    bar.className = "lingxi-write-preview-gate hidden";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    inputBox.parentNode.insertBefore(bar, inputBox);
    return bar;
  }

  function renderWritePreviewGate() {
    const bar = ensureWritePreviewGateBar();
    if (!bar) return;
    const copy = writePreviewGate.phase === "mapping"
      ? "修改安全流程：正在建立文档地图；本阶段不会写入 WPS。"
      : writePreviewGate.phase === "map_received" || writePreviewGate.phase === "previewing"
        ? "地图已建立：正在生成对话式修改预览；本阶段不会写入 WPS。"
      : writePreviewGate.phase === "awaiting_confirmation"
        ? "修改预览已就绪：请核对对话中的范围与锚点，回复“确认按预览修改”后才会写入 WPS。"
        : writePreviewGate.phase === "approved"
          ? "已确认预览：仅执行对话摘要中列出的最小修改。"
          : "";
    bar.textContent = copy;
    bar.classList.toggle("hidden", !copy);
    bar.dataset.phase = writePreviewGate.phase;
  }

  function installDocumentPreviewGate() {
    const input = byId("chatInput");
    const send = byId("chatSendBtn");
    if (!input || !send || send.dataset.lingxiPreviewGateBound === "1") return;
    send.dataset.lingxiPreviewGateBound = "1";
    send.addEventListener("click", () => {
      const typed = String(input.value || "").trim();
      if (!typed) return;
      if (writePreviewGate.phase === "awaiting_confirmation" && WRITE_PREVIEW_CONFIRM.test(typed)) {
        // Keep the model on the normal Writer route: its preceding turn contains the map and summary preview.
        input.value = "用户已确认刚才的修改预览。现在直接在 WPS 中仅执行预览列出的最小修改；按锚点处理，跳过已符合项，不得批量重制整份文稿，不得弹出整份文稿预览窗口。完成后复核并汇报实际修改与待确认事项。";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        writePreviewGate.phase = "approved";
        renderWritePreviewGate();
        return;
      }
      if (!DOCUMENT_WIDE_REVIEW_EDIT.test(typed)) {
        if (writePreviewGate.phase === "approved" && typed !== writePreviewGate.originalRequest) {
          writePreviewGate.phase = "idle"; writePreviewGate.originalRequest = ""; writePreviewGate.mapSeen = false; renderWritePreviewGate();
        }
        return;
      }
      if (writePreviewGate.phase === "approved" && typed === writePreviewGate.originalRequest) return;
      writePreviewGate.originalRequest = typed;
      writePreviewGate.stagedRequest = escapedStagingRequest(typed);
      writePreviewGate.phase = "mapping";
      writePreviewGate.mapSeen = false;
      writePreviewGate.autoPreviewPending = false;
      writePreviewGate.previewTurnStarted = false;
      // This text intentionally avoids the local full-document rewrite trigger in app.js.
      input.value = [
        "【阶段一：只读地图与修改摘要预览】",
        `用户原始目标：${writePreviewGate.stagedRequest}`,
        "本回合只能调用一次 wps_get_document_map 建立文档地图；调用成功后立刻结束本回合，不得继续读取、不得输出结论、不得写入。",
        "禁止调用任何会修改 WPS 的工具，禁止分段生成完整文稿，禁止生成或打开整份文稿预览窗口。下一回合会自动根据地图生成对话式修改预览。"
      ].join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      renderWritePreviewGate();
    }, true);
    const stop = byId("chatStopBtn");
    if (!stop || stop.dataset.lingxiPreviewGateBusyBound === "1") return;
    stop.dataset.lingxiPreviewGateBusyBound = "1";
    let wasBusy = !stop.classList.contains("hidden");
    const observer = new MutationObserver(() => {
      const busy = !stop.classList.contains("hidden");
      if (wasBusy && !busy && writePreviewGate.autoPreviewPending && writePreviewGate.phase === "map_received") {
        writePreviewGate.autoPreviewPending = false;
        writePreviewGate.previewTurnStarted = true;
        writePreviewGate.phase = "previewing";
        input.value = [
          "【阶段二：只读修改预览】",
          "基于上一轮已经建立的文档地图，按锚点读取与原始目标相关的范围，必要时审计格式差异。",
          "仅在本对话输出修改预览：检查范围、问题分类、证据锚点、每类拟修改动作、预计影响数量、不会修改的内容、待确认事项。",
          "禁止调用任何写入 WPS 的工具。输出预览后立即结束，并等待用户明确回复“确认按预览修改”。"
        ].join("\n");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        renderWritePreviewGate();
        window.setTimeout(() => send.click(), 0);
      } else if (wasBusy && !busy && writePreviewGate.previewTurnStarted && writePreviewGate.phase === "previewing") {
        writePreviewGate.previewTurnStarted = false;
        writePreviewGate.phase = "awaiting_confirmation";
        renderWritePreviewGate();
      }
      wasBusy = busy;
    });
    observer.observe(stop, { attributes: true, attributeFilter: ["class"] });
  }

  function installDocumentPreviewToolGate() {
    const registry = window.WpsAiToolRegistry;
    if (!registry?.execute || registry.__lingxiPreviewGate) { return; }
    const originalExecute = registry.execute.bind(registry);
    registry.execute = async function guardedPreviewExecute(name, args, ctx) {
      const preConfirmation = ["mapping", "map_received", "previewing", "awaiting_confirmation"].includes(writePreviewGate.phase);
      const mutating = name?.startsWith("wps_") && !!window.WpsAiHistory?.isMutatingTool?.(name);
      // 地图/审计/摘要预览必须完全不打断用户阅读；显式定位同样属于视图副作用。
      const viewChanging = ["reveal_location", "wps_goto_bookmark", "wps_set_view"].includes(name);
      if (mutating && preConfirmation) {
        return { ok: false, error: "PREVIEW_GATE_REQUIRED：此任务必须先建立文档地图、在对话中给出修改摘要预览，并等待用户明确确认；当前禁止写入 WPS。" };
      }
      if (viewChanging && preConfirmation) {
        return { ok: false, error: "READ_ONLY_SCAN_NO_NAVIGATION：文档地图、审计和修改预览期间不得改变用户正在阅读的位置。请只返回锚点和摘要，写入成功后系统会自动定位到实际修改处。" };
      }
      const result = await originalExecute(name, args, ctx);
      if (name === "wps_get_document_map" && result?.ok && writePreviewGate.phase === "mapping") {
        writePreviewGate.mapSeen = true;
        writePreviewGate.phase = "map_received";
        writePreviewGate.autoPreviewPending = true;
        renderWritePreviewGate();
        // A hard boundary: abort the map-only turn before the model can queue a writer call.
        window.setTimeout(() => {
          const stop = byId("chatStopBtn");
          if (stop && !stop.classList.contains("hidden")) stop.click();
        }, 0);
      }
      return result;
    };
    registry.__lingxiPreviewGate = true;
  }

  // Persistent task data remains owned by the original todo_replace_all/todo_patch tools.
  // This controller only projects that fact into a truthful, compact Graphite UI.
  const TASK_STATUS = Object.freeze({
    pending: { label: "待处理", symbol: "○" },
    in_progress: { label: "正在执行", symbol: "◌" },
    completed: { label: "已完成", symbol: "✓" },
    failed: { label: "失败", symbol: "!" },
    skipped: { label: "已跳过", symbol: "–" },
    stopped: { label: "已停止", symbol: "■" },
    blocked: { label: "被阻塞", symbol: "·" }
  });
  const taskProgressRuntime = { stoppedIds: new Set(), failedIds: new Set(), stopEpoch: 0, expanded: false, lastSignature: "", observer: null, unsubscribe: null };

  function normalizeTaskSnapshot(state, runtime = taskProgressRuntime) {
    const todos = Array.isArray(state?.todos) ? state.todos : [];
    const hasTerminalProblem = todos.some((task) => ["failed", "stopped"].includes(task.status) || runtime.failedIds.has(task.id) || runtime.stoppedIds.has(task.id));
    return todos.map((task) => {
      const id = String(task?.id || "");
      let status = TASK_STATUS[task?.status] ? task.status : "pending";
      if (runtime.stoppedIds.has(id) && status === "in_progress") status = "stopped";
      if (runtime.failedIds.has(id) && status === "in_progress") status = "failed";
      if (status === "pending" && hasTerminalProblem) status = "blocked";
      return { id, title: String(task?.title || "未命名任务"), detail: String(task?.detail || ""), status, updatedAt: Number(task?.updatedAt || 0) };
    });
  }

  function deriveTaskSummary(tasks) {
    const total = tasks.length;
    const completed = tasks.filter((task) => task.status === "completed").length;
    const settled = tasks.filter((task) => ["completed", "skipped", "failed", "stopped", "blocked"].includes(task.status)).length;
    const active = tasks.find((task) => task.status === "in_progress");
    const failed = tasks.filter((task) => task.status === "failed").length;
    const stopped = tasks.filter((task) => task.status === "stopped").length;
    const blocked = tasks.filter((task) => task.status === "blocked").length;
    const skipped = tasks.filter((task) => task.status === "skipped").length;
    const state = stopped ? "stopped" : failed ? "failed" : blocked ? "blocked" : active ? "running" : completed === total && total ? "done" : "pending";
    const current = active || tasks.find((task) => ["failed", "stopped", "blocked"].includes(task.status)) || tasks.find((task) => task.status === "pending") || tasks[tasks.length - 1] || null;
    return { total, completed, settled, active, failed, stopped, blocked, skipped, state, current, percent: total ? Math.round((completed / total) * 100) : 0 };
  }

  function taskPanelSource() { return window.WpsAiConversations?.getConversationTodos?.() || { todos: [] }; }
  function ensureTaskProgressPanel(hasTasks) {
    let panel = byId("chatTodoPanel");
    if (panel || !hasTasks) return panel;
    const streamWrap = document.querySelector("#chatStream")?.closest(".chat-stream-wrap");
    if (!streamWrap?.parentNode) return null;
    panel = document.createElement("div");
    panel.id = "chatTodoPanel";
    panel.className = "chat-todo-panel hidden";
    streamWrap.parentNode.insertBefore(panel, streamWrap);
    return panel;
  }
  function taskPanelSignature(tasks) { return tasks.map((task) => [task.id, task.status, task.title, task.detail, task.updatedAt].join("|")).join("||") + `#${taskProgressRuntime.stopEpoch}`; }

  function setTaskExpanded(expanded) {
    taskProgressRuntime.expanded = !!expanded;
    try { localStorage.setItem("lingxi_graphite_task_progress_expanded", expanded ? "1" : "0"); } catch (error) {}
    renderTaskProgress(true);
  }

  function renderTaskProgress(force = false) {
    const source = taskPanelSource();
    const tasks = normalizeTaskSnapshot(source);
    const signature = taskPanelSignature(tasks);
    if (!force && signature === taskProgressRuntime.lastSignature) return;
    taskProgressRuntime.lastSignature = signature;
    const panel = ensureTaskProgressPanel(tasks.length > 0);
    if (!panel) return;
    if (!tasks.length) {
      panel.classList.add("hidden");
      panel.replaceChildren();
      return;
    }
    const summary = deriveTaskSummary(tasks);
    panel.classList.remove("hidden", "collapsed");
    panel.classList.add("lingxi-task-progress");
    panel.dataset.state = summary.state;
    panel.dataset.expanded = String(taskProgressRuntime.expanded);
    panel.setAttribute("aria-label", "任务进度");
    const compact = document.createElement("button");
    compact.type = "button";
    compact.className = "lingxi-task-compact";
    compact.setAttribute("aria-expanded", String(taskProgressRuntime.expanded));
    compact.setAttribute("aria-controls", "lingxiTaskProgressDetail");
    const compactState = TASK_STATUS[summary.state === "running" ? "in_progress" : summary.state === "done" ? "completed" : summary.state] || TASK_STATUS.pending;
    const compactIcon = createNode("span", compactState.symbol);
    compactIcon.className = "lingxi-task-compact-icon";
    compactIcon.setAttribute("aria-hidden", "true");
    const compactCopy = createNode("span", null);
    compactCopy.className = "lingxi-task-compact-copy";
    compactCopy.append(createNode("span", `${summary.completed}/${summary.total}`), createNode("span", summary.current?.title || "任务进度"));
    const compactStatus = createNode("span", compactState.label);
    compactStatus.className = "lingxi-task-compact-status";
    compact.append(compactIcon, compactCopy, compactStatus);
    compact.addEventListener("click", () => setTaskExpanded(!taskProgressRuntime.expanded));

    const detail = document.createElement("section");
    detail.id = "lingxiTaskProgressDetail";
    detail.className = "lingxi-task-detail";
    detail.hidden = !taskProgressRuntime.expanded;
    const head = document.createElement("div");
    head.className = "lingxi-task-head";
    const heading = createNode("div", null);
    heading.className = "lingxi-task-heading";
    heading.append(createNode("strong", "任务进度"), createNode("span", `${summary.completed}/${summary.total} 已完成`));
    const status = createNode("span", compactState.label);
    status.className = "lingxi-task-head-status";
    head.append(heading, status);
    const bar = document.createElement("div");
    bar.className = "lingxi-task-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(summary.total));
    bar.setAttribute("aria-valuenow", String(summary.completed));
    bar.setAttribute("aria-label", `已完成 ${summary.completed} / ${summary.total}`);
    const barFill = document.createElement("span");
    barFill.style.width = `${summary.percent}%`;
    bar.appendChild(barFill);
    const list = document.createElement("ol");
    list.className = "lingxi-task-list";
    tasks.forEach((task) => {
      const meta = TASK_STATUS[task.status] || TASK_STATUS.pending;
      const item = document.createElement("li");
      item.className = "lingxi-task-item";
      item.dataset.status = task.status;
      const icon = createNode("span", meta.symbol);
      icon.className = "lingxi-task-item-icon";
      icon.setAttribute("aria-hidden", "true");
      const content = createNode("span", null);
      content.className = "lingxi-task-item-content";
      // Details are reserved for the active/problem step so the bounded list stays readable.
      content.append(createNode("span", task.title), task.detail && ["in_progress", "failed", "stopped"].includes(task.status) ? createNode("small", task.detail) : document.createTextNode(""));
      const itemStatus = createNode("span", meta.label);
      itemStatus.className = "lingxi-task-item-status";
      item.append(icon, content, itemStatus);
      list.appendChild(item);
    });
    const foot = createNode("div", null);
    foot.className = "lingxi-task-foot";
    const outcome = summary.failed ? `${summary.failed} 项失败` : summary.stopped ? `${summary.stopped} 项已停止` : summary.blocked ? `${summary.blocked} 项被阻塞` : summary.skipped ? `${summary.skipped} 项已跳过` : summary.active ? "状态来自真实工具调用" : summary.completed === summary.total ? "全部步骤已完成" : "等待任务开始";
    foot.textContent = outcome;
    detail.append(head, bar, list, foot);
    panel.replaceChildren(compact, detail);
  }

  function installTaskProgressOverlay() {
    if (window.__lingxiTaskProgressOverlay) return;
    window.__lingxiTaskProgressOverlay = true;
    try { taskProgressRuntime.expanded = localStorage.getItem("lingxi_graphite_task_progress_expanded") === "1"; } catch (error) {}
    const bind = () => {
      const conversations = window.WpsAiConversations;
      if (conversations?.subscribe && !taskProgressRuntime.unsubscribe) taskProgressRuntime.unsubscribe = conversations.subscribe(() => renderTaskProgress(true));
      const panel = byId("chatTodoPanel");
      if (panel && !taskProgressRuntime.observer) {
        taskProgressRuntime.observer = new MutationObserver(() => {
          // The business renderer may replace this panel after conversation notify; reclaim it only then.
          if (!panel.querySelector(":scope > .lingxi-task-compact")) window.requestAnimationFrame(() => renderTaskProgress(true));
        });
        taskProgressRuntime.observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      }
      renderTaskProgress(true);
      if (!panel || !taskProgressRuntime.unsubscribe) window.setTimeout(bind, 100);
    };
    bind();
  }

  function installTaskProgressTimelineBridge() {
    const timeline = window.WpsAiChatTimeline;
    if (!timeline?.beginAssistantTurn) { window.setTimeout(installTaskProgressTimelineBridge, 100); return; }
    if (timeline.__lingxiTaskProgressBridge) return;
    const originalBegin = timeline.beginAssistantTurn;
    timeline.beginAssistantTurn = function wrappedTaskProgressAssistantTurn() {
      const turn = originalBegin.apply(this, arguments);
      if (!turn?.addToolStep || !turn?.finishToolStep) return turn;
      const originalAdd = turn.addToolStep.bind(turn);
      const originalFinish = turn.finishToolStep.bind(turn);
      turn.addToolStep = function wrappedTaskProgressAdd(name, args) {
        const originalRef = originalAdd(name, args);
        if (name === "todo_replace_all") {
          taskProgressRuntime.stoppedIds.clear(); taskProgressRuntime.failedIds.clear(); taskProgressRuntime.stopEpoch += 1;
        } else if (name === "todo_patch" && args?.id) {
          taskProgressRuntime.stoppedIds.delete(String(args.id)); taskProgressRuntime.failedIds.delete(String(args.id));
        }
        return { __lingxiTaskProgress: true, name, args: args || {}, epoch: taskProgressRuntime.stopEpoch, originalRef };
      };
      turn.finishToolStep = function wrappedTaskProgressFinish(ref, result) {
        const sourceRef = ref?.__lingxiTaskProgress ? ref.originalRef : ref;
        originalFinish(sourceRef, result);
        if (!ref?.__lingxiTaskProgress) { renderTaskProgress(true); return; }
        const isError = result?.ok === false;
        if (ref.name === "todo_patch" && isError && ref.args?.id && ref.epoch === taskProgressRuntime.stopEpoch) taskProgressRuntime.failedIds.add(String(ref.args.id));
        // An old tool response after Stop may persist internally, but cannot overwrite the stopped display projection.
        if (ref.epoch === taskProgressRuntime.stopEpoch || !taskProgressRuntime.stoppedIds.size) renderTaskProgress(true);
      };
      return turn;
    };
    timeline.__lingxiTaskProgressBridge = true;
  }

  function installTaskProgressStopBridge() {
    const stop = byId("chatStopBtn");
    if (!stop || stop.dataset.lingxiTaskProgressBound === "1") return;
    stop.dataset.lingxiTaskProgressBound = "1";
    stop.addEventListener("click", () => {
      normalizeTaskSnapshot(taskPanelSource()).filter((task) => task.status === "in_progress").forEach((task) => taskProgressRuntime.stoppedIds.add(task.id));
      taskProgressRuntime.stopEpoch += 1;
      renderTaskProgress(true);
    }, true);
  }

  // Keep live reasoning/tool evidence open, then collapse it to an auditable one-line summary when the turn ends.
  const liveProcessRails = new Set();

  function processDisclosureNodes(rail) {
    return Array.from(rail?.querySelectorAll?.(".tl-step-process") || []);
  }
  function setProcessDisclosure(node, expanded) {
    const head = node?.querySelector?.(".tl-step-head");
    const detail = node?.querySelector?.(".tl-step-detail");
    if (!head || !detail) return;
    if (expanded) detail.removeAttribute("hidden");
    else detail.setAttribute("hidden", "");
    head.setAttribute("aria-expanded", String(!!expanded));
  }
  function enhanceProcessDisclosure(node) {
    const head = node?.querySelector?.(".tl-step-head");
    const detail = node?.querySelector?.(".tl-step-detail");
    if (!head || !detail || head.dataset.lingxiProcessDisclosure === "1") return;
    head.dataset.lingxiProcessDisclosure = "1";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-label", "展开或收起思考与工具详情");
    head.setAttribute("aria-expanded", String(!detail.hasAttribute("hidden")));
    head.addEventListener("click", () => window.setTimeout(() => head.setAttribute("aria-expanded", String(!detail.hasAttribute("hidden"))), 0));
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      head.click();
    });
  }
  function setToolDisclosure(row, expanded) {
    const head = row?.querySelector?.(".tl-tool-row-head");
    const detail = row?.querySelector?.(".tl-tool-row-detail");
    if (!head || !detail) return;
    if (expanded) detail.removeAttribute("hidden");
    else detail.setAttribute("hidden", "");
    head.setAttribute("aria-expanded", String(!!expanded));
  }
  function enhanceToolDisclosure(row) {
    const head = row?.querySelector?.(".tl-tool-row-head");
    const detail = row?.querySelector?.(".tl-tool-row-detail");
    if (!head || !detail || head.dataset.lingxiToolDisclosure === "1") return;
    head.dataset.lingxiToolDisclosure = "1";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-label", "展开或收起此工具的参数与结果");
    setToolDisclosure(row, false);
    head.addEventListener("click", () => setToolDisclosure(row, detail.hasAttribute("hidden")));
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      head.click();
    });
  }
  function normalizeToolDisclosures(rail) {
    Array.from(rail?.querySelectorAll?.(".tl-tool-row") || []).forEach(enhanceToolDisclosure);
  }
  function scrollProcessToLatest() {
    const stream = byId("chatStream");
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
    try { window.updateChatJumpBtnVisibility?.(); } catch (error) {}
  }
  function expandLiveProcessRail(rail) {
    normalizeToolDisclosures(rail);
    processDisclosureNodes(rail).forEach((node) => { enhanceProcessDisclosure(node); setProcessDisclosure(node, true); });
  }
  function collapseFinishedProcessRail(rail) {
    normalizeToolDisclosures(rail);
    processDisclosureNodes(rail).forEach((node) => { enhanceProcessDisclosure(node); setProcessDisclosure(node, false); });
  }

  function installProcessAutoCollapse() {
    const timeline = window.WpsAiChatTimeline;
    if (!timeline?.beginAssistantTurn) { window.setTimeout(installProcessAutoCollapse, 100); return; }
    if (timeline.__lingxiProcessAutoCollapse) return;
    const originalBegin = timeline.beginAssistantTurn;
    const originalRender = typeof timeline.renderAssistantTurn === "function" ? timeline.renderAssistantTurn : null;
    timeline.beginAssistantTurn = function wrappedProcessDisclosureTurn() {
      const turn = originalBegin.apply(this, arguments);
      if (!turn?.rail) return turn;
      liveProcessRails.add(turn.rail);
      ["updateReasoning", "endReasoning", "addToolStep", "finishToolStep", "setText", "finalizeText", "addError"].forEach((method) => {
        if (typeof turn[method] !== "function") return;
        const original = turn[method].bind(turn);
        turn[method] = function wrappedProcessDisclosureMethod() {
          const value = original.apply(this, arguments);
          window.requestAnimationFrame(() => expandLiveProcessRail(turn.rail));
          return value;
        };
      });
      return turn;
    };
    if (originalRender) {
      timeline.renderAssistantTurn = function wrappedCollapsedProcessReplay() {
        const node = originalRender.apply(this, arguments);
        const rail = node?.querySelector?.(".tl-rail");
        if (rail) collapseFinishedProcessRail(rail);
        return node;
      };
    }
    const stop = byId("chatStopBtn");
    if (stop) {
      let wasBusy = !stop.classList.contains("hidden");
      const observer = new MutationObserver(() => {
        const busy = !stop.classList.contains("hidden");
        if (wasBusy && !busy) {
          // 先等最终文本/过程 DOM 写完，再收折；收折改变高度后再次滚到底，避免停在旧位置。
          window.requestAnimationFrame(() => window.setTimeout(() => {
            liveProcessRails.forEach(collapseFinishedProcessRail);
            liveProcessRails.clear();
            scrollProcessToLatest();
          }, 32));
        }
        wasBusy = busy;
      });
      observer.observe(stop, { attributes: true, attributeFilter: ["class"] });
    }
    timeline.__lingxiProcessAutoCollapse = true;
  }

  function applyCompactWpsAiBrand() {
    const header = document.querySelector(".app-header");
    const name = document.querySelector(".brand-name");
    if (!header || !name) return;
    name.textContent = "WPS AI";
    name.setAttribute("aria-label", "WPS AI");
    header.setAttribute("aria-label", "WPS AI");
  }

  function buildMoreMenu(headerControls) {
    let button = byId("lingxiGraphiteMoreButton");
    let menu = byId("lingxiGraphiteMoreMenu");
    if (!button) {
      button = document.createElement("button");
      button.id = "lingxiGraphiteMoreButton";
      button.className = "lg-more-button";
      button.type = "button";
      button.setAttribute("aria-label", "更多操作");
      button.setAttribute("aria-expanded", "false");
      button.textContent = "•••";
      headerControls.appendChild(button);
    }
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "lingxiGraphiteMoreMenu";
      menu.className = "lg-more-menu hidden";
      menu.setAttribute("role", "menu");
      headerControls.appendChild(menu);
    }

    const labels = {
      newConversationBtn: "新对话",
      conversationsMenuBtn: "历史对话",
      refreshModelsBtn: "刷新模型",
      forceUnlockBtn: "解除文档锁定",
      chatFoldToggle: "折叠中间轮次",
      dockToggleBtn: "脱离任务窗格",
      openSettingsModalBtn: "设置"
    };
    const order = [
      "newConversationBtn", "conversationsMenuBtn", "refreshModelsBtn",
      "forceUnlockBtn", "chatFoldToggle", "dockToggleBtn", "openSettingsModalBtn"
    ];
    order.forEach((id) => {
      const node = byId(id);
      if (!node) return;
      node.classList.add("lg-menu-action");
      node.setAttribute("role", "menuitem");
      if (!node.querySelector(".lg-menu-label")) {
        const label = document.createElement("span");
        label.className = "lg-menu-label";
        label.textContent = labels[id];
        node.appendChild(label);
      }
      menu.appendChild(node);
      node.addEventListener("click", () => {
        menu.classList.add("hidden");
        button.setAttribute("aria-expanded", "false");
      });
    });

    let status = menu.querySelector(".lg-menu-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "lg-menu-status";
      menu.appendChild(status);
    }
    ["authBadge", "canaryHeaderBadge"].forEach((id) => {
      const node = byId(id);
      if (node) status.appendChild(node);
    });

    function close() {
      menu.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = menu.classList.contains("hidden");
      if (opening) menu.classList.remove("hidden"); else menu.classList.add("hidden");
      button.setAttribute("aria-expanded", String(opening));
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", close);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  }

  function enhanceAccessibility() {
    const tabs = Array.from(document.querySelectorAll(".tab-btn[data-tab]"));
    function syncTabs() {
      tabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.classList.contains("active"))));
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => window.setTimeout(syncTabs, 0));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(index + direction + tabs.length) % tabs.length];
        next.click();
        next.focus();
      });
    });
    syncTabs();

    const thinking = byId("capThinking");
    if (thinking) {
      thinking.setAttribute("role", "button");
      thinking.setAttribute("tabindex", "0");
      thinking.setAttribute("aria-label", thinking.title || "切换思考强度");
      thinking.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        thinking.click();
      });
    }
  }

  function syncModelLabel() {
    const select = byId("modelSelect");
    const label = byId("modelSelectLabel");
    const button = byId("modelSelectBtn");
    if (!select || !label) return;
    const rendered = String(label.textContent || "").trim();
    const modelId = String(select.value || rendered.split("·").pop() || "").trim();
    if (!modelId) return;
    const full = rendered.includes("·") ? rendered : (label.title || rendered || modelId);
    label.title = full;
    if (button) button.title = `当前模型：${modelId}（点击选择）`;
    // 业务层持续渲染完整模型名；不覆盖可见文案，避免内容被缩写或与业务层互相覆盖造成闪烁。
  }

  function formatTokens(value) {
    return Math.max(0, Math.round(Number(value) || 0)).toLocaleString("zh-CN");
  }

  function installContextUsage(ring) {
    if (!ring) return;
    const usage = window.WpsAiTokenUsage;
    const estimateLimit = 128000;
    let latestInput = 0;
    let tooltip = byId("lingxiContextTooltip");

    if (!tooltip) {
      tooltip = createNode("lingxi-context-tooltip");
      tooltip.id = "lingxiContextTooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.hidden = true;
      document.body.appendChild(tooltip);
    }
    ring.removeAttribute("title");
    ring.setAttribute("aria-describedby", tooltip.id);

    function positionTooltip() {
      if (tooltip.hidden) return;
      const margin = 8;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 0;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 0;
      const anchor = ring.getBoundingClientRect();
      tooltip.style.maxWidth = `${Math.max(160, Math.min(280, viewportWidth - margin * 2))}px`;
      tooltip.style.left = `${margin}px`;
      tooltip.style.top = `${margin}px`;
      const rect = tooltip.getBoundingClientRect();
      const left = Math.min(viewportWidth - rect.width - margin, Math.max(margin, anchor.left + anchor.width / 2 - rect.width / 2));
      let top = anchor.top - rect.height - 8;
      if (top < margin) top = anchor.bottom + 8;
      top = Math.min(viewportHeight - rect.height - margin, Math.max(margin, top));
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }

    function showTooltip() {
      tooltip.hidden = false;
      tooltip.classList.add("is-visible");
      positionTooltip();
    }

    function hideTooltip() {
      tooltip.classList.remove("is-visible");
      tooltip.hidden = true;
    }

    if (ring.dataset.lingxiContextTooltipBound !== "1") {
      ring.dataset.lingxiContextTooltipBound = "1";
      ring.addEventListener("mouseenter", showTooltip);
      ring.addEventListener("mouseleave", hideTooltip);
      ring.addEventListener("focus", showTooltip);
      ring.addEventListener("blur", hideTooltip);
      ring.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip(); });
      window.addEventListener("resize", positionTooltip, { passive: true });
      document.addEventListener("scroll", positionTooltip, { passive: true, capture: true });
    }

    function refresh() {
      const session = usage?.getSession?.() || { input: 0, output: 0, total: 0, calls: 0 };
      const input = latestInput || Number(session.input) || 0;
      const pct = Math.max(0, Math.min(100, Math.round(input / estimateLimit * 100)));
      const total = Number(session.total) || 0;
      ring.style.setProperty("--lg-context-pct", `${pct}%`);
      const tip = input > 0
        ? `最近请求输入：${formatTokens(input)} / ${formatTokens(estimateLimit)} token（${pct}%，按 128K 估算）· 本会话累计：${formatTokens(total)} token`
        : "最近请求输入：0 / 128,000 token（0%，等待下一次请求返回实际用量）";
      ring.dataset.tooltip = tip;
      ring.setAttribute("aria-label", tip);
      tooltip.textContent = tip;
      positionTooltip();
    }

    if (usage && !usage.__lingxiGraphiteContextWrapped && typeof usage.record === "function") {
      const original = usage.record;
      usage.record = function wrappedGraphiteUsageRecord(payload) {
        latestInput = Math.max(0, Number(payload?.input) || 0);
        const result = original.apply(this, arguments);
        window.setTimeout(refresh, 0);
        return result;
      };
      usage.__lingxiGraphiteContextWrapped = true;
    }
    usage?.onChange?.(refresh);
    refresh();
  }

  function clampFloatingPopup(popup) {
    if (!popup || !popup.isConnected) return;
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 0;
    if (viewportWidth <= margin * 2) return;
    popup.style.boxSizing = "border-box";
    popup.style.maxWidth = `${viewportWidth - margin * 2}px`;
    const rect = popup.getBoundingClientRect();
    const width = Math.min(rect.width, viewportWidth - margin * 2);
    const maxLeft = Math.max(margin, viewportWidth - width - margin);
    const left = Math.min(maxLeft, Math.max(margin, rect.left));
    popup.style.right = "auto";
    popup.style.left = `${Math.round(left)}px`;
  }

  function installFloatingPopupGuard() {
    if (!document.body || document.body.dataset.lingxiPopupGuard === "1") return;
    document.body.dataset.lingxiPopupGuard = "1";
    const selector = ".thinking-menu, .chat-model-override-picker";
    const clampAll = () => document.querySelectorAll(selector).forEach(clampFloatingPopup);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches(selector)) clampFloatingPopup(node);
        node.querySelectorAll?.(selector).forEach(clampFloatingPopup);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", clampAll, { passive: true });
    clampAll();
  }

  let promptPresetPopup = null;
  let promptPresetModal = null;
  let promptPresetModalReturnFocus = null;

  function normalizePromptPreset(item, index) {
    if (!item || typeof item !== "object") return null;
    const name = String(item.name || "").trim().slice(0, 80);
    const prompt = String(item.prompt || "").trim().slice(0, 20000);
    if (!name || !prompt) return null;
    return {
      id: String(item.id || `preset-${Date.now()}-${index}`).slice(0, 120),
      name,
      prompt,
      experience: String(item.experience || "").trim().slice(0, 20000),
      updatedAt: Number(item.updatedAt) || Date.now()
    };
  }

  function loadPromptPresets() {
    const stored = localStorage.getItem(PROMPT_STORE_KEY);
    if (stored == null) {
      const defaults = DEFAULT_PROMPT_PRESETS.map((item, index) => normalizePromptPreset(item, index));
      localStorage.setItem(PROMPT_STORE_KEY, JSON.stringify(defaults));
      return defaults;
    }
    try {
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error("INVALID_PROMPT_PRESET_STORE");
      const clean = parsed.map(normalizePromptPreset).filter(Boolean).slice(0, 50);
      if (parsed.length > 0 && clean.length === 0) throw new Error("INVALID_PROMPT_PRESET_ITEMS");
      let migrated = false;
      clean.forEach((item) => {
        if (item.id === "preset-urs-review" && (item.prompt === LEGACY_URS_PROMPT || item.prompt === PREVIOUS_URS_PROMPT || item.prompt === PREVIEW_URS_PREVIOUS_PROMPT)) {
          item.prompt = URS_PROMPT;
          item.updatedAt = Date.now();
          migrated = true;
        }
      });
      if (migrated) localStorage.setItem(PROMPT_STORE_KEY, JSON.stringify(clean));
      return clean;
    } catch (error) {
      try { localStorage.setItem(PROMPT_CORRUPT_KEY, stored.slice(0, 100000)); } catch (backupError) {}
      const defaults = DEFAULT_PROMPT_PRESETS.map((item, index) => normalizePromptPreset(item, index));
      localStorage.setItem(PROMPT_STORE_KEY, JSON.stringify(defaults));
      return defaults;
    }
  }

  function savePromptPresets(items) {
    const clean = (items || []).map(normalizePromptPreset).filter(Boolean).slice(0, 50);
    localStorage.setItem(PROMPT_STORE_KEY, JSON.stringify(clean));
    return clean;
  }

  function activePromptPreset(items = loadPromptPresets()) {
    const id = localStorage.getItem(PROMPT_ACTIVE_KEY);
    return items.find((item) => item.id === id) || items[0] || null;
  }

  function notifyPromptPreset(message) {
    let toast = byId("lingxiPromptPresetToast");
    if (!toast) {
      toast = createNode("lingxi-prompt-toast");
      toast.id = "lingxiPromptPresetToast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(Number(toast.dataset.timer) || 0);
    toast.dataset.timer = String(window.setTimeout(() => toast.classList.remove("is-visible"), 1800));
  }

  function composedPresetText(preset) {
    const prompt = String(preset?.prompt || "").trim();
    const experience = String(preset?.experience || "").trim();
    return experience ? `${prompt}\n\n【已沉淀经验】\n${experience}` : prompt;
  }

  function writePromptToComposer(text, options = {}) {
    const input = byId("chatInput");
    if (!input) return false;
    const incoming = String(text || "").trim();
    if (!incoming) return false;
    const currentValue = String(input.value || "");
    const existing = currentValue.trim();
    const priorPresetFill = promptPresetFilledValues.get(input) === currentValue;
    if (existing && existing !== incoming && options.keepDraft !== false && !priorPresetFill) {
      input.value = `${incoming}\n\n【本次补充】\n${existing}`;
    } else input.value = incoming;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (options.presetId) promptPresetFilledValues.set(input, input.value);
    else promptPresetFilledValues.delete(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  function updatePromptPresetButton() {
    const button = byId("chatModelOverrideBtn");
    if (!button) return;
    const active = activePromptPreset();
    button.classList.toggle("lingxi-prompt-has-active", !!active);
    button.title = active ? `提示词预置：${active.name}` : "选择提示词预置";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(!!promptPresetPopup));
  }

  function closePromptPresetPopup() {
    if (promptPresetPopup) promptPresetPopup.remove();
    promptPresetPopup = null;
    updatePromptPresetButton();
  }

  function latestAssistantText() {
    const messages = Array.from(document.querySelectorAll("#chatStream .tl-msg"));
    const latest = messages[messages.length - 1];
    if (!latest?.classList.contains("tl-assistant")) return "";
    const blocks = Array.from(latest.querySelectorAll(".tl-step.tl-text"));
    return blocks.map((node) => String(node.innerText || node.textContent || "").trim())
      .filter(Boolean).join("\n\n").slice(0, 12000);
  }

  function closePromptPresetModal() {
    if (promptPresetModal) promptPresetModal.remove();
    promptPresetModal = null;
    const target = promptPresetModalReturnFocus;
    promptPresetModalReturnFocus = null;
    target?.focus?.();
  }

  function openPromptPresetEditor(preset, candidateExperience = "") {
    closePromptPresetPopup();
    closePromptPresetModal();
    const existing = preset || null;
    promptPresetModalReturnFocus = byId("chatModelOverrideBtn");
    const overlay = createNode("lingxi-prompt-modal-overlay");
    const dialog = createNode("lingxi-prompt-modal");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "lingxiPromptModalTitle");

    const header = createNode("lingxi-prompt-modal-header");
    const heading = createNode("lingxi-prompt-modal-heading");
    const title = createNode("lingxi-prompt-modal-title", candidateExperience ? "收录过程经验" : existing ? "编辑提示词预置" : "新建提示词预置");
    title.id = "lingxiPromptModalTitle";
    const subtitle = createNode("lingxi-prompt-modal-subtitle", candidateExperience ? "保存前可以删减、改写；不会由 AI 静默覆盖。" : "选择预置时会填入输入框，发送前仍可修改。 ");
    heading.append(title, subtitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "lingxi-prompt-modal-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", closePromptPresetModal);
    header.append(heading, close);

    const body = createNode("lingxi-prompt-modal-body");
    const nameLabel = document.createElement("label");
    nameLabel.className = "lingxi-prompt-field";
    const nameText = createNode("lingxi-prompt-field-label", "名称");
    const nameInput = document.createElement("input");
    nameInput.id = "lingxiPromptPresetName";
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.value = existing?.name || "";
    nameInput.placeholder = "例如：月度 URS 复核";
    nameLabel.append(nameText, nameInput);

    const promptLabel = document.createElement("label");
    promptLabel.className = "lingxi-prompt-field";
    const promptText = createNode("lingxi-prompt-field-label", "基础提示词");
    const promptInput = document.createElement("textarea");
    promptInput.id = "lingxiPromptPresetContent";
    promptInput.rows = 8;
    promptInput.maxLength = 20000;
    promptInput.value = existing?.prompt || "";
    promptInput.placeholder = "写明角色、目标、边界、执行步骤和输出要求…";
    promptLabel.append(promptText, promptInput);

    const experienceLabel = document.createElement("label");
    experienceLabel.className = "lingxi-prompt-field";
    const experienceText = createNode("lingxi-prompt-field-label", "已沉淀经验");
    const experienceHint = createNode("lingxi-prompt-field-hint", "每次使用预置时，会附在基础提示词之后。 ");
    const experienceInput = document.createElement("textarea");
    experienceInput.id = "lingxiPromptPresetExperience";
    experienceInput.rows = 6;
    experienceInput.maxLength = 20000;
    const oldExperience = String(existing?.experience || "").trim();
    const candidate = String(candidateExperience || "").trim();
    const date = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
    experienceInput.value = candidate
      ? [oldExperience, `【${date} 复盘】\n${candidate}`].filter(Boolean).join("\n\n")
      : oldExperience;
    experienceLabel.append(experienceText, experienceHint, experienceInput);
    body.append(nameLabel, promptLabel, experienceLabel);

    const footer = createNode("lingxi-prompt-modal-footer");
    const left = createNode("lingxi-prompt-modal-secondary");
    if (existing) {
      const duplicate = document.createElement("button");
      duplicate.type = "button";
      duplicate.className = "lingxi-prompt-btn ghost";
      duplicate.textContent = "复制预置";
      duplicate.addEventListener("click", () => {
        const items = loadPromptPresets();
        if (items.length >= 50) { notifyPromptPreset("最多保存 50 套预置"); return; }
        const copy = { ...existing, id: `preset-${Date.now()}`, name: `${existing.name} 副本`, updatedAt: Date.now() };
        savePromptPresets([...items, copy]);
        localStorage.setItem(PROMPT_ACTIVE_KEY, copy.id);
        closePromptPresetModal();
        updatePromptPresetButton();
        notifyPromptPreset("已复制预置");
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "lingxi-prompt-btn danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        if (!window.confirm(`删除提示词预置“${existing.name}”？`)) return;
        const items = loadPromptPresets().filter((item) => item.id !== existing.id);
        savePromptPresets(items);
        if (localStorage.getItem(PROMPT_ACTIVE_KEY) === existing.id) {
          if (items[0]) localStorage.setItem(PROMPT_ACTIVE_KEY, items[0].id);
          else localStorage.removeItem(PROMPT_ACTIVE_KEY);
        }
        closePromptPresetModal();
        updatePromptPresetButton();
        notifyPromptPreset("已删除预置");
      });
      left.append(duplicate, remove);
    }
    const actions = createNode("lingxi-prompt-modal-actions");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "lingxi-prompt-btn ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closePromptPresetModal);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "lingxi-prompt-btn primary";
    save.textContent = "保存";
    save.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!name || !prompt) {
        notifyPromptPreset("名称和基础提示词不能为空");
        (!name ? nameInput : promptInput).focus();
        return;
      }
      const items = loadPromptPresets();
      const next = {
        id: existing?.id || `preset-${Date.now()}`,
        name,
        prompt,
        experience: experienceInput.value.trim(),
        updatedAt: Date.now()
      };
      const index = items.findIndex((item) => item.id === next.id);
      if (index >= 0) items[index] = next;
      else {
        if (items.length >= 50) { notifyPromptPreset("最多保存 50 套预置"); return; }
        items.push(next);
      }
      savePromptPresets(items);
      localStorage.setItem(PROMPT_ACTIVE_KEY, next.id);
      closePromptPresetModal();
      updatePromptPresetButton();
      notifyPromptPreset(candidate ? "经验已更新到预置" : "提示词预置已保存");
    });
    actions.append(cancel, save);
    footer.append(left, actions);
    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closePromptPresetModal(); });
    document.body.appendChild(overlay);
    promptPresetModal = overlay;
    window.setTimeout(() => (candidateExperience ? experienceInput : nameInput).focus(), 0);
  }

  function insertExperienceSummaryRequest() {
    const preset = activePromptPreset();
    if (!preset) { notifyPromptPreset("请先新建或选择一个预置"); return; }
    const request = [
      `请复盘本轮使用“${preset.name}”完成任务的过程。`,
      "只总结能提升这套提示词的可复用经验，不要重述本次业务结果。",
      "请以“提示词增量：”开头，输出 3–8 条可直接追加到提示词中的明确规则；包括有效步骤、失败规避、判断边界和复核方法。"
    ].join("\n");
    writePromptToComposer(request, { keepDraft: true });
    closePromptPresetPopup();
    notifyPromptPreset("总结请求已填入，发送后可收录最近回复");
  }

  function collectLatestAssistantExperience() {
    const preset = activePromptPreset();
    if (!preset) { notifyPromptPreset("请先选择一个预置"); return; }
    const stop = byId("chatStopBtn");
    if (stop && !stop.classList.contains("hidden")) { notifyPromptPreset("最近一轮仍在执行，请完成后再收录"); return; }
    const latest = latestAssistantText();
    if (!latest) { notifyPromptPreset("最近一轮尚无可收录的 AI 正文"); return; }
    openPromptPresetEditor(preset, latest);
  }

  function positionPromptPresetPopup(popup) {
    const button = byId("chatModelOverrideBtn");
    if (!button) return;
    const rect = button.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.left = `${Math.max(8, rect.left - 4)}px`;
    popup.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
    clampFloatingPopup(popup);
  }

  function openPromptPresetPopup() {
    if (promptPresetPopup) { closePromptPresetPopup(); return; }
    const items = loadPromptPresets();
    const active = activePromptPreset(items);
    const popup = createNode("lingxi-prompt-preset-picker");
    popup.id = "lingxiPromptPresetPicker";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "false");
    popup.setAttribute("aria-label", "提示词预置");
    const header = createNode("lingxi-prompt-picker-header");
    header.append(createNode("lingxi-prompt-picker-title", "提示词预置"), createNode("lingxi-prompt-picker-count", `${items.length} 套`));
    const list = createNode("lingxi-prompt-picker-list");
    if (!items.length) list.appendChild(createNode("lingxi-prompt-picker-empty", "还没有预置。新建后可一键填入输入框。"));
    items.forEach((preset) => {
      const row = createNode(`lingxi-prompt-picker-row${preset.id === active?.id ? " is-active" : ""}`);
      const use = document.createElement("button");
      use.type = "button";
      use.className = "lingxi-prompt-picker-use";
      const name = createNode("lingxi-prompt-picker-name", preset.name);
      const preview = createNode("lingxi-prompt-picker-preview", preset.prompt.replace(/\s+/g, " ").slice(0, 72));
      use.append(name, preview);
      use.addEventListener("click", () => {
        localStorage.setItem(PROMPT_ACTIVE_KEY, preset.id);
        writePromptToComposer(composedPresetText(preset), { keepDraft: true, presetId: preset.id });
        closePromptPresetPopup();
        updatePromptPresetButton();
        notifyPromptPreset(`已填入“${preset.name}”`);
      });
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "lingxi-prompt-picker-edit";
      edit.textContent = "编辑";
      edit.setAttribute("aria-label", `编辑 ${preset.name}`);
      edit.addEventListener("click", () => openPromptPresetEditor(preset));
      row.append(use, edit);
      list.appendChild(row);
    });
    const footer = createNode("lingxi-prompt-picker-footer");
    const newPreset = document.createElement("button");
    newPreset.type = "button";
    newPreset.className = "lingxi-prompt-picker-action";
    newPreset.textContent = "新建预置";
    newPreset.addEventListener("click", () => openPromptPresetEditor(null));
    const summarize = document.createElement("button");
    summarize.type = "button";
    summarize.className = "lingxi-prompt-picker-action";
    summarize.textContent = "生成经验总结";
    summarize.addEventListener("click", insertExperienceSummaryRequest);
    const collect = document.createElement("button");
    collect.type = "button";
    collect.className = "lingxi-prompt-picker-action wide";
    collect.textContent = "收录最近回复到当前预置";
    collect.addEventListener("click", collectLatestAssistantExperience);
    footer.append(newPreset, summarize, collect);
    popup.append(header, list, footer);
    document.body.appendChild(popup);
    promptPresetPopup = popup;
    positionPromptPresetPopup(popup);
    updatePromptPresetButton();
    window.setTimeout(() => popup.querySelector(".lingxi-prompt-picker-use, .lingxi-prompt-picker-action")?.focus(), 0);
  }

  function installPromptPresetControl() {
    const button = byId("chatModelOverrideBtn");
    if (!button || button.dataset.lingxiPromptPreset === "1") return;
    button.dataset.lingxiPromptPreset = "1";
    document.body.classList.add("lingxi-prompt-presets-v1");
    const legacyBar = byId("chatModelOverrideBar");
    if (legacyBar && !legacyBar.classList.contains("hidden")) byId("chatModelOverrideClearBtn")?.click();
    legacyBar?.classList.add("hidden");
    document.querySelectorAll(".chat-model-override-picker").forEach((node) => node.remove());
    button.innerHTML = '<span class="lingxi-prompt-button-icon" aria-hidden="true"><span></span><span></span><span></span></span>';
    button.classList.remove("active");
    button.classList.add("lg-prompt-preset-button");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openPromptPresetPopup();
    }, true);
    document.addEventListener("mousedown", (event) => {
      if (promptPresetModal) return;
      if (promptPresetPopup?.contains(event.target) || button.contains(event.target)) return;
      closePromptPresetPopup();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (promptPresetModal) closePromptPresetModal();
      else closePromptPresetPopup();
    });
    window.addEventListener("resize", () => { if (promptPresetPopup) positionPromptPresetPopup(promptPresetPopup); }, { passive: true });
    updatePromptPresetButton();
  }

  function arrangeComposer() {
    const toolbar = document.querySelector(".chat-input-toolbar");
    const inputBox = document.querySelector(".chat-input-box");
    const modelWrap = document.querySelector(".model-select-wrap");
    if (!toolbar || !inputBox || !modelWrap) return;

    inputBox.classList.add("lg-composer");
    toolbar.classList.add("lg-composer-toolbar");
    modelWrap.classList.add("lg-composer-model");

    const attach = byId("chatAttachBtn");
    if (attach) {
      attach.innerHTML = paperclipSvg();
      attach.classList.add("lg-attach-button");
    }
    const send = byId("chatSendBtn");
    if (send) {
      send.innerHTML = '<span class="lg-send-glyph" aria-hidden="true">↵</span>';
      send.classList.add("lg-send-button");
    }
    const stop = byId("chatStopBtn");
    if (stop) stop.classList.add("lg-send-button");

    const thinking = byId("capThinking");
    if (thinking) thinking.classList.add("lg-thinking-control");
    const override = byId("chatModelOverrideBtn");
    if (override) override.classList.add("lg-override-button");
    installPromptPresetControl();
    [byId("capImage"), byId("capPdf")].forEach((node) => { if (node) node.classList.add("lg-cap-secondary"); });

    let ring = byId("lingxiContextRing");
    if (!ring) {
      ring = document.createElement("span");
      ring.id = "lingxiContextRing";
      ring.className = "lg-context-ring";
      ring.setAttribute("role", "img");
      ring.setAttribute("tabindex", "0");
    }
    installContextUsage(ring);

    const spacer = toolbar.querySelector(".chat-toolbar-spacer");
    const ordered = [
      thinking, attach, byId("chatAttachActiveBtn"), override,
      byId("capImage"), byId("capPdf"), ring, spacer,
      modelWrap, send, stop
    ];
    ordered.forEach((node) => { if (node) toolbar.appendChild(node); });

    const input = byId("chatInput");
    if (input) input.placeholder = "向灵犀描述要检查或修改的内容…";

    syncModelLabel();
    const modelSelect = byId("modelSelect");
    const modelLabel = byId("modelSelectLabel");
    if (modelSelect) modelSelect.addEventListener("change", () => window.setTimeout(syncModelLabel, 0));
    if (modelLabel) {
      const observer = new MutationObserver(() => window.setTimeout(syncModelLabel, 0));
      observer.observe(modelLabel, { childList: true, characterData: true, subtree: true });
    }
  }

  const LITELLM_VISIBILITY_KEY = "lingxi.graphite.litellm.disabled-models.v1";

  function getLiteLlmApiUrl(route) {
    const runtime = window.WpsAiRuntime;
    const base = typeof runtime?.proxyBase === "function" ? runtime.proxyBase() : "http://127.0.0.1:3890";
    return `${base}${route}`;
  }

  function readDisabledLiteLlmModels() {
    try {
      const raw = JSON.parse(localStorage.getItem(LITELLM_VISIBILITY_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id) : []);
    } catch (error) { return new Set(); }
  }

  const PROVIDER_MODELS_CACHE_KEY = "lingxi_models_cache_v1";
  const PROVIDER_DISABLED_MODELS_KEY = "lingxi.graphite.provider.disabled-models.v1";

  function readDisabledProviderModels() {
    try {
      const value = JSON.parse(localStorage.getItem(PROVIDER_DISABLED_MODELS_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) { return {}; }
  }

  function writeDisabledProviderModels(value) {
    localStorage.setItem(PROVIDER_DISABLED_MODELS_KEY, JSON.stringify(value));
  }

  function applyLiteLlmModelVisibility() {
    const disabled = readDisabledLiteLlmModels();
    const providerDisabled = readDisabledProviderModels();
    const popup = byId("modelSelectPopup");
    if (!popup) return;
    popup.querySelectorAll(".model-select-popup-item[data-model-id]").forEach((item) => {
      const modelId = String(item.dataset.modelId || "");
      const providerId = String(item.dataset.providerId || "");
      const off = disabled.has(modelId) || Array.isArray(providerDisabled[providerId]) && providerDisabled[providerId].includes(modelId);
      item.classList.toggle("lg-model-hidden-by-user", off);
      item.tabIndex = off ? -1 : 0;
      item.setAttribute("aria-hidden", off ? "true" : "false");
    });
    const selected = popup.querySelector(".model-select-popup-item.selected.lg-model-hidden-by-user");
    if (selected) {
      const next = Array.from(popup.querySelectorAll(".model-select-popup-item:not(.lg-model-hidden-by-user)"))[0];
      if (next) window.setTimeout(() => next.click(), 0);
    }
  }

  function installLiteLlmModelVisibilityBridge() {
    const popup = byId("modelSelectPopup");
    if (!popup || popup.dataset.lingxiVisibilityBridge === "1") return;
    popup.dataset.lingxiVisibilityBridge = "1";
    const observer = new MutationObserver(() => window.requestAnimationFrame(applyLiteLlmModelVisibility));
    observer.observe(popup, { childList: true, subtree: true });
    applyLiteLlmModelVisibility();
  }

  function formatLiteLlmTokens(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? `${Math.round(n / 1000)}k` : "—";
  }

  function renderLiteLlmModelRows(body, models) {
    body.textContent = "";
    if (!models.length) {
      body.append(createNode("lg-litellm-empty", "未返回可用模型。确认本机 LiteLLM 正在运行后重试。"));
      return;
    }
    models.forEach((model) => {
      const row = createNode("lg-litellm-model-row");
      const info = createNode("lg-litellm-model-info");
      const title = createNode("lg-litellm-model-id", model.id);
      title.title = model.id;
      const meta = createNode("lg-litellm-model-meta", `${model.provider} · ${model.mode} · 输入 ${formatLiteLlmTokens(model.maxInputTokens)} / 输出 ${formatLiteLlmTokens(model.maxOutputTokens)}`);
      info.append(title, meta);
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = !!model.enabledInLingxi;
      toggle.setAttribute("aria-label", `${model.id} 在灵犀AI中可用`);
      toggle.dataset.modelId = model.id;
      const state = createNode("span", toggle.checked ? "可用" : "已关闭");
      state.className = "lg-litellm-model-state";
      row.append(info, state, toggle);
      body.appendChild(row);
    });
  }

  function ensureLiteLlmModelManager() {
    const panel = document.querySelector('.settings-panel[data-settings-panel="service"]');
    if (!panel) return null;
    let card = byId("lingxiLiteLlmModelManager");
    if (card) return card;
    card = document.createElement("details");
    card.id = "lingxiLiteLlmModelManager";
    card.className = "config-card lg-litellm-manager";
    card.innerHTML = '<summary><span><strong>LiteLLM 模型</strong><small>拉取并管理灵犀AI可见模型</small></span><span id="lingxiLiteLlmModelCount" class="badge badge-muted">未拉取</span></summary><div class="lg-litellm-manager-content"><p class="muted">关闭仅从灵犀AI模型选择器隐藏，不会删除 LiteLLM 模型，也不影响 Sally 或 Proma。</p><div class="lg-litellm-actions"><button type="button" id="lingxiLiteLlmRefresh" class="ghost-btn compact-btn">拉取可用模型</button><input id="lingxiLiteLlmSearch" type="search" placeholder="筛选模型…" aria-label="筛选 LiteLLM 模型" /></div><div id="lingxiLiteLlmModelError" class="lg-litellm-error hidden" role="alert"></div><div id="lingxiLiteLlmModelRows" class="lg-litellm-models" aria-live="polite"></div></div>';
    panel.appendChild(card);

    const modelsBody = byId("lingxiLiteLlmModelRows");
    const errorNode = byId("lingxiLiteLlmModelError");
    const count = byId("lingxiLiteLlmModelCount");
    const refresh = byId("lingxiLiteLlmRefresh");
    const search = byId("lingxiLiteLlmSearch");
    let models = [];
    const display = () => {
      const needle = String(search?.value || "").trim().toLowerCase();
      renderLiteLlmModelRows(modelsBody, needle ? models.filter((model) => `${model.id} ${model.provider} ${model.mode}`.toLowerCase().includes(needle)) : models);
    };
    const load = async () => {
      if (!refresh) return;
      refresh.disabled = true;
      refresh.textContent = "正在拉取…";
      errorNode?.classList.add("hidden");
      try {
        const response = await fetch(getLiteLlmApiUrl("/service/litellm/models"), { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || "无法读取 LiteLLM 模型清单");
        models = Array.isArray(payload.models) ? payload.models : [];
        localStorage.setItem(LITELLM_VISIBILITY_KEY, JSON.stringify(payload.disabledModelIds || []));
        count.textContent = `${models.length} 个模型`;
        display();
        applyLiteLlmModelVisibility();
      } catch (error) {
        errorNode.textContent = error?.message || "无法读取 LiteLLM 模型清单";
        errorNode.classList.remove("hidden");
      } finally {
        refresh.disabled = false;
        refresh.textContent = "拉取可用模型";
      }
    };
    refresh?.addEventListener("click", load);
    card.addEventListener("toggle", () => { if (card.open && !models.length) load(); });
    search?.addEventListener("input", display);
    modelsBody?.addEventListener("change", async (event) => {
      const toggle = event.target;
      if (!(toggle instanceof HTMLInputElement) || toggle.type !== "checkbox") return;
      const id = String(toggle.dataset.modelId || "");
      if (!id) return;
      const previous = readDisabledLiteLlmModels();
      const next = new Set(previous);
      if (toggle.checked) next.delete(id); else next.add(id);
      toggle.disabled = true;
      try {
        const response = await fetch(getLiteLlmApiUrl("/service/litellm/model-visibility"), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabledModelIds: Array.from(next) })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || "无法保存模型可见性");
        localStorage.setItem(LITELLM_VISIBILITY_KEY, JSON.stringify(payload.disabledModelIds || []));
        models = models.map((model) => model.id === id ? { ...model, enabledInLingxi: toggle.checked } : model);
        display();
        applyLiteLlmModelVisibility();
      } catch (error) {
        toggle.checked = !toggle.checked;
        errorNode.textContent = error?.message || "无法保存模型可见性";
        errorNode.classList.remove("hidden");
      } finally { toggle.disabled = false; }
    });
    return card;
  }

  function readProviderModelsCache() {
    try {
      const store = window.WpsAiStore;
      const raw = typeof store?.getItem === "function" ? store.getItem(PROVIDER_MODELS_CACHE_KEY) : localStorage.getItem(PROVIDER_MODELS_CACHE_KEY);
      const value = raw ? JSON.parse(raw) : {};
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) { return {}; }
  }

  function syncProviderModelsCache(cache) {
    const raw = JSON.stringify(cache);
    try {
      const store = window.WpsAiStore;
      if (typeof store?.setItem === "function") store.setItem(PROVIDER_MODELS_CACHE_KEY, raw);
      else localStorage.setItem(PROVIDER_MODELS_CACHE_KEY, raw);
    } catch (error) { localStorage.setItem(PROVIDER_MODELS_CACHE_KEY, raw); }
    // app.js 在同一 WebView 内用 storage 事件同步内存模型缓存；原生 setItem 不会自动触发它。
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: PROVIDER_MODELS_CACHE_KEY, newValue: raw }));
    } catch (error) {
      const event = new Event("storage");
      try { Object.defineProperty(event, "key", { value: PROVIDER_MODELS_CACHE_KEY }); Object.defineProperty(event, "newValue", { value: raw }); } catch (e) {}
      window.dispatchEvent(event);
    }
  }

  function isProviderModelDisabled(providerId, modelId) {
    const disabled = readDisabledProviderModels();
    return Array.isArray(disabled[providerId]) && disabled[providerId].includes(modelId);
  }

  function setProviderModelDisabled(providerId, modelId, disabled) {
    const all = readDisabledProviderModels();
    const current = new Set(Array.isArray(all[providerId]) ? all[providerId] : []);
    if (disabled) current.add(modelId); else current.delete(modelId);
    if (current.size) all[providerId] = Array.from(current).sort(); else delete all[providerId];
    writeDisabledProviderModels(all);
    applyLiteLlmModelVisibility();
  }

  function renderProviderModelManagement(card) {
    const providerId = String(card.dataset.providerId || "");
    if (!providerId) return;
    const details = card.querySelector(".lg-provider-model-manager");
    const list = details?.querySelector(".lg-provider-model-list");
    if (!list) return;
    const settings = window.WpsAiProviderRegistry?.loadSettings?.();
    const provider = Array.isArray(settings?.chatProviders) ? settings.chatProviders.find((entry) => entry.id === providerId) : null;
    const defaultModel = String(provider?.defaultModel || "");
    const models = Array.isArray(readProviderModelsCache()[providerId]) ? readProviderModelsCache()[providerId] : [];
    list.textContent = "";
    if (!models.length) {
      list.append(createNode("lg-provider-model-empty", "尚未拉取模型。点击“拉取模型”读取此 Provider 的 /models。"));
      return;
    }
    models.forEach((modelId) => {
      const row = createNode("lg-provider-model-row");
      const text = createNode("lg-provider-model-name", modelId);
      text.title = modelId;
      if (modelId === defaultModel) text.append(document.createTextNode("（默认）"));
      const toggle = document.createElement("button");
      toggle.type = "button";
      const isOff = isProviderModelDisabled(providerId, modelId);
      toggle.className = "ghost-btn compact-btn";
      toggle.textContent = isOff ? "启用" : "关闭";
      toggle.addEventListener("click", () => {
        setProviderModelDisabled(providerId, modelId, !isOff);
        renderProviderModelManagement(card);
      });
      row.append(text, toggle);
      if (modelId !== defaultModel) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost-btn compact-btn";
        remove.textContent = "删除";
        remove.addEventListener("click", () => {
          const cache = readProviderModelsCache();
          cache[providerId] = (Array.isArray(cache[providerId]) ? cache[providerId] : []).filter((id) => id !== modelId);
          syncProviderModelsCache(cache);
          setProviderModelDisabled(providerId, modelId, false);
          renderProviderModelManagement(card);
        });
        row.append(remove);
      }
      list.append(row);
    });
  }

  function ensureProviderModelManagement(card) {
    if (!card || card.dataset.lingxiProviderModelManager === "1") return;
    const body = card.querySelector(".chat-provider-card-body");
    const nativeFetch = card.querySelector('[data-role="test"]');
    if (!body || !nativeFetch) return;
    card.dataset.lingxiProviderModelManager = "1";
    const manager = document.createElement("details");
    manager.className = "lg-provider-model-manager";
    manager.innerHTML = '<summary>已拉取模型管理</summary><div class="lg-provider-model-actions"><button type="button" class="ghost-btn compact-btn">拉取模型</button></div><div class="lg-provider-model-list"></div>';
    const fetchButton = manager.querySelector("button");
    fetchButton.addEventListener("click", () => nativeFetch.click());
    manager.addEventListener("toggle", () => { if (manager.open) renderProviderModelManagement(card); });
    body.appendChild(manager);
    renderProviderModelManagement(card);
  }

  function installProviderModelManagement() {
    const list = byId("chatProvidersList");
    if (!list || list.dataset.lingxiProviderModelManagement === "1") return;
    list.dataset.lingxiProviderModelManagement = "1";
    const enhance = () => list.querySelectorAll(".chat-provider-card").forEach(ensureProviderModelManagement);
    enhance();
    new MutationObserver(() => window.requestAnimationFrame(enhance)).observe(list, { childList: true, subtree: true });
  }

  function migrateCodexToOfficialDirect() {
    const registry = window.WpsAiProviderRegistry;
    if (!registry?.loadSettings || !registry?.saveSettings || !registry?.encodeActiveChatModel) return { ready: false };
    const settings = registry.loadSettings();
    const codex = (settings.chatProviders || []).find((provider) => provider?.type === "codex");
    if (!codex) return { ready: false };
    let changed = false;
    if (!codex.enabled) { codex.enabled = true; changed = true; }
    const desired = registry.encodeActiveChatModel(codex.id, codex.defaultModel || "");
    if (settings.activeChatModel !== desired) { settings.activeChatModel = desired; changed = true; }
    if (changed) {
      registry.saveSettings(settings);
      try { window.dispatchEvent(new StorageEvent("storage", { key: "wps_ai_provider_settings" })); } catch (_) {}
    }
    return { ready: true, migrated: changed, provider: codex };
  }

  function hideNativeCodexConfigCard() {
    const registry = window.WpsAiProviderRegistry;
    const settings = registry?.loadSettings?.();
    const ids = new Set((settings?.chatProviders || []).filter((provider) => provider?.type === "codex").map((provider) => provider.id));
    document.querySelectorAll("#chatProvidersList .chat-provider-card").forEach((card) => {
      if (ids.has(String(card.dataset.providerId || ""))) { card.hidden = true; card.setAttribute("aria-hidden", "true"); }
    });
  }

  async function getCodexDirectStatus() {
    const response = await fetch(getLiteLlmApiUrl("/service/codex-oauth/status"));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "无法读取 Codex OAuth 状态");
    return payload;
  }

  function ensureCodexDirectOAuthBridge() {
    const list = byId("chatProvidersList");
    if (!list || byId("lingxiCodexDirectBridge")) return;
    const card = document.createElement("section");
    card.id = "lingxiCodexDirectBridge";
    card.className = "chat-provider-card lg-codex-direct-bridge";
    card.innerHTML = '<div class="chat-provider-card-head"><div><strong>Codex OAuth（官方直连）</strong><p>灵犀通过本机 Codex CLI 登录态直接连接 OpenAI；不经过 LiteLLM。</p></div></div><div class="lg-codex-auth-status" aria-live="polite">正在检查本机授权状态…</div><div class="lg-provider-model-actions"><button type="button" class="ghost-btn compact-btn" data-action="refresh">刷新状态</button><button type="button" class="ghost-btn compact-btn" data-action="login">使用 Codex CLI 重新登录</button></div><p class="lg-codex-auth-help">模型发现和推理直连 <code>chatgpt.com/backend-api/codex</code>；OAuth token 不会进入 WPS WebView。</p>';
    list.prepend(card);
    const statusNode = card.querySelector(".lg-codex-auth-status");
    const load = async () => {
      try {
        const payload = await getCodexDirectStatus();
        statusNode.textContent = payload.cliAuthenticated ? `Codex CLI 已登录 · 官方客户端 ${payload.clientVersion || ""} · OpenAI 直连已就绪` : "Codex CLI 未登录";
        if (payload.loginJob?.state === "running") { statusNode.textContent += " · 正在等待官方授权完成"; window.setTimeout(load, 1500); }
      } catch (error) { statusNode.textContent = error?.message || "无法读取授权状态"; }
    };
    card.querySelector('[data-action="refresh"]')?.addEventListener("click", load);
    card.querySelector('[data-action="login"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const response = await fetch(getLiteLlmApiUrl("/service/codex-oauth/login"), { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || "无法启动官方登录");
        statusNode.textContent = "已启动 Codex CLI 官方登录；请按出现的官方流程完成授权。";
        window.setTimeout(load, 1000);
      } catch (error) { statusNode.textContent = error?.message || "无法启动官方登录"; } finally { button.disabled = false; }
    });
    load();
  }

  function installCodexOfficialDirectMigration() {
    if (!migrateCodexToOfficialDirect().ready) return;
    ensureCodexDirectOAuthBridge();
    hideNativeCodexConfigCard();
    const list = byId("chatProvidersList");
    if (list && list.dataset.lingxiCodexDirectMigration !== "1") {
      list.dataset.lingxiCodexDirectMigration = "1";
      new MutationObserver(() => window.requestAnimationFrame(hideNativeCodexConfigCard)).observe(list, { childList: true, subtree: true });
    }
  }

  function installLiteLlmSettingsEnhancements() {
    ensureLiteLlmModelManager();
    installLiteLlmModelVisibilityBridge();
    installProviderModelManagement();
    installCodexOfficialDirectMigration();
    const serviceTab = document.querySelector('.settings-sidebar-btn[data-settings-panel="service"]');
    serviceTab?.addEventListener("click", () => window.setTimeout(ensureLiteLlmModelManager, 0));
  }

  // 服务配置可以作为独立 Dialog 打开；它不应触发主 TaskPane 重排，但需要这组模型管理控件。
  // macOS WPS 有时会把 ⌘V 同时分派给已聚焦的 WebView 和 Writer 主文档。
  // 主业务脚本已负责异步读剪贴板、长文本转附件；这里仅在更外层 capture 阶段
  // 截断按键向 WPS 主窗口的传播，保留其原有的安全粘贴路径。
  const AGENT_REFERENCE_MAX_ITEMS = 4;
  let agentReferenceState = null;
  let agentReferenceMenu = null;
  let agentReferenceLoading = false;

  function getAgentReferenceState() {
    if (agentReferenceState) return agentReferenceState;
    const api = window.WpsAiAgentReferences;
    if (!api?.createReferenceState) return null;
    agentReferenceState = api.createReferenceState({ maxItems: AGENT_REFERENCE_MAX_ITEMS, maxCharsPerItem: 12000, maxContextChars: 36000 });
    return agentReferenceState;
  }

  function getAgentReferenceTray() {
    const input = byId("chatInput");
    const inputBox = input?.closest?.(".chat-input-box");
    if (!input || !inputBox) return null;
    let tray = byId("lingxiAgentReferenceTray");
    if (!tray) {
      tray = document.createElement("div");
      tray.id = "lingxiAgentReferenceTray";
      tray.className = "lingxi-agent-reference-tray";
      tray.hidden = true;
      tray.setAttribute("aria-live", "polite");
      inputBox.insertBefore(tray, input);
    }
    return tray;
  }

  function setAgentReferenceNotice(message, tone = "") {
    const tray = getAgentReferenceTray();
    if (!tray) return;
    tray.dataset.notice = message ? "1" : "";
    tray.dataset.tone = tone;
    let notice = tray.querySelector(".lingxi-agent-reference-notice");
    if (message) {
      if (!notice) {
        notice = document.createElement("p");
        notice.className = "lingxi-agent-reference-notice";
        tray.appendChild(notice);
      }
      notice.textContent = message;
    } else if (notice) notice.remove();
  }

  function renderAgentReferences() {
    const tray = getAgentReferenceTray();
    const state = getAgentReferenceState();
    if (!tray || !state) return;
    const references = state.list();
    tray.querySelectorAll(".lingxi-agent-reference-chip").forEach((node) => node.remove());
    references.forEach((reference) => {
      const chip = document.createElement("span");
      chip.className = "lingxi-agent-reference-chip";
      chip.title = `${reference.label}\n${reference.text}`;
      chip.dataset.referenceId = reference.id;
      const kind = document.createElement("span");
      kind.className = "lingxi-agent-reference-kind";
      kind.textContent = reference.kind === "document" ? "@文档" : "引用";
      const label = document.createElement("span");
      label.className = "lingxi-agent-reference-label";
      label.textContent = reference.label;
      const meta = document.createElement("span");
      meta.className = "lingxi-agent-reference-meta";
      meta.textContent = `${reference.text.length.toLocaleString()} 字`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "lingxi-agent-reference-remove";
      remove.setAttribute("aria-label", `移除 ${reference.label}`);
      remove.title = "移除引用";
      remove.textContent = "×";
      remove.addEventListener("click", () => removeAgentReference(reference.id));
      chip.append(kind, label, meta, remove);
      tray.insertBefore(chip, tray.querySelector(".lingxi-agent-reference-notice") || null);
    });
    tray.classList.toggle("is-loading", agentReferenceLoading);
    tray.hidden = !agentReferenceLoading && references.length === 0 && !tray.dataset.notice;
  }

  function removeAgentReference(id) {
    const removed = getAgentReferenceState()?.remove(id);
    if (removed) setAgentReferenceNotice("");
    renderAgentReferences();
  }

  function closeAgentReferenceMenu() {
    if (agentReferenceMenu) agentReferenceMenu.remove();
    agentReferenceMenu = null;
  }

  function positionAgentReferenceMenu(menu, x, y) {
    const margin = 8;
    const width = menu.offsetWidth || 224;
    const height = menu.offsetHeight || 80;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
  }

  function addAgentHistoryReference(text) {
    const result = getAgentReferenceState()?.add({ kind: "history", label: "对话片段", text });
    if (!result?.added) {
      const message = result?.reason === "duplicate" ? "该对话片段已引用" : result?.reason === "limit" ? `本轮最多引用 ${AGENT_REFERENCE_MAX_ITEMS} 项` : "无法添加空引用";
      setAgentReferenceNotice(message, "warning");
    } else setAgentReferenceNotice("");
    renderAgentReferences();
    return !!result?.added;
  }

  function selectionIsAgentReferenceable(selection) {
    if (!selection || selection.rangeCount < 1 || !String(selection.toString() || "").trim()) return false;
    const stream = byId("chatStream");
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer?.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer?.parentElement;
    return !!(stream && container && stream.contains(container) && container.closest?.(".chat-msg, .tl-msg, .tool-body, .reasoning-body"));
  }

  function showAgentReferenceMenu({ x, y, items }) {
    closeAgentReferenceMenu();
    const menu = document.createElement("div");
    menu.id = "lingxiAgentReferenceMenu";
    menu.className = "lingxi-agent-reference-menu";
    menu.setAttribute("role", "menu");
    items.forEach(({ label, action, disabled = false }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAgentReferenceMenu();
        action?.();
      });
      menu.appendChild(button);
    });
    document.body.appendChild(menu);
    agentReferenceMenu = menu;
    positionAgentReferenceMenu(menu, x, y);
  }

  async function addCurrentWpsDocumentReference() {
    const state = getAgentReferenceState();
    const host = window.WpsAiHostWriter;
    if (!state || typeof host?.readDocumentText !== "function") {
      setAgentReferenceNotice("当前宿主无法读取 WPS 文档", "error");
      renderAgentReferences();
      return;
    }
    if (agentReferenceLoading) return;
    agentReferenceLoading = true;
    setAgentReferenceNotice("正在只读提取当前 WPS 文档…");
    renderAgentReferences();
    try {
      const [text, context] = await Promise.all([host.readDocumentText(), host.readDocumentContext?.()]);
      const label = String(context?.title || "当前 WPS 文档").trim() || "当前 WPS 文档";
      const result = state.add({ kind: "document", label, text });
      if (!result?.added) {
        const message = result?.reason === "duplicate" ? "当前文档已引用" : result?.reason === "limit" ? `本轮最多引用 ${AGENT_REFERENCE_MAX_ITEMS} 项` : "当前文档没有可引用文本";
        setAgentReferenceNotice(message, "warning");
      } else setAgentReferenceNotice(result.reference.truncated ? "文档内容已按安全上限截断" : "");
    } catch (error) {
      setAgentReferenceNotice(`无法读取当前文档：${error?.message || "请确认已打开 WPS 文字文档"}`, "error");
    } finally {
      agentReferenceLoading = false;
      renderAgentReferences();
    }
  }

  function showAtDocumentMenu(input) {
    const rect = input.getBoundingClientRect();
    showAgentReferenceMenu({
      x: rect.left + 8,
      y: rect.top - 4,
      items: [{ label: "@ 当前 WPS 文档", action: () => {
        const value = String(input.value || "");
        input.value = value.replace(/(^|\s)@$/, "$1");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        addCurrentWpsDocumentReference();
        input.focus();
      } }]
    });
  }

  function installAgentReferences() {
    if (document.documentElement.dataset.lingxiAgentReferencesV1 === "1") return;
    if (!getAgentReferenceState() || !getAgentReferenceTray()) return;
    document.documentElement.dataset.lingxiAgentReferencesV1 = "1";
    const input = byId("chatInput");
    input.addEventListener("input", () => {
      if (/(^|\s)@$/.test(String(input.value || ""))) showAtDocumentMenu(input);
    });
    document.addEventListener("contextmenu", (event) => {
      const selection = window.getSelection?.();
      if (!selectionIsAgentReferenceable(selection)) return;
      const text = String(selection.toString() || "").trim();
      event.preventDefault();
      event.stopPropagation();
      showAgentReferenceMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          { label: "复制", action: () => { try { document.execCommand("copy"); } catch (_) { navigator.clipboard?.writeText?.(text).catch(() => {}); } } },
          { label: "设为 Agent 引用", action: () => addAgentHistoryReference(text) }
        ]
      });
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (agentReferenceMenu && !agentReferenceMenu.contains(event.target)) closeAgentReferenceMenu();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAgentReferenceMenu();
    }, true);
    window.addEventListener("resize", closeAgentReferenceMenu, { passive: true });
    renderAgentReferences();
  }

  let pendingAgentReferenceRequest = null;

  function contentIncludesAgentReferencePrompt(content, prompt) {
    if (typeof content === "string") return content.includes(prompt);
    if (!Array.isArray(content)) return false;
    return content.some((part) => typeof part?.text === "string" && part.text.includes(prompt));
  }

  function clearPendingAgentReferences(pending) {
    if (!pending || pendingAgentReferenceRequest?.id !== pending.id) return;
    if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
    pendingAgentReferenceRequest = null;
  }

  function armAgentReferencesForManualSend() {
    const state = getAgentReferenceState();
    const input = byId("chatInput");
    const prompt = String(input?.value || "").trim();
    if (!state || !prompt || state.list().length === 0) return;
    const references = state.consume();
    const context = window.WpsAiAgentReferences?.buildReferenceContext?.(references, { maxContextChars: 36000 }) || "";
    if (!context) return;
    const pending = {
      id: `agent-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      context,
      expiresAt: Date.now() + 10000,
      timeoutId: 0
    };
    pending.timeoutId = window.setTimeout(() => clearPendingAgentReferences(pending), 10000);
    pendingAgentReferenceRequest = pending;
    setAgentReferenceNotice("");
    renderAgentReferences();
  }

  function installAgentReferenceRequestBridge() {
    const client = window.WpsAiOpenAI;
    if (!client || client.__lingxiAgentReferenceBridgeV1 || typeof client.runWithTools !== "function") return;
    const originalRunWithTools = client.runWithTools.bind(client);
    Object.defineProperty(client, "__lingxiAgentReferenceBridgeV1", { value: true, configurable: false });
    client.runWithTools = async (request) => {
      const pending = pendingAgentReferenceRequest;
      const matchesManualChat = pending && Date.now() <= pending.expiresAt && Array.isArray(request?.messages)
        && request.messages.some((message) => message?.role === "user" && contentIncludesAgentReferencePrompt(message.content, pending.prompt));
      if (!matchesManualChat) return originalRunWithTools(request);
      const referenceSystemMessage = {
        role: "system",
        content: `[Agent references — use as supplementary context only]\n${pending.context}`
      };
      const scopedRequest = Object.assign({}, request, { messages: [referenceSystemMessage, ...request.messages] });
      try {
        return await originalRunWithTools(scopedRequest);
      } finally {
        clearPendingAgentReferences(pending);
      }
    };
  }

  function installAgentReferenceSendBridge() {
    const send = byId("chatSendBtn");
    if (!send || send.dataset.lingxiAgentReferenceSendBridge === "1") return;
    send.dataset.lingxiAgentReferenceSendBridge = "1";
    send.addEventListener("click", armAgentReferencesForManualSend, true);
    installAgentReferenceRequestBridge();
  }

  function installChatCopyShortcut() {
    if (document.documentElement.dataset.lingxiChatCopyShortcutV1 === "1") return;
    document.documentElement.dataset.lingxiChatCopyShortcutV1 = "1";
    const isSelectionInChat = (selection) => {
      if (!selection || selection.rangeCount < 1 || !String(selection.toString() || "").trim()) return false;
      const stream = byId("chatStream");
      const node = selection.anchorNode || selection.focusNode;
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return !!(stream && element && stream.contains(element) && element.closest?.(".chat-msg, .tool-body, .reasoning-body"));
    };
    document.addEventListener("keydown", (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || String(event.key || "").toLowerCase() !== "c") return;
      // 输入框仍由原业务层处理；这里只接管 AI 消息正文的原生文本选区，阻止 WPS 主窗口抢走 ⌘C/Ctrl+C。
      const active = document.activeElement;
      if (active?.matches?.("input, textarea, select, [contenteditable='true']")) return;
      const selection = window.getSelection?.();
      if (!isSelectionInChat(selection)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      // execCommand 使用保留的 DOM 选区，和浏览器右键“复制”走同一条路径；必须同步执行以保留用户手势。
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (_) {}
      if (!copied) {
        const text = String(selection?.toString() || "");
        navigator.clipboard?.writeText?.(text).catch(() => {});
      }
    }, true);
  }

  function installMacPasteIsolation() {
    if (document.documentElement.dataset.lingxiPasteIsolationV1 === "1") return;
    document.documentElement.dataset.lingxiPasteIsolationV1 = "1";
    const isChatInput = (el) => el && (el.id === "chatInput" || el.closest?.("#chatInput"));
    document.addEventListener("keydown", (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || String(ev.key || "").toLowerCase() !== "v") return;
      const target = document.activeElement;
      if (!isChatInput(target)) return;
      // app.js 的 capture handler 已先建立 pendingManualPaste；阻止后由它的 clipboard fallback
      // 只向 TaskPane 写入一次，从而不污染左侧正文。
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
    }, true);

    // WPS 的原生右键菜单会把“粘贴”执行到 Writer。已有自定义菜单缺少粘贴项，
    // 因此在其菜单创建后补入本地、安全的粘贴动作。
    document.addEventListener("contextmenu", (ev) => {
      const target = ev.target?.closest?.("#chatInput");
      if (!target) return;
      const start = Number.isFinite(target.selectionStart) ? target.selectionStart : null;
      const end = Number.isFinite(target.selectionEnd) ? target.selectionEnd : null;
      window.setTimeout(() => {
        const menu = document.querySelector(".editable-context-menu");
        if (!menu || menu.dataset.lingxiPasteAdded === "1") return;
        menu.dataset.lingxiPasteAdded = "1";
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.textContent = "粘贴";
        button.addEventListener("click", async (clickEv) => {
          clickEv.preventDefault();
          clickEv.stopPropagation();
          try {
            target.focus();
            if (start != null && end != null) { target.selectionStart = start; target.selectionEnd = end; }
            await window.WpsAiClipboard?.pasteInto?.(target);
          } finally { menu.remove(); }
        });
        menu.insertBefore(button, menu.firstChild);
      }, 0);
    }, true);
  }

  function initServiceConfigurationSurface() {
    if (!document.body || !document.querySelector(".settings-content")) return;
    if (document.body.dataset.lingxiServiceModelManagerV1 === "1") return;
    document.body.dataset.lingxiServiceModelManagerV1 = "1";
    document.body.classList.add("lingxi-service-manager-v1");
    ensureLiteLlmModelManager();
    installLiteLlmModelVisibilityBridge();
    installProviderModelManagement();
    installCodexOfficialDirectMigration();
  }

  function init() {
    if (!isMainTaskPane() || !document.body || !document.querySelector(".app-shell")) return;
    if (document.body.dataset.lingxiGraphiteV1 === "1") return;
    document.body.dataset.lingxiGraphiteV1 = "1";
    document.body.classList.add("lingxi-graphite-v1");
    document.documentElement.setAttribute("data-lingxi-redesign", MARKER);

    const header = document.querySelector(".app-header");
    const headerControls = document.querySelector(".header-controls");
    const tabBar = document.querySelector(".tab-bar");
    if (!header || !headerControls || !tabBar) return;

    header.classList.add("lg-product-header");
    tabBar.classList.add("lg-primary-tabs");
    document.querySelectorAll(".tab-btn").forEach((button) => {
      const tab = button.dataset.tab;
      setTabLabel(button, tab === "ai" ? "助手" : tab === "history" ? "改动" : tab === "image" ? "生图" : button.textContent.trim());
    });
    const spacer = tabBar.querySelector(".tab-bar-spacer");
    if (spacer) spacer.classList.add("lg-tab-spacer");

    applyCompactWpsAiBrand();
    buildMoreMenu(headerControls);
    arrangeComposer();
    ensureInspectionLiveBar();
    ensureWritePreviewGateBar();
    installDocumentPreviewGate();
    installDocumentPreviewToolGate();
    installInspectionTimelineBridge();
    installInspectionBusyObserver();
    installTaskProgressOverlay();
    installTaskProgressTimelineBridge();
    installTaskProgressStopBridge();
    installProcessAutoCollapse();
    installFloatingPopupGuard();
    installAgentReferences();
    installAgentReferenceSendBridge();
    installChatCopyShortcut();
    installMacPasteIsolation();
    enhanceAccessibility();
    installLiteLlmSettingsEnhancements();

    const revise = byId("reviseModeBar");
    if (revise) revise.classList.add("lg-revision-bar");
    const aiView = byId("aiView");
    if (aiView) aiView.classList.add("lg-assistant-view");
    const historyView = byId("historyView");
    if (historyView) historyView.classList.add("lg-history-view");
    const imageView = byId("imageView");
    if (imageView) imageView.classList.add("lg-image-view");
  }

  function schedule() {
    window.requestAnimationFrame(() => window.setTimeout(() => {
      init();
      initServiceConfigurationSurface();
    }, 0));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule, { once: true });
  else schedule();
})();
