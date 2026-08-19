(function registerWriterHeaderTableWidthTools(global) {
  "use strict";
  // LINGXI_WRITER_HEADER_TABLE_WIDTH_V2
  const registry = global.WpsAiToolRegistry, host = global.WpsAiWriterHeaderTableWidth;
  if (!registry || !host) return;
  const common = {
    sectionIndex: { type: "integer", minimum: 1, default: 1 },
    headerKind: { type: "string", enum: ["primary", "firstPage", "evenPages"], default: "primary" },
    headerTableIndex: { type: "integer", minimum: 1, default: 1 },
    bodyTableIndex: { type: "integer", minimum: 1, default: 1 }
  };
  registry.registerTool({
    name: "wps_get_header_table_metrics", hosts: ["wps"],
    description: "只读读取页眉/正文表格的列宽、总宽、首选宽度和自动调整状态。`0`、`9999999` 或超安全上限的值仅表示接口异常，绝不能当作物理宽度或写入依据。页眉修复前还必须调用 wps_get_header_table_recovery_profile。",
    parameters: { type: "object", properties: common }, handler: async (args) => await host.getHeaderTableMetrics(args)
  });
  registry.registerTool({
    name: "wps_align_header_table_width", hosts: ["wps"],
    description: "已暂停：直接调整页眉总宽、自动调整或列宽会在 WPS 合并单元格中产生半写入和零宽列。仅返回明确暂停错误，不会修改文档。",
    parameters: { type: "object", properties: { ...common, expectedBodyMetrics: { type: "object" } } }, handler: async (args) => await host.alignHeaderTableWidth(args)
  });
})(window);
