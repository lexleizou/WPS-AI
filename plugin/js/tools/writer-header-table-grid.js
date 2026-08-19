(function (global) {
  "use strict";
  const registry = global.WpsAiToolRegistry, host = global.WpsAiHeaderTableGrid;
  if (!registry || !host) return;
  const location = {
    sectionIndex: { type: "integer", minimum: 1 },
    headerKind: { type: "string", enum: ["primary", "firstPage", "evenPages"] },
    tableIndex: { type: "integer", minimum: 1 }
  };
  registry.registerTool({
    name: "wps_get_header_table_recovery_profile", hosts: ["wps"],
    description: "【页眉恢复的唯一前置只读工具】读取当前文档、指定节页眉和表格的身份文本、实际所有者节、LinkToPrevious、3×3 网格、合并/Logo/文本指纹及可写状态。任何页眉结构或宽度写入前必须先调用；若目标文档标题或文件编号不同、页眉链接到上一节、列宽异常或结构不健康，必须停止并只报告，不得猜测或写入。",
    parameters: { type: "object", properties: location }, handler: async (args) => await host.recoveryProfile(args)
  });
  registry.registerTool({
    name: "wps_get_header_table_grid", hosts: ["wps"],
    description: "只读返回页眉恢复档案的网格部分，兼容旧流程。它不能授权写入；页眉写入必须改用 wps_get_header_table_recovery_profile 返回的最新 fingerprint。",
    parameters: { type: "object", properties: location }, handler: async (args) => await host.grid(args)
  });
  registry.registerTool({
    name: "wps_split_header_table_cell", hosts: ["wps"],
    description: "已暂停：裸拆分会破坏合并关系、Logo 或列宽，禁止调用。",
    parameters: { type: "object", properties: location }, handler: async () => { throw new Error("HEADER_TABLE_GRID_WRITE_PAUSED：请先建立恢复档案；仅可使用受保护的结构规范化工具。"); }
  });
  registry.registerTool({
    name: "wps_normalize_header_table_row_to_three_columns", hosts: ["wps"],
    description: "【受保护的最小结构写入】仅用于已审计的 3 行×3 列页眉：目标第 1/2 行为两格、参考第 3 行为三格。必须传入最新恢复档案 fingerprint，且 expectedHeaderText 必须来自用户指定的公司名、标题或文件编号；链接到上一节、目标身份不符、Logo/参考行不可保护时会在写前拒绝。写后强制验证 Logo、文本、参考行与合并结构；失败绝不宣称完成，也不得继续改列宽。",
    parameters: { type: "object", properties: {
      ...location,
      row: { type: "integer", minimum: 1, maximum: 2 },
      referenceRow: { type: "integer", minimum: 3, maximum: 3, default: 3 },
      expectedRecoveryProfileFingerprint: { type: "string" },
      expectedHeaderText: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "来自用户任务的标题/文件编号/公司名；不得从当前文档猜测。" }
    }, required: ["sectionIndex", "headerKind", "tableIndex", "row", "expectedRecoveryProfileFingerprint", "expectedHeaderText"] },
    handler: async (args) => await host.normalize(args)
  });
})(window);
