(function registerWriterFormatGuardTools(global) {
  "use strict";

  // LINGXI_WRITER_FORMAT_GUARD_V1
  const registry = global.WpsAiToolRegistry;
  const guard = global.WpsAiWriterFormatGuard;
  if (!registry || !guard) {
    try { console.warn("[writer-format-guard] registry 或 host 不可用，跳过注册。"); } catch (error) {}
    return;
  }

  const requirementsProperties = {
    fontName: { type: "string", description: "目标字体名称，例如 宋体、仿宋、Arial。只会改动字体实际不符合的段落。" },
    fontSize: { type: "number", description: "目标字号（磅）。" },
    alignment: { type: "string", enum: ["left", "center", "right", "justify", "distribute"], description: "目标段落对齐方式。" },
    lineSpacing: { type: "number", description: "目标行距（磅）；与 lineSpacingRule 配合使用。" },
    lineSpacingRule: { type: "string", enum: ["single", "oneAndHalf", "double", "atLeast", "exactly", "multiple"], description: "目标行距规则；1.5 倍行距使用 oneAndHalf。" },
    spaceBefore: { type: "number", description: "目标段前（磅）。" },
    spaceAfter: { type: "number", description: "目标段后（磅）。" },
    characterUnitFirstLineIndent: { type: "number", description: "字符单位首行缩进。设置点值缩进前通常应传 0，避免 WPS 用字符单位覆盖点值。" },
    characterUnitLeftIndent: { type: "number", description: "字符单位左缩进。设置点值缩进前通常应传 0。" },
    characterUnitRightIndent: { type: "number", description: "字符单位右缩进。设置点值缩进前通常应传 0。" },
    firstLineIndent: { type: "number", description: "目标首行缩进（磅）。" },
    leftIndent: { type: "number", description: "目标左缩进（磅）。" },
    rightIndent: { type: "number", description: "目标右缩进（磅）。" }
  };

  registry.registerTool({
    name: "wps_audit_paragraph_format",
    hosts: ["wps"],
    description: [
      "只读审计当前 WPS 文字文档的字体与段落格式，返回真正不符合 requirements 的连续锚点组；不会修改文档。",
      "用户要求统一字体、字号、行距、缩进、对齐、段前段后时，必须先调用本工具。",
      "如果 mismatchCount 为 0，明确告诉用户无需修改，禁止调用任何格式写工具。",
      "如果 mismatchCount 大于 0，下一步只能调用 wps_apply_paragraph_format_mismatches，传回 auditId 与 documentFingerprint；该工具会仅改不符合项。",
      "修改后必须再次调用本工具复核，确认 mismatchCount 为 0。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["requirements"],
      properties: {
        requirements: { type: "object", minProperties: 1, properties: requirementsProperties, additionalProperties: false },
        startAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "可选起始段落锚点；不传时审计全文。" },
        endAnchor: { type: "string", pattern: "^§[1-9][0-9]*$", description: "可选结束段落锚点。" },
        anchors: { type: "array", maxItems: 5000, items: { type: "string", pattern: "^§[1-9][0-9]*$" }, description: "可选离散锚点；与范围二选一。" },
        includeTables: { type: "boolean", default: true, description: "是否审计表格单元格中的段落，默认 true。" },
        maxParagraphs: { type: "integer", minimum: 1, maximum: 5000, description: "审计上限，默认当前范围全部。" }
      }
    },
    handler: async (args = {}) => await guard.auditParagraphFormat(args)
  });

  registry.registerTool({
    name: "wps_apply_paragraph_format_mismatches",
    hosts: ["wps"],
    description: [
      "根据刚完成的 wps_audit_paragraph_format 审计令牌，仅修改仍不符合要求的段落。",
      "写入前会重新读取每个候选段落；已经符合的段落会跳过，并且每段只设置确实不同的字段，避免修订模式产生无意义的格式改动。",
      "不能传任意范围或任意格式，不能绕过审计。调用后必须再次审计复核。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["auditId", "expectedDocumentFingerprint"],
      properties: {
        auditId: { type: "string", description: "wps_audit_paragraph_format 返回的 auditId。" },
        expectedDocumentFingerprint: { type: "string", description: "同一次审计返回的 documentFingerprint。" }
      },
      additionalProperties: false
    },
    handler: async (args = {}) => await guard.applyParagraphFormatMismatches(args)
  });

  const legacy = registry.getDefinition?.("wps_format_paragraph");
  if (legacy && !legacy.__lingxiFormatGuardWrapped) {
    const legacyHandler = legacy.handler;
    registry.registerTool({
      ...legacy,
      origin: "writer-format-guard",
      replaces: legacy.origin || "legacy",
      __lingxiFormatGuardWrapped: true,
      description: [
        legacy.description || "设置段落格式。",
        "安全约束：禁止使用 scope=document 直接全量写入，因为它会改写已经符合格式的段落并制造无意义修订。",
        "用户要求全文/范围统一字体、字号、行距、缩进或对齐时，必须改用 wps_audit_paragraph_format → wps_apply_paragraph_format_mismatches → 再次审计。",
        "本工具仅允许对用户已选中的局部 selection 应用格式。"
      ].join("\n"),
      handler: async (args = {}, ctx = {}) => {
        if (String(args?.scope || "selection") === "document") {
          throw new Error("BULK_FORMAT_BLOCKED：全文格式不能直接覆盖。请先调用 wps_audit_paragraph_format，只有 mismatchCount > 0 时调用 wps_apply_paragraph_format_mismatches，最后再审计复核。");
        }
        return await legacyHandler(args, ctx);
      }
    });
  }
})(window);
