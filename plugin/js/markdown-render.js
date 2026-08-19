(function attachMarkdownRender(global) {
  "use strict";

  // 复用 WpsAiMarkdownToWord 的 tokenizer，输出 HTML 字符串。
  // 所有写入 HTML 的文本内容必须经过 escape，防止 XSS。
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderRun(run) {
    let html = escapeHtml(run.text);
    if (run.code) html = `<code>${html}</code>`;
    if (run.bold && run.italic) html = `<strong><em>${html}</em></strong>`;
    else if (run.bold) html = `<strong>${html}</strong>`;
    else if (run.italic) html = `<em>${html}</em>`;
    return html;
  }

  function renderInline(text) {
    if (text == null) return "";
    const tokenize = global.WpsAiMarkdownToWord?.tokenizeInline;
    if (!tokenize) return escapeHtml(String(text));
    return tokenize(String(text)).map(renderRun).join("");
  }

  function renderToHtml(md) {
    if (!md) return "";
    const tokenize = global.WpsAiMarkdownToWord?.tokenizeBlocks;
    if (!tokenize) return escapeHtml(md).replace(/\n/g, "<br/>");

    const blocks = tokenize(md);
    const out = [];
    let listMode = null; // "ul" | "ol" | null

    const closeList = () => {
      if (listMode === "ul") out.push("</ul>");
      else if (listMode === "ol") out.push("</ol>");
      listMode = null;
    };

    for (const block of blocks) {
      if (block.type !== "ul" && listMode === "ul") closeList();
      if (block.type !== "ol" && listMode === "ol") closeList();

      switch (block.type) {
        case "heading":
          out.push(`<h${block.level}>${renderInline(block.text)}</h${block.level}>`);
          break;
        case "ul":
          if (listMode !== "ul") { out.push("<ul>"); listMode = "ul"; }
          out.push(`<li>${renderInline(block.text)}</li>`);
          break;
        case "ol":
          if (listMode !== "ol") { out.push("<ol>"); listMode = "ol"; }
          out.push(`<li>${renderInline(block.text)}</li>`);
          break;
        case "code":
          out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
          break;
        case "quote":
          out.push(`<blockquote>${renderInline(block.text)}</blockquote>`);
          break;
        case "hr":
          out.push("<hr/>");
          break;
        case "table": {
          const headers = block.headers || [];
          const rows = block.rows || [];
          const head = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
          const body = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
          out.push(`<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
          break;
        }
        case "paragraph":
        default:
          out.push(`<p>${renderInline(block.text)}</p>`);
      }
    }
    closeList();
    return out.join("");
  }

  global.WpsAiMarkdown = { renderToHtml, escapeHtml };
})(window);
