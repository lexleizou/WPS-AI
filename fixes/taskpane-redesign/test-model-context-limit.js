"use strict";

const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const contextBlock = source.match(/function installContextUsage\(ring\) \{[\s\S]*?\n  \}\n\n  function clampFloatingPopup/)?.[0] || "";
assert.ok(contextBlock, "context usage implementation must exist");
assert.ok(contextBlock.includes("resolveActiveModelContextLimit"), "context usage must resolve the active model's limit");
assert.ok(contextBlock.includes("/service/litellm/models"), "LiteLLM model metadata must be used");
assert.ok(contextBlock.includes("/models-catalog"), "catalog metadata must backfill other providers");
assert.ok(!contextBlock.includes("estimateLimit = 128000"), "context usage must not use a global 128K default");
assert.ok(contextBlock.includes("模型上下文上限未提供"), "unknown limits must be explicit rather than guessed");
console.log("PASS model context limit");
