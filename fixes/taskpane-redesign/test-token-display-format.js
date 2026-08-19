"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const match = source.match(/function formatTokens\(value\) \{[\s\S]*?\n  \}/);
assert.ok(match, "formatTokens must exist");
const sandbox = {};
vm.runInNewContext(`${match[0]}\nthis.formatTokens = formatTokens;`, sandbox);
assert.strictEqual(sandbox.formatTokens(999), "999");
assert.strictEqual(sandbox.formatTokens(77005), "77k");
assert.strictEqual(sandbox.formatTokens(128000), "128k");
assert.strictEqual(sandbox.formatTokens(1048576), "1M");
assert.strictEqual(sandbox.formatTokens(1500000), "1.5M");
console.log("PASS token display format");
