"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function makeDoc(initialTexts, options = {}) {
  let texts = (initialTexts || ["正文\r", "\r", "\r", "\r", "后续内容\r", "末段\r"]).slice();
  const history = [];
  const revs = { count: 0, get Count() { return this.count; }, Item() { return { Type: 1 }; } };
  function bounds(index) {
    let start = 0;
    for (let i = 0; i < index; i += 1) start += texts[i].length;
    return { start, end: start + texts[index].length };
  }
  function paragraph(index) {
    const b = bounds(index);
    return { Range: { Text: texts[index], Start: b.start, End: b.end, Tables: { Count: texts[index].includes("\u0007") ? 1 : 0 }, InlineShapes: { Count: 0 }, Shapes: { Count: 0 } } };
  }
  const paragraphs = { get Count() { return texts.length; }, Item(i) { return paragraph(i - 1); } };
  const documentRange = (start, end) => {
    let target = -1;
    for (let i = 0; i < texts.length; i += 1) { const b = bounds(i); if (b.end === end && b.end - 1 === start) { target = i; break; } }
    return {
      get Text() { return target >= 0 ? texts[target].slice(-1) : ""; },
      Delete() {
        if (target < 0) throw new Error("invalid mark range");
        history.push({ texts: texts.slice(), revs: revs.count });
        if (options.tracked) revs.count += 1;
        else texts.splice(target, options.overDelete ? 2 : 1);
      }
    };
  };

  const store = { text: "\u0001桓科生物\r\u0007" };
  const cellRange = {
    InlineShapes: { Count: 1 }, Shapes: { Count: 0 },
    get Text() { return store.matched != null ? store.matched : store.text; },
    Find: { Text: "", ClearFormatting() {}, Execute() { const i = store.text.indexOf(this.Text); if (i < 0) return false; store.matched = this.Text; return true; } },
    Delete() { store.text = store.text.replace(store.matched, ""); store.matched = null; }
  };
  const table = { Cell: (r, c) => (r === 1 && c === 1 ? { Range: cellRange } : null) };
  const headerRange = { Tables: { Count: 1, Item: () => table } };
  const doc = {
    Paragraphs: paragraphs, TrackRevisions: !!options.tracked, Revisions: revs,
    Range: documentRange,
    Sections: { Count: 1, Item: () => ({ Headers: { Item: () => ({ Range: headerRange }) } }) }
  };
  const app = {
    ActiveDocument: doc,
    Undo() { const state = history.pop(); if (!state) return; texts = state.texts; revs.count = state.revs; }
  };
  return { doc, app, store, texts: () => texts.slice() };
}
function load(bundle) {
  const context = { window: null, Promise, Number, String, Object, Array, Math, Error, JSON };
  context.window = context;
  context.WpsAiAddon = { async getApplication() { return bundle.app; } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(process.env.HOST, "utf8"), context);
  return context.WpsAiParagraphCellTools;
}

(async () => {
  const bundle = makeDoc();
  const api = load(bundle);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 99, expectedNextText: "后续内容" }), /段落总数已变化/);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 1, endParagraph: 2, expectedParagraphCount: 6, expectedNextText: "后续内容" }), /不是空段落/);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6, expectedNextText: "错误正文" }), /NEXT_PARAGRAPH_MISMATCH/);
  assert.equal(bundle.doc.Paragraphs.Count, 6, "预检失败不得修改文档");

  const result = await api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6, expectedPreviousText: "正文", expectedNextText: "后续内容" });
  assert.equal(result.deleted, 3);
  assert.equal(result.physicalDeleted, 3);
  assert.equal(bundle.doc.Paragraphs.Count, 3);
  assert.equal(bundle.doc.Paragraphs.Item(2).Range.Text, "后续内容\r");
  assert.equal(result.verification.ok, true);

  const cleared = await api.clearHeaderCellText({ sectionIndex: 1, tableIndex: 1, row: 1, column: 1, expectedText: "桓科生物" });
  assert.equal(cleared.imagesPreserved, 1);
  assert(!bundle.store.text.includes("桓科生物"));
  assert(bundle.store.text.includes("\u0001"));
  console.log("PASS bounded paragraph-mark deletion and header-cell preservation");

  const over = makeDoc(["目录末项\r", "\r", "正文标题一\r", "正文\r"], { overDelete: true });
  const overApi = load(over);
  await assert.rejects(() => overApi.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 2, expectedParagraphCount: 4, expectedPreviousText: "目录末项", expectedNextText: "正文标题一" }), /自动撤销：成功恢复原段落总数/);
  assert.equal(over.doc.Paragraphs.Count, 4, "超量删除必须自动撤销");
  assert.equal(over.doc.Paragraphs.Item(3).Range.Text, "正文标题一\r", "受保护正文必须恢复");
  console.log("PASS over-delete rollback protection");

  const trackedBundle = makeDoc(undefined, { tracked: true });
  const trackedApi = load(trackedBundle);
  const tracked = await trackedApi.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6, expectedPreviousText: "正文", expectedNextText: "后续内容" });
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.trackedDeleted, 3);
  assert.equal(trackedBundle.doc.Paragraphs.Count, 6);
  assert.equal(tracked.verification.mode, "tracked-or-mixed");
  console.log("PASS tracked-revision paragraph-mark deletion");
})().catch((error) => { console.error(error); process.exit(1); });
