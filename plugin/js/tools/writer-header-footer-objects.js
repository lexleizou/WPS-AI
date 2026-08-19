(function (g) {
  "use strict";
  const registry = g.WpsAiToolRegistry;
  const api = g.WpsAiHeaderFooterObjects;
  if (!registry || !api) return;

  const common = {
    sectionIndex: { type: "integer", minimum: 1 },
    container: { type: "string", enum: ["header", "footer"] },
    kind: { type: "string", enum: ["primary", "firstPage", "evenPages"] },
    expectedFingerprint: { type: "string" },
    alignment: { type: "string", enum: ["left", "center", "right", "justify"] }
  };

  registry.registerTool({
    name: "wps_get_header_footer_map", hosts: ["wps"],
    description: "只读逐节读取主/首页/奇偶页眉页脚：标题段落、Logo/形状、PAGE/NUMPAGES 页码域、表格数量、位置和对象指纹。不会修改文档、选区或视图。",
    parameters: { type: "object", properties: {} }, handler: async () => await api.getMap()
  });
  registry.registerTool({
    name: "wps_set_header_footer_shape_geometry", hosts: ["wps"],
    description: "【精确写入】只移动或缩放指定节指定页眉/页脚的一个Logo/形状。必须使用地图返回的对象指纹；不修改文字、表格、正文或页边距，写后复核。",
    parameters: { type: "object", properties: { ...common, shapeIndex: { type: "integer", minimum: 1 }, left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }, lockAspectRatio: { type: "boolean" } }, required: ["sectionIndex", "container", "kind", "shapeIndex", "expectedFingerprint"] },
    handler: async (args) => await api.setShape(args)
  });
  registry.registerTool({
    name: "wps_set_header_footer_paragraph_alignment", hosts: ["wps"],
    description: "【精确写入】只调整指定页眉/页脚标题段落的对齐方式；不替换任何文本，必须使用地图指纹并写后复核。",
    parameters: { type: "object", properties: { ...common, paragraphIndex: { type: "integer", minimum: 1 } }, required: ["sectionIndex", "container", "kind", "paragraphIndex", "alignment", "expectedFingerprint"] },
    handler: async (args) => await api.setPara(args)
  });
  registry.registerTool({
    name: "wps_set_page_number_alignment", hosts: ["wps"],
    description: "【精确写入】只调整指定 PAGE/NUMPAGES 页码域所在段落的对齐，不重建页码或覆盖页眉页脚内容；必须使用地图指纹并写后复核。",
    parameters: { type: "object", properties: { ...common, fieldIndex: { type: "integer", minimum: 1 } }, required: ["sectionIndex", "container", "kind", "fieldIndex", "alignment", "expectedFingerprint"] },
    handler: async (args) => await api.setPage(args)
  });
  // 覆盖基础工具：页脚页码禁止再走会覆盖 Range.Text 且只支持单 PAGE 的旧通路。
  registry.registerTool({
    name: "wps_set_header_footer", hosts: ["wps"],
    description: "设置普通页眉/页脚文字与对齐。页脚页码禁止使用本工具；PAGE/NUMPAGES 必须改用 wps_set_footer_page_number_pair。",
    parameters: {
      type: "object", properties: {
        target: { type: "string", enum: ["header", "footer"] }, text: { type: "string" }, pageNumber: { type: "boolean" }, alignment: { type: "string", enum: ["left", "center", "right"] }
      }, required: ["target"]
    },
    handler: async (args = {}) => {
      if (args.target === "footer" && (args.pageNumber || /第\s*页|共\s*页|NUMPAGES|PAGE/i.test(String(args.text || "")))) {
        throw new Error("USE_WPS_SET_FOOTER_PAGE_NUMBER_PAIR：页脚页码必须先读取页眉页脚地图，再调用专用 PAGE+NUMPAGES 双域工具；禁止继续覆盖页脚文字。");
      }
      return await g.WpsAiHostWriter.setHeaderFooter(args);
    }
  });

  registry.registerTool({
    name: "wps_set_footer_page_number_pair", hosts: ["wps"],
    description: [
      "【专用安全工具】在指定节页脚直接创建有效 PAGE + NUMPAGES 双域，默认得到居中的‘第 {PAGE} 页/共 {NUMPAGES} 页’。",
      "必须先用 wps_get_header_footer_map 获取整个页脚指纹和当前 expectedText；目标含表格/形状或文字已变化时拒绝写入。",
      "不使用不可靠的 PageNumbers.Add；直接通过 Fields.Add 插入 wdFieldPage(33) 与 wdFieldNumPages(26)，刷新分页并要求两个域结果均为数字后才报告成功。",
      "不要用 wps_set_header_footer 反复覆盖双域页脚。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        sectionIndex: { type: "integer", minimum: 1, default: 1 },
        kind: { type: "string", enum: ["primary", "firstPage", "evenPages"], default: "primary" },
        expectedFingerprint: { type: "string" },
        expectedText: { type: "string", description: "地图返回的当前页脚 text；必须完全匹配。" },
        alignment: { type: "string", enum: ["left", "center", "right"], default: "center" },
        prefix: { type: "string", default: "第 " },
        middle: { type: "string", default: " 页/共 " },
        suffix: { type: "string", default: " 页" }
      },
      required: ["sectionIndex", "kind", "expectedFingerprint", "expectedText", "alignment"]
    },
    handler: async (args) => await api.setPagePair(args)
  });
})(window);
