(function attachWriterFollowFeedback(global) {
  "use strict";

  // LINGXI_WRITER_FOLLOW_FEEDBACK_V1
  // 只在真实写入成功后定位到本次修改。审计/地图/只读工具完全不经过此模块。
  const MARKER = "LINGXI_WRITER_FOLLOW_FEEDBACK_V1";
  let transientSelection = null;

  function app() {
    try { return global.WpsAiAddon?.getApplicationSync?.() || global.wps?.Application || null; } catch (error) { return null; }
  }
  function parseAnchor(anchor) {
    const match = /^§([1-9]\d*)$/.exec(String(anchor || "").trim());
    return match ? Number(match[1]) : null;
  }
  function isMutating(name) {
    try { return !!global.WpsAiHistory?.isMutatingTool?.(name); } catch (error) { return false; }
  }
  function enabled() {
    try { return global.WpsAiProviderRegistry?.loadSettings?.().aiFollowHighlight !== false; } catch (error) { return true; }
  }
  function clearTransientSelection() {
    const target = transientSelection;
    transientSelection = null;
    if (!target) return;
    try {
      const selection = app()?.Selection;
      if (selection?.SetRange) selection.SetRange(target.end, target.end);
    } catch (error) { /* 视觉反馈清理失败不能影响写入 */ }
  }
  function selectParagraphRange(target) {
    if (!target || target.kind !== "paragraphRange") return false;
    const first = parseAnchor(target.startAnchor);
    const last = parseAnchor(target.endAnchor || target.startAnchor);
    if (!first || !last || last < first) return false;
    try {
      const a = app();
      const document = a?.ActiveDocument;
      const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
      const startRange = paragraphs?.Item(first)?.Range;
      const endRange = paragraphs?.Item(last)?.Range;
      const start = Number(startRange?.Start), end = Number(endRange?.End);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
      const range = typeof document?.Range === "function" ? document.Range(start, end) : null;
      if (!range) return false;
      try { a?.ActiveWindow?.ScrollIntoView?.(range, true); } catch (error) {}
      // WPS 原生 Selection 是不改文档格式的临时高亮。下一次写入前会由包装器折叠，
      // 因此不会让连续插入意外变成“替换选中区域”。
      try { range.Select?.(); } catch (error) { return false; }
      transientSelection = { end };
      return true;
    } catch (error) { return false; }
  }
  function install() {
    const follow = global.WpsAiFollow;
    const registry = global.WpsAiToolRegistry;
    if (!follow || !registry?.execute) { global.setTimeout?.(install, 80); return; }
    if (follow[MARKER] || registry[MARKER]) return;

    const originalAfterMutatingTool = follow.afterMutatingTool;
    follow.afterMutatingTool = function writerFollowFeedback(host, name, args, value) {
      try { originalAfterMutatingTool?.(host, name, args, value); } catch (error) {}
      if (host === "wps" && enabled()) selectParagraphRange(value?.followTarget);
    };
    follow.clearTransientSelection = clearTransientSelection;
    follow[MARKER] = true;

    const originalExecute = registry.execute.bind(registry);
    registry.execute = async function writerFollowFeedbackExecute(name, args, ctx) {
      // 清理只发生在下一次真实写入前；扫描、地图、预览、失败调用都不会影响用户视口。
      if (isMutating(name)) clearTransientSelection();
      return await originalExecute(name, args, ctx);
    };
    registry[MARKER] = true;
  }
  install();
})(window);
