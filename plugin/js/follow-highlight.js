// WpsAiFollow：AI 操作跟随提示。
//
// 修改型工具执行成功后，把改动位置在宿主里可视化出来：
//   - Word：滚动视图到当前选区（写入型工具都通过 Selection 落笔，写完选区就停在改动处）。
//     刻意**不**重新框选写入区域——Selection 是后续写入的落点，重新选中会让下一次
//     insert 变成 replace（writeBlocks 对非折叠选区走删除替换），破坏 AI 连续写入。
//   - Excel：从工具结果/入参解析目标区域（writtenRange / range），激活工作表 +
//     Select + Application.Goto 滚动到可见——单元格选框就是天然的高亮。
//   - PPT/PDF 暂不处理（幻灯片写入自身会切换当前页；PDF 只读）。
//
// 完全非破坏性：只动选区和视口，不写入任何格式。设置「AI 操作跟随提示」可关（默认开）。
(function attachFollowHighlight(global) {
  "use strict";

  function enabled() {
    try {
      return global.WpsAiProviderRegistry?.loadSettings?.().aiFollowHighlight !== false;
    } catch (e) { return true; }
  }

  function app() {
    try { return global.WpsAiAddon?.getApplicationSync?.() || global.wps?.Application || null; } catch (e) { return null; }
  }

  // Word：滚动到当前选区（不改选区本身）
  function followWps() {
    try {
      const a = app();
      if (!a) return;
      const sel = a.Selection;
      if (!sel) return;
      const range = typeof sel.Range === "function" ? sel.Range() : sel.Range;
      if (!range) return;
      const win = a.ActiveWindow;
      if (win && typeof win.ScrollIntoView === "function") win.ScrollIntoView(range, true);
    } catch (e) { /* 跟随失败不影响主流程 */ }
  }

  // Excel：解析目标区域地址 → 激活工作表 → 选中 + 滚动
  function followEt(args, value) {
    try {
      const a = app();
      if (!a) return;
      const wb = a.ActiveWorkbook;
      if (!wb) return;
      const v = value && typeof value === "object" ? value : {};
      const g = args && typeof args === "object" ? args : {};
      const sheetName = String(v.sheet || g.sheet || "").trim();
      let sheet = null;
      if (sheetName) {
        try { sheet = wb.Worksheets.Item(sheetName); } catch (e) {}
      }
      if (!sheet) { try { sheet = a.ActiveSheet; } catch (e) {} }
      if (!sheet) return;
      const addr = String(v.writtenRange || v.range || v.address || g.range || "").trim();
      if (!addr) return;
      try { sheet.Activate(); } catch (e) {}
      let r = null;
      try { r = sheet.Range(addr); } catch (e) { return; }
      try { r.Select(); } catch (e) {}
      // Goto(Scroll=true)：保证目标区域滚进可视范围（Select 不一定滚动）
      try { if (typeof a.Goto === "function") a.Goto(r, true); } catch (e) {}
    } catch (e) { /* 跟随失败不影响主流程 */ }
  }

  // tools/registry.execute 在修改型工具成功后调用
  function afterMutatingTool(host, name, args, value) {
    if (!enabled()) return;
    if (host === "et") followEt(args, value);
    else if (host === "wps") followWps();
  }

  // 显式定位（reveal_location 工具）：外部/内部 AI 主动"让用户看这里"——定位 + 滚动 + 高亮。
  // 与 afterMutatingTool 不同，这里可以大胆选中（非写入流程，不会影响后续 insert 落点）。
  // 返回 { revealed, location } 或抛错。
  function revealLocation(host, params = {}) {
    const a = app();
    if (!a) throw new Error("宿主应用不可用。");
    if (host === "wps") {
      const findText = String(params.findText || "").trim();
      if (!findText) throw new Error("Word 文字文档请提供 findText（要定位的原文片段）。");
      const sel = a.Selection;
      if (!sel) throw new Error("未获取到选区。");
      let find = null;
      try { find = sel.Find; } catch (e) {}
      if (!find || typeof find.Execute !== "function") throw new Error("当前宿主不支持文本查找。");
      try { find.ClearFormatting?.(); } catch (e) {}
      find.Text = findText;
      find.Forward = true;
      try { find.Wrap = 1; } catch (e) {} // wdFindContinue
      const hit = find.Execute();
      if (!hit) throw new Error(`未在文档中找到「${findText.slice(0, 20)}」。`);
      // Execute 成功后 Selection 即匹配区域（已选中高亮），再滚进可视范围
      try {
        const range = typeof sel.Range === "function" ? sel.Range() : sel.Range;
        a.ActiveWindow?.ScrollIntoView?.(range, true);
      } catch (e) {}
      return { revealed: true, location: `文本「${findText.slice(0, 30)}」` };
    }
    if (host === "et") {
      const addr = String(params.range || params.address || "").trim();
      if (!addr) throw new Error("Excel 表格请提供 range（单元格区域，如 A1:C3）。");
      const wb = a.ActiveWorkbook;
      if (!wb) throw new Error("没有活动工作簿。");
      const sheetName = String(params.sheet || "").trim();
      let sheet = null;
      if (sheetName) { try { sheet = wb.Worksheets.Item(sheetName); } catch (e) {} }
      if (!sheet) { try { sheet = a.ActiveSheet; } catch (e) {} }
      if (!sheet) throw new Error("没有活动工作表。");
      try { sheet.Activate(); } catch (e) {}
      let r = null;
      try { r = sheet.Range(addr); } catch (e) { throw new Error(`区域「${addr}」无效。`); }
      try { r.Select(); } catch (e) {}
      try { if (typeof a.Goto === "function") a.Goto(r, true); } catch (e) {}
      return { revealed: true, location: `${sheet.Name || ""}!${addr}` };
    }
    if (host === "wpp") {
      const n = Number(params.slide) | 0;
      if (!(n >= 1)) throw new Error("PPT 演示请提供 slide（幻灯片序号，1 起）。");
      const view = a.ActiveWindow?.View;
      if (view && typeof view.GotoSlide === "function") {
        view.GotoSlide(n);
      } else {
        // 兜底：设 View.Slide
        try {
          const slide = a.ActivePresentation?.Slides?.Item?.(n);
          if (slide && view) view.Slide = slide;
          else throw new Error("无法跳转幻灯片。");
        } catch (e) { throw new Error("当前宿主不支持幻灯片跳转。"); }
      }
      return { revealed: true, location: `第 ${n} 页` };
    }
    throw new Error("当前宿主不支持定位（仅 Word / Excel / PPT）。");
  }

  global.WpsAiFollow = { afterMutatingTool, revealLocation };
})(window);
