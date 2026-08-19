"use strict";

const assert = require("assert");
const {
  createReferenceState,
  normalizeReference,
  buildReferenceContext,
  referenceFingerprint,
} = require("./lingxi-agent-references.js");

const history = normalizeReference({ kind: "history", text: "  quoted conclusion  ", label: "对话片段" }, { maxCharsPerItem: 12000 });
assert.equal(history.kind, "history");
assert.equal(history.text, "quoted conclusion");
assert.equal(history.label, "对话片段");
assert.ok(referenceFingerprint(history));

const state = createReferenceState({ maxItems: 2, maxCharsPerItem: 12, maxContextChars: 100 });
assert.equal(state.add({ kind: "history", text: "quoted conclusion", label: "对话片段" }).added, true);
assert.equal(state.list()[0].text, "quoted concl");
assert.equal(state.add({ kind: "history", text: "quoted conclusion", label: "对话片段" }).reason, "duplicate");
assert.equal(state.add({ kind: "document", text: "document body", label: "URS.docx" }).added, true);
assert.equal(state.add({ kind: "history", text: "third", label: "对话片段" }).reason, "limit");
assert.match(state.buildContext(), /^\[Agent 引用：对话片段\]\nquoted concl/m);
assert.match(state.buildContext(), /^\[@文档：URS\.docx\]\ndocument bod/m);

const consumed = state.consume();
assert.equal(consumed.length, 2);
assert.equal(state.list().length, 0);
assert.equal(state.consume().length, 0);
assert.match(buildReferenceContext(consumed, { maxContextChars: 30 }), /Agent 引用/);
assert.ok(buildReferenceContext(consumed, { maxContextChars: 30 }).length <= 30);

console.log("PASS agent reference state");
const selRef = normalizeReference({ kind: "selection", label: "§95–§100 选区", text: "选中内容" });
assert.equal(selRef.kind, "selection");
const selCtx = buildReferenceContext([{ kind: "selection", label: "§95–§100 选区", text: "选中内容" }]);
assert(selCtx.includes("[Word 选区：§95–§100 选区]"), "selection heading missing");
console.log("PASS selection reference kind");
