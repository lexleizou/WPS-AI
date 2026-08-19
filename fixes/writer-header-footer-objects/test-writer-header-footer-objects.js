"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class Story {
  constructor(text) { this.tokens = text ? [{ kind: "text", text }] : []; this.alignment = 0; }
  fields() { return this.tokens.filter((token) => token.kind === "field").map((token) => token.field); }
  visible() { return this.tokens.map((token) => token.kind === "text" ? token.text : token.field.Result.Text).join("") + "\r"; }
}
function fieldCollection(story) {
  return {
    get Count() { return story.fields().length; }, Item(index) { return story.fields()[index - 1]; },
    Add(cursor, type, code) {
      const resolvedType = Number(type) === -1 || type == null ? (/NUMPAGES/i.test(code || "") ? 26 : 33) : Number(type);
      const field = { Type: resolvedType, Code: { Text: resolvedType === 26 ? "NUMPAGES" : "PAGE" }, Result: { Text: resolvedType === 26 ? "12" : "1", ParagraphFormat: { Alignment: story.alignment } }, Update() {} };
      story.tokens.splice(cursor.End, 0, { kind: "field", field });
      field.Result.End = cursor.End + 1;
      return field;
    }, Update() {}
  };
}
function makeRange(story, start = 0, end = null) {
  const range = {
    Start: start, End: end == null ? story.tokens.length + 1 : end,
    get Text() { return story.visible(); },
    set Text(value) {
      const actualEnd = Math.min(this.End, story.tokens.length);
      story.tokens.splice(this.Start, Math.max(0, actualEnd - this.Start), ...(String(value) ? [{ kind: "text", text: String(value) }] : []));
      this.End = this.Start + (String(value) ? 1 : 0);
    },
    get Duplicate() { return makeRange(story, this.Start, this.End); },
    get Fields() { return fieldCollection(story); },
    get Paragraphs() { return { Count: 1, Item() { return { Range: makeRange(story) }; } }; },
    get ParagraphFormat() { return { get Alignment() { return story.alignment; }, set Alignment(value) { story.alignment = value; } }; },
    Tables: { Count: 0 },
    InsertAfter(text) { if (text) { story.tokens.splice(this.End, 0, { kind: "text", text: String(text) }); this.End += 1; } },
    Collapse(where) { const position = where === 0 ? this.End : this.Start; this.Start = position; this.End = position; },
    SetRange(s, e) { this.Start = s; this.End = e; }
  };
  return range;
}
function collection(factory, count = 3) { return { Count: count, Item(index) { return factory(index); } }; }

const footerStory = new Story("第  页/共  页");
const blankStory = new Story("");
const makeHf = (story) => ({ Exists: true, LinkToPrevious: false, get Range() { return makeRange(story); }, Shapes: { Count: 0 } });
const section = { Footers: collection(() => makeHf(footerStory)), Headers: collection(() => makeHf(blankStory)) };
const document = { Sections: collection(() => section, 1), Fields: fieldCollection(footerStory), Repaginate() {} };
const definitions = new Map();
const window = {
  WpsAiAddon: { async getApplication() { return { ActiveDocument: document }; } },
  WpsAiToolRegistry: { registerTool(def) { definitions.set(def.name, def); } },
  WpsAiHostWriter: { async setHeaderFooter(args) { return { delegated: true, args }; } }
};
window.window = window;
const context = { window, console, Promise, Number, String, Object, Array, Math, Error, JSON, Set };
vm.runInNewContext(fs.readFileSync(`${__dirname}/writer-header-footer-objects-host.js`, "utf8"), context);
vm.runInNewContext(fs.readFileSync(`${__dirname}/writer-header-footer-objects-tools.js`, "utf8"), context);

(async () => {
  const map = await window.WpsAiHeaderFooterObjects.getMap();
  const target = map.items.find((item) => item.sectionIndex === 1 && item.container === "footer" && item.kind === "primary");
  assert(target && target.text === "第  页/共  页");
  const result = await definitions.get("wps_set_footer_page_number_pair").handler({ sectionIndex: 1, kind: "primary", expectedFingerprint: target.fingerprint, expectedText: "第  页/共  页", alignment: "center" });
  assert.equal(result.verification.ok, true);
  assert.equal(result.fields.page.type, 33);
  assert.equal(result.fields.numPages.type, 26, "NUMPAGES must use wdFieldNumPages=26");
  assert.equal(result.fields.page.result, "1");
  assert.equal(result.fields.numPages.result, "12");
  assert.equal(footerStory.alignment, 1);
  assert.deepEqual(footerStory.fields().map((field) => field.Type), [33, 26]);

  await assert.rejects(() => definitions.get("wps_set_header_footer").handler({ target: "footer", text: "第  页/共  页", pageNumber: true }), /USE_WPS_SET_FOOTER_PAGE_NUMBER_PAIR/);
  const ordinary = await definitions.get("wps_set_header_footer").handler({ target: "header", text: "普通页眉" });
  assert.equal(ordinary.delegated, true);
  console.log("PASS verified PAGE+NUMPAGES pair and legacy footer guard");
})().catch((error) => { console.error(error); process.exit(1); });
