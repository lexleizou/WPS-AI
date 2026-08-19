(function attachMindmap(global) {
  "use strict";

  // 把 markdown 大纲（# / ## / ### / - 缩进列表）解析成 echarts tree 数据，用于「文档脑图」可视化。
  // 纯函数，可 Node 单测。

  function cleanInline(s) {
    return String(s == null ? "" : s)
      .replace(/`+/g, "")
      .replace(/[*_~]/g, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // markdown 大纲 → { name, children } 树。
  // 标题深度 = # 个数；列表项深度 = 最近标题深度 + 1 + 缩进层级（每 2 空格一层）。
  function outlineToTree(md, opts) {
    const rootName = (opts && opts.rootName) || "脑图";
    const root = { name: rootName, children: [] };
    const stack = [{ depth: 0, node: root }];
    let lastHeadingDepth = 0;
    const lines = String(md == null ? "" : md).split(/\r?\n/);
    for (const raw of lines) {
      const indentStr = (raw.match(/^[ \t]*/) || [""])[0].replace(/\t/g, "  ");
      const line = raw.trim();
      if (!line) continue;
      let depth = 0;
      let name = "";
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        depth = h[1].length;
        name = h[2];
        lastHeadingDepth = depth;
      } else {
        const b = line.match(/^[-*+]\s+(.+)$/);
        if (!b) continue; // 非标题/列表行忽略（比如模型偶尔混进的说明句）
        depth = lastHeadingDepth + 1 + Math.floor(indentStr.length / 2);
        name = b[1];
      }
      name = cleanInline(name);
      if (!name) continue;
      // 回退到父层：栈顶深度 >= 当前深度都弹出
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const node = { name, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
    }
    // 若只有一个顶层节点，用它当根（更像一张以文档标题为中心的脑图）
    return root.children.length === 1 ? root.children[0] : root;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
    ));
  }

  // { name, children } → markmap INode { content, children }。content 是 HTML（转义后当纯文本）。
  function toMarkmapData(node) {
    const n = node || {};
    return {
      content: escHtml(n.name || ""),
      children: (Array.isArray(n.children) ? n.children : []).map(toMarkmapData)
    };
  }

  // 便捷：markdown 大纲 → markmap INode。
  function outlineToMarkmap(md, opts) {
    return toMarkmapData(outlineToTree(md, opts));
  }

  global.WpsAiMindmap = { outlineToTree, toMarkmapData, outlineToMarkmap, cleanInline };
})(window);
