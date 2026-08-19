// WpsAiLocalIntents：本地能力路由（P2-3，参考察元 wpsCapabilityCatalog）。
//
// 确定性短指令不过模型，本地正则解析直接执行——零 token、零延迟：
//   保存文档 / 跳到第 N 页 / 插入 N×M 表格 / 撤销 / 重做
//
// 原则：宁可漏不可错。全部整句锚定（^...$），介词变体白名单，
// 任何带附加要求的句子（"帮我保存一份总结…"）都不会命中，照走模型。
(function attachLocalIntents(global) {
  "use strict";

  // 匹配器：整句锚定。返回 { key, params } 或 null。
  const MATCHERS = [
    {
      key: "save",
      hosts: ["wps", "et", "wpp"],
      re: /^(?:保存|保存文档|保存当前文档|保存一下|save)$/i,
      parse: () => ({})
    },
    {
      key: "gotoPage",
      hosts: ["wps"],
      re: /^(?:跳|跳转|前往|去|翻)(?:到|至)?第\s*(\d{1,4})\s*页$/,
      parse: (m) => ({ page: Number(m[1]) })
    },
    {
      key: "insertTable",
      hosts: ["wps"],
      // 插入3x4表格 / 插入 3×4 的表格 / 插入3行4列表格 / 插入3行4列的表格
      re: /^插入\s*(\d{1,2})\s*(?:[xX×*]\s*(\d{1,2})|行\s*(\d{1,2})\s*列)\s*(?:的)?表格$/,
      parse: (m) => ({ rows: Number(m[1]), cols: Number(m[2] || m[3]) })
    },
    {
      key: "undo",
      hosts: ["wps", "et", "wpp"],
      re: /^(?:撤销|撤消|undo)$/i,
      parse: () => ({})
    },
    {
      key: "redo",
      hosts: ["wps", "et", "wpp"],
      re: /^(?:重做|恢复撤销|redo)$/i,
      parse: () => ({})
    }
  ];

  function match(text, host) {
    const s = String(text || "").trim().replace(/[。！!]+$/, ""); // 允许句尾标点
    if (!s || s.length > 24) return null; // 长句必然带额外语义，交给模型
    for (const m of MATCHERS) {
      if (host && m.hosts.indexOf(host) < 0) continue;
      const hit = m.re.exec(s);
      if (hit) {
        const params = m.parse(hit) || {};
        // 参数合法性兜底
        if (m.key === "gotoPage" && !(params.page >= 1)) return null;
        if (m.key === "insertTable" && !(params.rows >= 1 && params.cols >= 1 && params.rows <= 50 && params.cols <= 20)) return null;
        return { key: m.key, params };
      }
    }
    return null;
  }

  function app() {
    try { return global.WpsAiAddon?.getApplicationSync?.() || global.wps?.Application || null; } catch (e) { return null; }
  }

  const t = (s, p) => {
    try {
      const r = global.WpsAiI18n?.t?.(s, p);
      if (r != null) return r;
    } catch (e) {}
    // i18n 未加载时的本地插值兜底
    let out = String(s);
    if (p) for (const k in p) out = out.split("{" + k + "}").join(String(p[k]));
    return out;
  };

  // 执行器：COM 直达。失败抛错由调用方兜底展示。
  async function execute(intent) {
    const a = app();
    if (!a) throw new Error("宿主应用不可用。");
    const doc = a.ActiveDocument || a.ActiveWorkbook || a.ActivePresentation;
    switch (intent.key) {
      case "save": {
        if (!doc || typeof doc.Save !== "function") throw new Error("当前没有可保存的文档。");
        doc.Save();
        return { message: t("已保存文档。") };
      }
      case "gotoPage": {
        const sel = a.Selection;
        if (!sel || typeof sel.GoTo !== "function") throw new Error("当前宿主不支持页面跳转。");
        sel.GoTo(1, 1, intent.params.page); // wdGoToPage, wdGoToAbsolute
        return { message: t("已跳转到第 {n} 页。", { n: intent.params.page }) };
      }
      case "insertTable": {
        const sel = a.Selection;
        const tables = a.ActiveDocument?.Tables;
        if (!sel || !tables || typeof tables.Add !== "function") throw new Error("当前宿主不支持插入表格。");
        const range = typeof sel.Range === "function" ? sel.Range() : sel.Range;
        tables.Add(range, intent.params.rows, intent.params.cols);
        return { message: t("已插入 {r}×{c} 表格。", { r: intent.params.rows, c: intent.params.cols }) };
      }
      case "undo": {
        if (!doc || typeof doc.Undo !== "function") throw new Error("当前宿主不支持撤销。");
        doc.Undo();
        return { message: t("已撤销。") };
      }
      case "redo": {
        if (!doc || typeof doc.Redo !== "function") throw new Error("当前宿主不支持重做。");
        doc.Redo();
        return { message: t("已重做。") };
      }
      default:
        throw new Error("未知本地指令。");
    }
  }

  global.WpsAiLocalIntents = { match, execute, _matchers: MATCHERS };
})(window);
