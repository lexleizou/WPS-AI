(function attachPdfTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;
  const pdf = () => global.WpsAiHostPdf;

  registry.registerTool({
    name: "pdf_get_info",
    hosts: ["pdf"],
    description: "查询当前 PDF 的基础信息（页数）。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pages = await pdf().pageCount();
      return { pages };
    }
  });

  registry.registerTool({
    name: "pdf_read_document",
    hosts: ["pdf"],
    description: "读取 PDF 纯文本，每页前带『【第 N 页】』标记。startPage/endPage 指定页码区间（1 起，闭区间，省略=全篇）；maxChars 限制总字符数。被 maxChars 截断时返回 truncated=true 与 nextPage，把 nextPage 作为下次的 startPage 即可续读完整篇。",
    parameters: {
      type: "object",
      properties: {
        startPage: { type: "number", description: "起始页码（1 起），也用作续读游标" },
        endPage: { type: "number", description: "结束页码（闭区间）" },
        maxPages: { type: "number", description: "兼容旧参数：从第 1 页起最多读 N 页（等价 startPage=1,endPage=N）" },
        maxChars: { type: "number", description: "总字符上限，默认无上限。长 PDF 建议 8000-15000" }
      }
    },
    handler: async ({ startPage, endPage, maxPages, maxChars } = {}) => {
      let sp = startPage;
      let ep = endPage;
      if (sp == null && ep == null && maxPages != null && maxPages > 0) { sp = 1; ep = maxPages; }
      const r = await pdf().readDocumentRange({ startPage: sp, endPage: ep, maxChars });
      return {
        text: r.text,
        length: r.text.length,
        pagesRead: { from: r.from, to: r.to },
        total: r.total,
        truncated: r.truncated,
        nextPage: r.nextPage
      };
    }
  });

  registry.registerTool({
    name: "pdf_read_page",
    hosts: ["pdf"],
    description: "读取 PDF 指定页码（1-based）的纯文本。",
    parameters: {
      type: "object",
      required: ["page"],
      properties: {
        page: { type: "number", description: "页码，从 1 开始" }
      }
    },
    handler: async ({ page }) => {
      const text = await pdf().readPage(page);
      return { page, text, length: text.length };
    }
  });
})(window);
