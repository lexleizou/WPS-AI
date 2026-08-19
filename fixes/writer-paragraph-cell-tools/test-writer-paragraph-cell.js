"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function makeDoc() {
  // 段落：1=正文，2-4=空段，5=表内空段，6=含分页符
  const texts = ["正文\r", "\r", "\r", "\r", "\r\u0007", "\f\r"];
  const deleted = [];
  const paras = texts.map((text, idx) => ({
    Range: {
      Text: text,
      Tables: idx === 4 ? { Count: 1 } : { Count: 0 },
      InlineShapes: { Count: 0 },
      Shapes: { Count: 0 },
      Delete() { deleted.push(idx + 1); }
    }
  }));
  const doc = {
    Paragraphs: { get Count() { return paras.length - deleted.length; }, Item(i) { return paras[i - 1]; } },
    Sections: { Count: 1, Item: () => ({ Headers: { Item: () => ({ Range: headerRange }) } }) }
  };
  // 页眉：表1 cell(1,1) = 图片 + 「桓科生物」
  const cellText = "\u0001桓科生物\r\u0007";
  const cellRange = {
    Start: 10,
    Text: cellText,
    InlineShapes: { Count: 1 },
    Shapes: { Count: 0 }
  };
  const headerRange = { Tables: { Count: 1, Item: () => ({ Cell: (r, c) => (r === 1 && c === 1 ? { Range: cellRange } : null) }) } };
  doc.Range = (s, e) => ({
    Start: s, End: e,
    Text: cellText.slice(s - 10, e - 10),
    Delete() { cellRange.Text = cellText.slice(0, s - 10) + cellText.slice(e - 10); }
  });
  return { doc, deleted, cellRange };
}

const { doc, deleted, cellRange } = makeDoc();
const context = { window: null, Promise, Number, String, Object, Array, Math, Error, JSON };
context.window = context;
context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc }; } };
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
  // A1: 成功路径，自后向前
  const res = await api.deleteEmptyParagraphs({ startParagraph: 2, endParagraph: 4, expectedParagraphCount: 6 });
  assert.deepEqual(deleted, [4, 3, 2]);
  assert.equal(res.deleted, 3);
  // A3: 页眉 cell 文字清理
  const cleared = await api.clearHeaderCellText({ sectionIndex: 1, tableIndex: 1, row: 1, column: 1, expectedText: "桓科生物" });
  assert.equal(cleared.imagesPreserved, 1);
  assert(!cellRange.Text.includes("桓科生物"));
  assert(cellRange.Text.includes("\u0001"), "图片字符必须保留");
  // A3: 文字不存在时拒绝
  await assert.rejects(() => api.clearHeaderCellText({ expectedText: "桓科生物" }), /恰好 1 次|出现 0 次/);
  console.log("PASS writer paragraph & header-cell tools");
})().catch((error) => { console.error(error); process.exit(1); });
