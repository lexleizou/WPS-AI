#!/usr/bin/env python3
"""Structural tests for the reversible Graphite TaskPane patch."""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLER = HERE / "apply-taskpane-redesign.py"
CSS = HERE / "lingxi-graphite-taskpane.css"
JS = HERE / "lingxi-graphite-taskpane.js"

spec = importlib.util.spec_from_file_location("lingxi_taskpane_installer", INSTALLER)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)

checks = []

def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)

subprocess.run(["node", "--check", str(JS)], check=True)
check("node syntax", True)

css = CSS.read_text(encoding="utf-8")
js = JS.read_text(encoding="utf-8")
check("css marker", "LINGXI_GRAPHITE_TASKPANE_V1" in css)
check("js marker", "LINGXI_GRAPHITE_TASKPANE_V1" in js)
check("15px context ring", ".lg-context-ring" in css and "width: 15px" in css and "height: 15px" in css)
check("system dark", "prefers-color-scheme: dark" in css)
check("reduced motion", "prefers-reduced-motion: reduce" in css)
check("revision preserved", "#reviseModeBar" not in css and ".revise-mode-bar" in css and "reviseModeBar" in js)
check("no voice control", "microphone" not in js.lower() and "voice" not in js.lower())
check("main modes guarded", "SPECIAL_MODES" in js and "SPECIAL_MODE_PARAMS" in js and "paralleltranslate" in js and "URLSearchParams" in js and "isMainTaskPane" in js)
check("compact WPS AI text header", all(token in js for token in ["applyCompactWpsAiBrand", 'name.textContent = "WPS AI"']) and all(token in css for token in ["min-height: 42px", ".brand-logo,", ".brand-version-row { display: none", ".brand-name {"]))
check("model moved not cloned", "toolbar.appendChild(node)" in js and "model-select-wrap" in js)
check("existing controls referenced", all(x in js for x in [
    "newConversationBtn", "conversationsMenuBtn", "refreshModelsBtn", "forceUnlockBtn",
    "chatFoldToggle", "dockToggleBtn", "openSettingsModalBtn", "chatAttachBtn",
    "chatModelOverrideBtn", "capThinking", "chatSendBtn", "chatStopBtn"
]))
check("tab and thinking accessibility", "aria-selected" in js and "ArrowRight" in js and "切换思考强度" in js)
check("exact model label sync", "syncModelLabel" in js and "select.value" in js and "MutationObserver" in js and "prettifyModelName" not in js)
check("chat response shortcut copy", all(token in js for token in ["installChatCopyShortcut", "lingxiChatCopyShortcutV1", "isSelectionInChat", "document.execCommand(\"copy\")", "WPS 主窗口抢走 ⌘C/Ctrl+C"]))
check("agent reference UI", all(token in js for token in ["installAgentReferences", "lingxiAgentReferenceTray", "lingxiAgentReferenceMenu", "设为 Agent 引用", "当前 WPS 文档", "removeAgentReference", "readDocumentText"]) and all(token in css for token in [".lingxi-agent-reference-tray", ".lingxi-agent-reference-chip", ".lingxi-agent-reference-menu"]))
check("agent reference one-turn request bridge", all(token in js for token in ["pendingAgentReferenceRequest", "expiresAt: Date.now() + 10000", "installAgentReferenceRequestBridge", "role: \"system\"", "[Agent references — use as supplementary context only]", "finally", "clearPendingAgentReferences"]) and "chatInput.value = pending" not in js and "chatHistory" not in js.split("let pendingAgentReferenceRequest", 1)[1].split("function installChatCopyShortcut", 1)[0])
check("model label preserves business rendering", "label.textContent = concise" not in js and "不覆盖可见文案" in js)
check("composer model control has readable width", all(token in css for token in ["flex: 0 1 300px", "min-width: 220px", "max-width: 320px"]))
check("context usage tooltip", "installContextUsage" in js and "lingxiContextTooltip" in js and ".lingxi-context-tooltip" in css and "position: fixed" in css and "--lg-context-pct" in css and "128K" in js and "ring.removeAttribute(\"title\")" in js)
check("dark popup surfaces", ".thinking-menu" in css and ".chat-model-override-picker" in css and "--bg: var(--lg-bg-elevated)" in css)
check("popup viewport clamp", "clampFloatingPopup" in js and "installFloatingPopupGuard" in js and "viewportWidth - width - margin" in js and "max-width: calc(100vw - 16px)" in css)
check("model popup exposes long identifiers", all(token in css for token in ["max-width: 380px", "max-height: min(360px, 60vh)", "overflow-y: auto", "model-select-popup::-webkit-scrollbar"]))
check("runtime process visibility", ".chat-msg.assistant.thinking" in css and ".chat-msg.tool" in css and ".dot-typing span" in css)
check("long running message contrast", ".message.info" in css and ".message.success" in css and ".message.error" in css and "body.lingxi-graphite-v1 .message" in css)
check("todo patch runtime surface", ".chat-todo-panel" in css and "#chatTodoPanel" in css and "max-height: 176px" in css and ".chat-todo-list" in css and "background: var(--lg-bg-container)" in css)
check("document map summary preview gate", all(token in js for token in ["installDocumentPreviewGate", "installDocumentPreviewToolGate", "wps_get_document_map", "阶段二：只读修改预览", "确认按预览修改", "PREVIEW_GATE_REQUIRED", "READ_ONLY_SCAN_NO_NAVIGATION", "reveal_location", "autoPreviewPending", "stop.click()", "禁止分段生成完整文稿"]) and ".lingxi-write-preview-gate" in css)
check("document preview avoids full rewrite route", "escapedStagingRequest" in js and "LONG_REWRITE_ROUTE_TERMS" in js and "不得弹出整份文稿预览窗口" in js)
check("proma task state machine", "normalizeTaskSnapshot" in js and "deriveTaskSummary" in js and "completed === total" in js and 'task.status === "completed"' in js and "TASK_STATUS" in js)
check("proma task truthful states", all(token in js for token in ["已跳过", "失败", "已停止", "被阻塞", "failedIds", "stoppedIds", "stopEpoch"]))
check("proma task real tool bridge", "installTaskProgressTimelineBridge" in js and 'name === "todo_replace_all"' in js and 'name === "todo_patch"' in js and "originalFinish(sourceRef, result)" in js)
check("proma task original stop reuse", "installTaskProgressStopBridge" in js and "chatStopBtn" in js and "stop.addEventListener(\"click\"" in js)
check("proma task accessible responsive ui", all(token in css for token in [".lingxi-task-compact", ".lingxi-task-detail", 'data-expanded="true"', "@keyframes lg-task-pulse", "@media (max-width: 420px)"]) and "aria-expanded" in js and "role\", \"progressbar" in js)
check("process auto collapse", all(token in js for token in ["installProcessAutoCollapse", "liveProcessRails", "collapseFinishedProcessRail", "expandLiveProcessRail", "scrollProcessToLatest", "aria-label\", \"展开或收起思考与工具详情"]) and ".tl-step-process > .tl-step-head::after" in css)
check("per-tool disclosure", all(token in js for token in ["enhanceToolDisclosure", "normalizeToolDisclosures", "setToolDisclosure", "展开或收起此工具的参数与结果"]) and all(token in css for token in [".tl-tool-row-head::after", ".tl-tool-row-detail[hidden]"]))
check("inspection phases", "INSPECTION_PHASES" in js and all(name in js for name in ["wps_get_document_map", "wps_read_by_anchor", "wps_read_paragraph_format"]))
check("inspection timeline bridge", "installInspectionTimelineBridge" in js and "beginAssistantTurn" in js and "addToolStep" in js and "finishToolStep" in js)
check("inspection replay bridge", "renderAssistantTurn" in js and "wrappedInspectionReplay" in js and "controller.hydrate" in js)
check("inspection preserves timeline order", "const originalRef = originalAdd(name, args)" in js and "inspectionRef.originalRef = originalRef" in js)
check("inspection ignores late results", "controller.accepts(ref)" in js and "if (!accepts(ref)) { render(); return; }" in js)
check("inspection terminates mirrored source", "finishOriginal" in js and "工具未返回结果" in js and "tl-step-status-stopped" in js and "tl-step-status-stopped" in css)
check("inspection syncs mixed source", "controller.syncSources()" in js and "syncSources: syncSourceProcesses" in js)
check("inspection replay stops orphan calls", "step.status === \"running\" ? \"stopped\"" in js)
check("inspection hides mirrored source", "lingxi-inspection-source-hidden" in js and "lingxi-inspection-source-hidden" in css)
check("inspection aggregate card", ".lingxi-inspection-card" in css and "lingxi-inspection-progress" in js and "lingxi-inspection-step" in js)
check("inspection incomplete terminal", "文档检查未完成" in js and "未执行" in js and 'data-state="incomplete"' in css)
check("inspection path aware completion", "格式检查完成" in js and "内容精读完成" in js and "无需执行" in js and "inspectionPath" in js and "wps_audit_paragraph_format" in js and 'data-status="not-required"' in css)
check("inspection preset minimal format workflow", "wps_audit_paragraph_format" in js and "wps_apply_paragraph_format_mismatches" in js and "不得用 wps_format_paragraph(scope=document)" in js and "PREVIOUS_URS_PROMPT" in js)
check("inspection live stop reuses original", "lingxiInspectionLiveBar" in js and "chatStopBtn" in js and ".click()" in js)
check("inspection responsive", "@media (max-width: 420px)" in css and ".lingxi-inspection-live" in css)
check("prompt presets replace override", "installPromptPresetControl" in js and "stopImmediatePropagation" in js and "lingxi-prompt-presets-v1" in css)
check("prompt presets local persistence", "PROMPT_STORE_KEY" in js and "PROMPT_ACTIVE_KEY" in js and "PROMPT_CORRUPT_KEY" in js and "localStorage" in js)
check("prompt presets CRUD", all(token in js for token in ["新建提示词预置", "编辑提示词预置", "复制预置", "删除提示词预置", "提示词预置已保存"]))
check("prompt preset experience review", "生成经验总结" in js and "收录最近回复到当前预置" in js and "不会由 AI 静默覆盖" in js)
check("experience uses latest message only", "#chatStream .tl-msg" in js and "classList.contains(\"tl-assistant\")" in js and "最近一轮尚无可收录" in js and "最近一轮仍在执行" in js)
check("prompt preset limit is explicit", js.count("最多保存 50 套预置") >= 2)
check("prompt preset independent active state", "lingxi-prompt-has-active" in js and "lingxi-prompt-has-active" in css)
check("prompt preset draft equality guard", "promptPresetFilledValues" in js and "promptPresetFilledValues.get(input) === currentValue" in js)
check("prompt preset invalid structure recovery", "INVALID_PROMPT_PRESET_STORE" in js and "INVALID_PROMPT_PRESET_ITEMS" in js)
summary_segment = js.split("function insertExperienceSummaryRequest", 1)[1].split("function collectLatestAssistantExperience", 1)[0]
check("experience summary does not auto send", "chatSendBtn" not in summary_segment and "writePromptToComposer" in summary_segment)
check("prompt preset text safety", "preset.prompt.replace" in js and "textContent = message" in js and "innerHTML = preset" not in js)
check("prompt preset responsive", ".lingxi-prompt-preset-picker" in css and ".lingxi-prompt-modal-overlay" in css and "width: min(360px, calc(100vw - 16px))" in css)
check("LiteLLM model manager", all(token in js for token in ["ensureLiteLlmModelManager", "/service/litellm/models", "/service/litellm/model-visibility", "关闭仅从灵犀AI模型选择器隐藏", "installLiteLlmModelVisibilityBridge"]) and all(token in css for token in [".lg-litellm-manager", ".lg-litellm-model-row", ".lg-model-hidden-by-user"]))
check("Codex OAuth official direct migration", all(token in js for token in ["Codex OAuth（官方直连）", "installCodexOfficialDirectMigration", "migrateCodexToOfficialDirect", "/service/codex-oauth/status", "不经过 LiteLLM"]))
check("provider model fetch and management", all(token in js for token in ["ensureProviderModelManagement", "installProviderModelManagement", "已拉取模型管理", "拉取模型", "syncProviderModelsCache", "setProviderModelDisabled"]) and all(token in css for token in [".lg-provider-model-manager", ".lg-provider-model-row"]))
check("service dialog model manager bootstrap", all(token in js for token in ["initServiceConfigurationSurface", "lingxiServiceModelManagerV1", "initServiceConfigurationSurface();"]) and "body.lingxi-service-manager-v1" in css)
check("Codex obsolete catalog fallback retired", "installCodexEmptyCatalogFallback" not in js and "codexFallbackModels" not in js and "hideNativeCodexConfigCard" in js)

sample = '<html><head>\n    <link rel="stylesheet" href="./css/style.css" />\n</head><body><div id="chatInput"></div>\n  </body></html>\n'
injected = mod.inject(sample)
check("inject css once", injected.count(mod.CSS_START) == 1 and injected.count(mod.CSS_END) == 1)
check("inject js once", injected.count(mod.JS_START) == 1 and injected.count(mod.JS_END) == 1)
reinjected = mod.inject(injected)
check("inject idempotent", reinjected.count(mod.CSS_START) == 1 and reinjected.count(mod.JS_START) == 1)
stripped = mod.strip_managed_blocks(injected)
check("strip managed blocks", mod.CSS_START not in stripped and mod.JS_START not in stripped)

print(f"PASS {len(checks)} checks")
for name in checks:
    print("-", name)
