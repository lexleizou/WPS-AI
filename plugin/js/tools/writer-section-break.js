(function attachWriterSectionBreakTools(global) {
  "use strict";

  // LINGXI_WRITER_SECTION_BREAK_REMOVAL_V1
  const registry = global.WpsAiToolRegistry;
  const sectionBreak = global.WpsAiSectionBreak;
  if (!registry || !sectionBreak) return;

  registry.registerTool({
    name: "wps_inspect_section_boundaries",
    hosts: ["wps"],
    description: "只读检查 WPS 文字文档的分节符边界。返回节总数与 boundaries:[{endingSectionIndex,nextSectionIndex,boundaryParagraph(§段落锚点),breakRange}]。删除分节符前必须先调用，确认目标节与锚点。",
    parameters: { type: "object", properties: {} },
    handler: async () => await sectionBreak.inspectSectionBoundaries()
  });

  registry.registerTool({
    name: "wps_remove_section_break",
    hosts: ["wps"],
    description: [
      "删除指定 WPS 文字分节符，让下一节与前一节连续排版。",
      "这是结构性写入：后一节会并入前一节，页眉页脚、页码、纸张或分栏等节级设置可能继承前一节。",
      "只能在用户明确要求删除并已知该副作用后使用；必须先调用 wps_inspect_section_boundaries，并把返回的 endingSectionIndex、sections 与 boundaryParagraph 原样传入核验。",
      "工具只删除目标节末的一个分节符字符，随后验证节数恰好减一；若验证失败会停止并提示通过备份/撤销恢复。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["endingSectionIndex", "expectedSectionCount"],
      properties: {
        endingSectionIndex: { type: "integer", minimum: 1, description: "要删除其结尾分节符的节序号；来自 wps_inspect_section_boundaries。" },
        expectedSectionCount: { type: "integer", minimum: 2, description: "检查时返回的当前节总数，防止文档已变更后误删。" },
        expectedBoundaryParagraph: { type: "integer", minimum: 1, description: "检查时返回的 boundaryParagraph（§锚点），建议必传以双重核验。" }
      }
    },
    handler: async (args = {}) => await sectionBreak.removeSectionBreak(args)
  });
})(window);
