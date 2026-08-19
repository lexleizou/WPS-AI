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
assert.ok(!/function revealChatAnchor[\s\S]{0,160}\.Select\?\./.test(source), "anchor navigation must not select document text");
console.log("PASS chat anchor navigation");
