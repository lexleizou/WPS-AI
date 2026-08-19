"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function makeDoc(texts) {
  // 段落：1=正文，2-4=空段，5=表内空段，6=含分页符
  texts = texts || ["正文\r", "\r", "\r", "\r", "\r\u0007", "\f\r"];
  const deleted = [];
  const selection = {
    index: -1,
    Delete() { deleted.push(this.index + 1); }
  };
  const paras = texts.map((text, idx) => ({
    Range: {
      Text: text,
      Tables: idx === 4 ? { Count: 1 } : { Count: 0 },
      InlineShapes: { Count: 0 },
      Shapes: { Count: 0 },
      Select() { selection.index = idx; },
      Delete() { throw new Error("Range.Delete silently unsupported in this stub"); }
    }
  }));
  // 页眉：表1 cell(1,1) = 图片 \u0001 + 「桓科生物」
  const store = { text: "\u0001桓科生物\r\u0007" };
  const cellRange = {
    InlineShapes: { Count: 1 },
    Shapes: { Count: 0 },
    get Text() { return store.matched != null ? store.matched : store.text; },
    Find: {
      Text: "",
      ClearFormatting() {},
      Execute() {
        const i = store.text.indexOf(this.Text);
        if (i < 0) return false;
        store.matched = this.Text;
        return true;
      }
    },
    Delete() {
      store.text = store.text.replace(store.matched, "");
      store.matched = null;
    }
  };
  const table = { Cell: (r, c) => (r === 1 && c === 1 ? { Range: cellRange } : null) };
  const headerRange = { Tables: { Count: 1, Item: () => table } };
  const doc = {
    Paragraphs: { get Count() { return paras.length - deleted.length; }, Item(i) { return paras[i - 1]; } },
    Sections: { Count: 1, Item: () => ({ Headers: { Item: () => ({ Range: headerRange }) } }) }
  };
  return { doc, selection, deleted, store };
}

const { doc, selection, deleted, store } = makeDoc();
const context = { window: null, Promise, Number, String, Object, Array, Math, Error, JSON };
context.window = context;
context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc, Selection: selection }; } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.env.HOST, "utf8"), context);

(async () => {
  const api = context.WpsAiParagraphCellTools;
  // A1: 预检拒绝
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 99 }), /段落总数已变化/);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 1, endParagraph: 2, expectedParagraphCount: 6 }), /不是空段落/);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 5, endParagraph: 5, expectedParagraphCount: 6 }), /表格/);
  await assert.rejects(() => api.deleteEmptyParagraphs({ startParagraph: 6, endParagraph: 6, expectedParagraphCount: 6 }), /分页\/分节/);
  assert.equal(deleted.length, 0, "预检失败时不得删除任何段落");
  // A1: 成功路径，自后向前，走 Selection.Delete 通路
  const res = await api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6 });
  assert.deepEqual(deleted, [4, 3, 2]);
  assert.equal(res.deleted, 3);
  assert.equal(res.verification.ok, true);
  // A3: Find 定位 + 删除，图片保留
  const cleared = await api.clearHeaderCellText({ sectionIndex: 1, tableIndex: 1, row: 1, column: 1, expectedText: "桓科生物" });
  assert.equal(cleared.imagesPreserved, 1);
  assert(!store.text.includes("桓科生物"));
  assert(store.text.includes("\u0001"), "图片字符必须保留");
  // A3: 文字不存在时拒绝
  await assert.rejects(() => api.clearHeaderCellText({ expectedText: "桓科生物" }), /出现 0 次/);
  console.log("PASS writer paragraph & header-cell tools v2");
})().catch((error) => { console.error(error); process.exit(1); });

// v3: 修订模式——段落总数不变但删除修订数增加时，应判定为 tracked 成功
(async () => {
  const { doc: doc2, selection: sel2, deleted: del2 } = makeDoc(["正文\r", "\r", "\r", "\r", "后续内容\r", "末段\r"]);
  doc2.TrackRevisions = true;
  const revs = { count: 0, get Count() { return this.count; }, Item() { return { Type: 1 }; } };
  doc2.Revisions = revs;
  const origDelete = sel2.Delete.bind(sel2);
  sel2.Delete = function () { origDelete(); revs.count += 1; };
  const ctx2 = { window: null, Promise, Number, String, Object, Array, Math, Error, JSON };
  ctx2.window = ctx2;
  ctx2.WpsAiAddon = { async getApplication() {
    // 修订模式下 Count 不随删除变化
    const p = doc2.Paragraphs; Object.defineProperty(p, "Count", { get: () => 6 });
    return { ActiveDocument: doc2, Selection: sel2 };
  } };
  vm.createContext(ctx2);
  vm.runInContext(fs.readFileSync(process.env.HOST, "utf8"), ctx2);
  const api2 = ctx2.WpsAiParagraphCellTools;
  const tracked = await api2.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6 });
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.verification.mode, "tracked");
  assert.equal(del2.length, 3);
  console.log("PASS tracked-revision deletion path");
})().catch((error) => { console.error(error); process.exit(1); });
