"use strict";

const assert = require("assert");
const fs = require("fs");

const js = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");

const bridge = js.match(/function installAgentReferenceSendBridge\(\) \{[\s\S]*?\n  \}/);
assert.ok(bridge, "send bridge missing");
assert.ok(bridge[0].includes('addEventListener("click", armAgentReferencesForManualSend, true)'), "click arming missing");
assert.ok(bridge[0].includes('document.addEventListener("keydown"'), "Enter-to-send arming missing (document capture)");
assert.ok(bridge[0].includes('ev.key !== "Enter"'), "Enter filter missing");
assert.ok(bridge[0].includes("ev.isComposing"), "IME composition guard missing");
assert.ok(bridge[0].includes("chatInput"), "must only arm for chat input Enter");
assert.ok(js.includes("client.runWithTools = async (request) =>"), "runWithTools request bridge missing");

console.log("PASS agent reference Enter-to-send arming");
