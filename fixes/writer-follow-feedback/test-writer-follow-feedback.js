#!/usr/bin/env node
"use strict";
const assert = require("assert"), fs = require("fs"), vm = require("vm"), path = require("path");
const source = fs.readFileSync(path.join(__dirname, "writer-follow-feedback.js"), "utf8");
let start = 0;
const paragraphs = ["one", "two", "three"].map((text) => { const range = { Start: start, End: start + text.length + 1 }; start = range.End; return { Range: range }; });
const calls = { setRange: [], scroll: [], select: 0, after: 0, execute: [] };
const selection = { SetRange(start, end) { calls.setRange.push([start, end]); } };
const document = { Paragraphs: { Item(index) { return paragraphs[index - 1]; } }, Range(start, end) { return { Start: start, End: end, Select() { calls.select += 1; } }; } };
const application = { ActiveDocument: document, Selection: selection, ActiveWindow: { ScrollIntoView(range) { calls.scroll.push([range.Start, range.End]); } } };
const context = { window: null, console, RegExp, String, Number, Object, Promise, Error, setTimeout, WpsAiAddon: { getApplicationSync() { return application; } }, WpsAiHistory: { isMutatingTool(name) { return name === "wps_apply_paragraph_format_mismatches"; } } };
context.window = context;
context.WpsAiFollow = { afterMutatingTool() { calls.after += 1; } };
context.WpsAiToolRegistry = { async execute(name) { calls.execute.push(name); return { ok: true }; } };
vm.createContext(context); vm.runInContext(source, context, { filename: "writer-follow-feedback.js" });
(async () => {
  context.WpsAiFollow.afterMutatingTool("wps", "wps_apply_paragraph_format_mismatches", {}, { followTarget: { kind: "paragraphRange", startAnchor: "§2", endAnchor: "§3" } });
  assert.strictEqual(calls.after, 1, "preserves base follow behavior");
  assert.deepStrictEqual(calls.scroll, [[4, 14]], "successful write scrolls to changed anchor range");
  assert.strictEqual(calls.select, 1, "successful write has transient native selection highlight");
  await context.WpsAiToolRegistry.execute("wps_apply_paragraph_format_mismatches", {});
  assert.deepStrictEqual(calls.setRange, [[14, 14]], "next write clears highlight to a collapsed insertion point");
  await context.WpsAiToolRegistry.execute("wps_get_document_map", {});
  assert.deepStrictEqual(calls.setRange, [[14, 14]], "read-only scan does not change document view/selection");
  context.WpsAiProviderRegistry = { loadSettings() { return { aiFollowHighlight: false }; } };
  context.WpsAiFollow.afterMutatingTool("wps", "wps_apply_paragraph_format_mismatches", {}, { followTarget: { kind: "paragraphRange", startAnchor: "§2", endAnchor: "§3" } });
  assert.strictEqual(calls.select, 1, "disabled follow setting suppresses extra navigation/highlight");
  console.log(JSON.stringify({ ok: true, tests: 6 }, null, 2));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
