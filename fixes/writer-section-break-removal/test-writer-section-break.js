"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function collection(items) { return { get Count() { return items.length; }, Item(index) { return items[index - 1]; } }; }
let sectionCount = 3;
let deleted = false;
const sections = {
  get Count() { return sectionCount; },
  Item(index) {
    const ranges = [{ Start: 0, End: 50 }, { Start: 50, End: 100 }, { Start: 100, End: 170 }];
    return { Range: ranges[index - 1] };
  }
};
const doc = {
  Sections: sections,
  Paragraphs: collection([
    { Range: { Start: 0, End: 49 } },
    { Range: { Start: 49, End: 51 } },
    { Range: { Start: 51, End: 99 } },
    { Range: { Start: 99, End: 101 } },
    { Range: { Start: 101, End: 170 } }
  ]),
  Range(start, end) {
    return {
      Start: start, End: end,
      get Text() { return start === 99 && end === 100 ? "\f" : ""; },
      Delete() { if (start === 99 && end === 100) { deleted = true; sectionCount = 2; } }
    };
  }
};
const context = { window: null, Promise, Number, String, Object, Array, Math, Set, Error };
context.window = context;
context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc }; } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.env.HOST, "utf8"), context);

(async () => {
  const api = context.WpsAiSectionBreak;
  const before = await api.inspectSectionBoundaries();
  assert.equal(before.sections, 3);
  assert.equal(before.boundaries[1].endingSectionIndex, 2);
  assert.equal(before.boundaries[1].boundaryParagraph, 4);
  await assert.rejects(() => api.removeSectionBreak({ endingSectionIndex: 2, expectedSectionCount: 4 }), /节数已变化/);
  await assert.rejects(() => api.removeSectionBreak({ endingSectionIndex: 2, expectedSectionCount: 3, expectedBoundaryParagraph: 3 }), /边界段落不匹配/);
  const result = await api.removeSectionBreak({ endingSectionIndex: 2, expectedSectionCount: 3, expectedBoundaryParagraph: 4 });
  assert.equal(deleted, true);
  assert.equal(result.sectionsAfter, 2);
  assert.equal(result.verification.ok, true);
  console.log("PASS writer section break removal");
})().catch((error) => { console.error(error); process.exit(1); });
