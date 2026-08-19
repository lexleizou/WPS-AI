"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const match = source.match(/const STRICT_READ_ONLY_REQUEST[\s\S]*?\n  function isExplicitReadOnlyRequest\(input\) \{[\s\S]*?\n  \}/);
assert.ok(match, "strict read-only intent function must exist");
const sandbox = {};
vm.runInNewContext(match[0].replace("const STRICT_READ_ONLY_REQUEST", "var STRICT_READ_ONLY_REQUEST") + "\nthis.isExplicitReadOnlyRequest = isExplicitReadOnlyRequest;", sandbox);
const detect = sandbox.isExplicitReadOnlyRequest;
assert.equal(detect("检查正文中没有必要的空行，留白。总结后告诉我，先不要改"), true);
assert.equal(detect("只检查，不要修改文档"), true);
assert.equal(detect("仅总结发现的问题"), true);
assert.equal(detect("检查后修改所有多余空行"), false);
assert.equal(detect("确认按预览修改"), false);
assert.ok(source.includes("STRICT_READ_ONLY_REQUIRED"), "strict tool error must exist");
assert.ok(source.includes("wps_find_replace"), "tool gate test must name find/replace coverage");
console.log("PASS strict read-only tool gate");
assert(source.includes("request.tools.filter"), "strict read-only turn must remove write tools from the advertised tool list");
assert(source.includes("isMutatingTool?.(toolName)"), "tool filter must use the mutating-tool classifier");
assert(source.includes("重试必然失败"), "blocked error must explicitly forbid retries");
assert(/keydown[\s\S]{0,300}armStrictReadOnlyGate/.test(source), "gate must also arm on Enter-to-send");
console.log("PASS strict read-only tool filtering and Enter arming");
