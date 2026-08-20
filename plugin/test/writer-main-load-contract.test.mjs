import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function run(file, context) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

test("main.js writer registration order allows the format-guard replacement", () => {
  const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const registryIndex = mainSource.indexOf('"js/tools/registry.js"');
  const writerIndex = mainSource.indexOf('"js/tools/writer.js"');
  const guardIndex = mainSource.indexOf('"js/tools/writer-format-guard.js"');
  assert.ok(registryIndex >= 0 && registryIndex < writerIndex && writerIndex < guardIndex, "main.js 必须先 registry，再基础 writer，最后 format guard 覆盖");

  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, Map, Set, Date, JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error });
  context.window = context;
  context.globalThis = context;
  context.WpsAiHostWriter = {};
  run("js/tools/registry.js", context);
  run("js/tools/writer.js", context);
  assert.equal(context.WpsAiToolRegistry.getDefinition("wps_format_paragraph").origin, "legacy");
  context.WpsAiWriterFormatGuard = { auditParagraphFormat: async () => ({}), applyParagraphFormatMismatches: async () => ({}) };
  assert.doesNotThrow(() => run("js/tools/writer-format-guard.js", context));
  const wrapped = context.WpsAiToolRegistry.getDefinition("wps_format_paragraph");
  assert.equal(wrapped.origin, "writer-format-guard");
  assert.equal(wrapped.replaces, "legacy");
});
