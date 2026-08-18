const assert = require("assert"), fs = require("fs"), vm = require("vm"), path = require("path");
function collection(items) { return { Count: items.length, Item(index) { return items[index - 1]; } }; }
function cell(start, text) { return { Range: { Start: start, End: start + 2, Text: text, InlineShapes: { Count: text.includes("\u0001") ? 1 : 0 } }, HorizontalMerge: 0, VerticalMerge: 0 }; }
function healthyTable() {
  const logo = cell(10, "\u0001\r\x07"), r1right = cell(20, "桓科\r\x07"), r2right = cell(30, "数据中心URS\r\x07"), file = cell(40, "文件编号：URS-20260517\r\x07"), version = cell(50, "版本号：v21\r\x07");
  const map = [[logo, r1right, r1right], [logo, r2right, r2right], [logo, file, version]];
  return { Columns: collection([{},{},{}]), Rows: collection([{},{},{}]), Cell(row, column) { return map[row - 1][column - 1]; } };
}
function header(table, linked) { return { LinkToPrevious: !!linked, Range: { Tables: collection([table]), Text: "桓科 数据中心URS 文件编号：URS-20260517" } }; }
(async () => {
  const table = healthyTable(), owner = header(table, false), linked = header(table, true), blank = header(healthyTable(), false);
  const doc = { Sections: collection([{ Headers: collection([owner, blank, blank]) }, { Headers: collection([linked, blank, blank]) }]) };
  const context = { window: null, console, Number, String, Object, Error, Promise, Set, Array };
  context.window = context; context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc }; } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, "writer-header-table-grid-host.js"), "utf8"), context);
  const api = context.WpsAiHeaderTableGrid;
  const profile = await api.recoveryProfile({ sectionIndex: 1, headerKind: "primary", tableIndex: 1 });
  assert.equal(profile.structure.expectedThreeByThreeShape, true); assert.equal(profile.structure.logoInFirstCell, true); assert.equal(profile.ownerSectionIndex, 1); assert.equal(profile.isLinkedToPrevious, false);
  const before = JSON.stringify(table);
  await assert.rejects(() => api.normalize({ sectionIndex: 1, headerKind: "primary", tableIndex: 1, row: 1, expectedRecoveryProfileFingerprint: profile.fingerprint, expectedHeaderText: ["错误文件"] }), /IDENTITY_MISMATCH/);
  assert.equal(JSON.stringify(table), before, "identity failure must be zero-write");
  const linkedProfile = await api.recoveryProfile({ sectionIndex: 2, headerKind: "primary", tableIndex: 1 });
  assert.equal(linkedProfile.ownerSectionIndex, 1); assert.equal(linkedProfile.isLinkedToPrevious, true);
  await assert.rejects(() => api.normalize({ sectionIndex: 2, headerKind: "primary", tableIndex: 1, row: 1, expectedRecoveryProfileFingerprint: linkedProfile.fingerprint, expectedHeaderText: ["数据中心"] }), /LINKED_HEADER_WRITE_REQUIRES_OWNER/);
  console.log(JSON.stringify({ ok: true, tests: 8 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
