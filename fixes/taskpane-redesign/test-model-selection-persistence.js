"use strict";

const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const appSource = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/plugin-wps/js/app.js`, "utf8");
const migration = source.match(/function migrateCodexToOfficialDirect\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
assert.ok(migration, "Codex direct migration must exist");
assert.ok(migration.includes("if (!codex.enabled)"), "migration may ensure Codex stays available");
assert.ok(!migration.includes("activeChatModel"), "migration must not overwrite the previously selected model");
assert.ok(!migration.includes("encodeActiveChatModel"), "migration must not select a provider default model");
assert.ok(appSource.includes("if (!pickedItem && curPid && curMid)"), "taskpane must restore activeChatModel when it is available");
console.log("PASS model selection persistence");
