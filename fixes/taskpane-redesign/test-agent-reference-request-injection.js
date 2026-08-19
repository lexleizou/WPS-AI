"use strict";

const assert = require("assert");
const fs = require("fs");

const js = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const start = js.indexOf("  function contentIncludesAgentReferencePrompt");
const end = js.indexOf("  function clearPendingAgentReferences", start);
assert(start >= 0 && end > start, "agent reference request helpers missing");
const helpers = new Function(`${js.slice(start, end)}\nreturn { contentIncludesAgentReferencePrompt, requestHasManualUserMessage, injectAgentReferenceIntoRequest };`)();

const original = {
  model: "test-model",
  messages: [
    { role: "system", content: "primary system" },
    { role: "user", content: "发送前已被门禁改写的请求" }
  ]
};
const injected = helpers.injectAgentReferenceIntoRequest(original, "[Agent 引用：对话片段]\n关键事实");
assert.notStrictEqual(injected, original, "must return a scoped request copy");
assert.strictEqual(original.messages[1].content, "发送前已被门禁改写的请求", "must not mutate visible/history source message");
assert.strictEqual(injected.messages.filter((message) => message.role === "system").length, 1, "must not add a second system message");
assert(injected.messages[1].content.includes("关键事实"), "reference context missing from outgoing user message");
assert(injected.messages[1].content.includes("发送前已被门禁改写的请求"), "user prompt missing after injection");
assert(helpers.requestHasManualUserMessage(injected), "manual user message detection failed");

const attachmentRequest = {
  messages: [{ role: "user", content: [
    { type: "text", text: "分析附件" },
    { type: "file", file: { file_id: "file-1" } }
  ] }]
};
const attachmentInjected = helpers.injectAgentReferenceIntoRequest(attachmentRequest, "引用正文");
assert.strictEqual(attachmentInjected.messages[0].content[0].type, "text");
assert(attachmentInjected.messages[0].content[0].text.includes("引用正文"), "attachment request reference prefix missing");
assert.strictEqual(attachmentInjected.messages[0].content[2].file.file_id, "file-1", "attachment content must be preserved");

assert(js.includes("recentManualSendFallback"), "transformed-prompt fallback missing");
assert(js.includes("(now - pending.armedAt) <= 30000"), "manual-send fallback window missing");
assert(js.includes("已送入模型"), "verifiable injection notice missing");
assert(js.includes("模型请求未成功，引用已保留"), "failed-request retention notice missing");
assert(!js.includes("referenceSystemMessage"), "legacy second-system injection still present");

console.log("PASS agent reference request injection and provider-safe user merge");
