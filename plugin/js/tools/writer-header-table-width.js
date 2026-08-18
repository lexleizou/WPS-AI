(function registerWriterHeaderTableWidthTools(global) {
  "use strict";
  // LINGXI_WRITER_HEADER_TABLE_WIDTH_V1
  const registry = global.WpsAiToolRegistry, host = global.WpsAiWriterHeaderTableWidth;
  if (!registry || !host) return;
  const common = {
    sectionIndex: { type: "integer", minimum: 1, default: 1, description: "文档节序号（从1开始）" },
    headerKind: { type: "string", enum: ["primary", "firstPage", "evenPages"], default: "primary", description: "主页眉/首页页眉/奇偶页页眉" },
    headerTableIndex: { type: "integer", minimum: 1, default: 1, description: "目标页眉中的表格序号（从1开始）" },
    bodyTableIndex: { type: "integer", minimum: 1, default: 1, description: "作为宽度来源的正文表格序号（从1开始）" }
  };
  registry.registerTool({
    name: "wps_get_header_table_metrics", hosts: ["wps"],
    description: "只读读取指定页眉表格和正文表格的列宽、总宽、首选宽度和自动调整状态。不会改变文档、选区、滚动位置、页边距或页眉内容；对齐前必须先调用。",
    parameters: { type: "object", properties: common },
    handler: async (args = {}) => await host.getHeaderTableMetrics(args)
  });
  registry.registerTool({
    name: "wps_align_header_table_width", hosts: ["wps"],
    description: "【精确写入】仅把指定节、指定页眉中的目标表格宽度对齐到指定正文表格。必须先用 wps_get_header_table_metrics 取得 expectedBodyMetrics；若页眉网格存在两格行与三格参考行混用，禁止使用本工具，必须先用 wps_normalize_header_table_row_to_three_columns 恢复结构。只会改目标页眉表格的自动调整/首选宽度，不改正文表格、页边距、页眉文字或其他表格，并在写后复核。",
    parameters: { type: "object", properties: { ...common, expectedBodyMetrics: { type: "object", description: "上一轮 metrics 返回的 body 对象，用于防止正文宽度已变" } }, required: ["expectedBodyMetrics"] },
    handler: async (args = {}) => await host.alignHeaderTableWidth(args)
  });
})(window);
