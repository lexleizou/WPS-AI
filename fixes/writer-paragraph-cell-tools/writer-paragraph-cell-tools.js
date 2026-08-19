(function attachWriterParagraphCellTools(global) {
  "use strict";

  // LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1
  const registry = global.WpsAiToolRegistry;
  const api = global.WpsAiParagraphCellTools;
  if (!registry || !api) return;

  registry.registerTool({
    name: "wps_delete_empty_paragraphs",
    hosts: ["wps"],
    description: [
      "删除一段连续的空段落区间（如 §95–§100 的多余空段）。",
      "硬性预检：expectedParagraphCount 必须等于 wps_get_document_map 返回的当前段落总数；区间内每个段落都必须无可见文字、无分页/分节符、不在表格内、不含图片/形状——任一不满足则整体中止、不删任何段落。",
      "自后向前删除并复核段落总数恰好减少区间长度；验证失败会提示用撤销/备份恢复。",
      "表格单元格末尾的强制空段会被拒绝删除（破坏表格结构），这是预期行为。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["startParagraph", "endParagraph", "expectedParagraphCount"],
      properties: {
        startParagraph: { type: "integer", minimum: 1, description: "区间起始段落锚点（§N 的 N）。" },
        endParagraph: { type: "integer", minimum: 1, description: "区间结束段落锚点（含），必须 ≥ startParagraph。" },
        expectedParagraphCount: { type: "integer", minimum: 1, description: "wps_get_document_map 返回的当前段落总数，防止文档变更后误删。" }
      }
    },
    handler: async (args = {}) => await api.deleteEmptyParagraphs(args)
  });

  registry.registerTool({
    name: "wps_clear_header_cell_text",
    hosts: ["wps"],
    description: [
      "清除主页眉指定表格单元格内的指定文字（如 Logo 图片旁的残留文字），严格保留图片。",
      "安全约束：目标文字必须在单元格内恰好出现 1 次；单元格必须含图片（本工具只用于「图片+文字」单元格）；只删除文字子范围，写后校验图片数量不变且文字已消失。",
      "先用 wps_get_header_footer_map 确认节、表格序号、单元格行列与文字内容。存在合并单元格时按实际 Cell(row,column) 可访问性定位。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["expectedText"],
      properties: {
        sectionIndex: { type: "integer", minimum: 1, description: "节序号，默认 1。" },
        tableIndex: { type: "integer", minimum: 1, description: "主页眉内的表格序号，默认 1。" },
        row: { type: "integer", minimum: 1, description: "单元格行号，默认 1。" },
        column: { type: "integer", minimum: 1, description: "单元格列号，默认 1。" },
        expectedText: { type: "string", minLength: 1, description: "要清除的文字，必须在单元格内恰好出现一次。" }
      }
    },
    handler: async (args = {}) => await api.clearHeaderCellText(args)
  });
})(window);
