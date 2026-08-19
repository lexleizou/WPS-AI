"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const match = source.match(/const CHAT_PARAGRAPH_ANCHOR[\s\S]*?\n  function extractParagraphAnchors\(text\) \{[\s\S]*?\n  \}/);
assert.ok(match, "chat anchor parser must exist");
const sandbox = {};
vm.runInNewContext(match[0].replace("const CHAT_PARAGRAPH_ANCHOR", "var CHAT_PARAGRAPH_ANCHOR") + "\nthis.extractParagraphAnchors = extractParagraphAnchors;", sandbox);
const parse = sandbox.extractParagraphAnchors;
assert.deepStrictEqual(Array.from(parse("见 §343 与 §842–§846，以及 §343")), ["§343", "§842", "§846"]);
assert.deepStrictEqual(Array.from(parse("§0、§01、普通正文")), []);
assert.deepStrictEqual(Array.from(parse("§7")), ["§7"]);
assert.ok(source.includes("ScrollIntoView"), "anchor navigation must use view scrolling");
assert.ok(/function revealChatAnchor[\s\S]*?range\.Select\?\.\(\)/.test(source), "anchor navigation must select the referenced document text");
console.log("PASS chat anchor navigation");
assert.deepStrictEqual(Array.from(parse("表格见 T1 与 T12，§5")), ["T1", "T12", "§5"]);
assert.deepStrictEqual(Array.from(parse("T0、T01、AT3、正文")), []);
assert.ok(/document\?\.Tables \|\| document\?\.Content\?\.Tables/.test(source), "table anchors must resolve via document.Tables");
assert.ok(/表格 \$\{text\}/.test(source), "missing-table error must mention the table anchor");
console.log("PASS chat table anchor navigation");
