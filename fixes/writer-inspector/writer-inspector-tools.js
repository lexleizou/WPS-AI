(function registerWriterInspectorTools(global) {
  "use strict";

  // LINGXI_WRITER_INSPECTOR_PHASE1_V1
  const registry = global.WpsAiToolRegistry;
  const inspector = global.WpsAiWriterInspector;
  if (!registry || !inspector) {
    try { console.warn("[writer-inspector] registry 或宿主模块未加载，跳过工具注册。"); } catch (e) {}
    return;
  }

  registry.registerTool({
    name: "wps_get_document_map",
    hosts: ["wps"],
    description: [
      "轻量扫描 WPS 文字文档结构，不返回全文。输出标题、段落采样、关键词位置、表格、节和 §N/TN/SN 锚点。",
      "处理长文档、全文审计或不知道内容位置时应先调用本工具，再用 wps_read_by_anchor 精读。",
      "本工具只读，不修改文档，也绝不改变当前选区、页面位置或阅读视图。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        sampleInterval: { type: "integer", minimum: 10, maximum: 1000, default: 100, description: "每隔多少段采样一次" },
        keywords: { type: "array", maxItems: 20, items: { type: "string" }, description: "可选关键词，返回所在段落锚点" },
        maxHeadings: { type: "integer", minimum: 1, maximum: 500, default: 200 },
        maxSamples: { type: "integer", minimum: 1, maximum: 100, default: 40 },
        maxTables: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        maxKeywordHits: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        previewChars: { type: "integer", minimum: 20, maximum: 300, default: 100 }
      }
    },
    handler: async (args = {}) => await inspector.buildDocumentMap(args)
  });

  registry.registerTool({
    name: "wps_read_by_anchor",
    hosts: ["wps"],
    description: [
      "按 wps_get_document_map 返回的 §N 段落锚点精读文档，或用 aroundKeyword 定位关键词附近内容。",
      "返回带 [§N|Style|kind] 前缀的锚定文本；受 maxParagraphs 和 maxChars 双重限制。",
      "expectedDocumentFingerprint 可阻止使用已经过期的文档地图。本工具只读，不会定位、滚动或改变当前选区。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        startAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "起始段落锚点，如 §12" },
        endAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "结束段落锚点，如 §30" },
        aroundKeyword: { type: "string", description: "按关键词定位；与锚点范围二选一" },
        occurrence: { type: "integer", minimum: 1, default: 1, description: "读取关键词第几次命中" },
        contextBlocks: { type: "integer", minimum: 0, maximum: 100, default: 25, description: "关键词前后各读取多少段" },
        expectedDocumentFingerprint: { type: "string", description: "文档地图返回的 document.fingerprint" },
        maxParagraphs: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        maxChars: { type: "integer", minimum: 1, maximum: 50000, default: 12000 },
        includeMetadata: { type: "boolean", default: true, description: "附带段落Range、样式、kind和文本指纹" }
      }
    },
    handler: async (args = {}) => await inspector.readByAnchor(args)
  });

  registry.registerTool({
    name: "wps_read_paragraph_format",
    hosts: ["wps"],
    description: [
      "只读检查指定 §N 段落的字体、字号、行距、段前段后、缩进、对齐、分页控制、列表和表格上下文。",
      "默认把连续相同格式合并为组，适合 URS 等长文档的全文格式审计。",
      "使用 read_ 命名确保按现有规则识别为只读工具，不创建备份或改动记录，也不改变当前选区或页面位置。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        startAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "起始段落锚点" },
        endAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "结束段落锚点；省略时只读起始段" },
        anchors: { type: "array", maxItems: 200, items: { type: "string", pattern: "^§[1-9][0-9]*$" }, description: "离散段落锚点；与起止范围二选一" },
        expectedDocumentFingerprint: { type: "string", description: "文档地图返回的 document.fingerprint" },
        groupSimilar: { type: "boolean", default: true, description: "合并连续相同格式" },
        includeText: { type: "boolean", default: true, description: "每段附带最多300字符文本预览" },
        maxParagraphs: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      }
    },
    handler: async (args = {}) => await inspector.readParagraphFormat(args)
  });
})(window);
