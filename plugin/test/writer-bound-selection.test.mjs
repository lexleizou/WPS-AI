import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadTools({ activeDocument, boundDocument, selection }) {
  const app = { ActiveDocument: activeDocument, Selection: selection };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, Map, Set, Date, JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error });
  context.window = context;
  context.globalThis = context;
  context.WpsAiDocument = { getApplication: async () => app };
  context.WpsAiDocumentMutation = { getBoundDocument: () => boundDocument };
  context.WpsAiHistory = { pathsEqual: (a, b) => a === b };
  context.WpsAiHostWriter = {};
  for (const file of ["js/tools/registry.js", "js/tools/writer.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
}

test("a real Selection tool refuses to modify a newly active document", async () => {
  const documentA = { FullName: "/tmp/a.docx" };
  const documentB = { FullName: "/tmp/b.docx" };
  let styleWrites = 0;
  const selection = {};
  Object.defineProperty(selection, "Style", { set: () => { styleWrites += 1; } });
  const context = loadTools({ activeDocument: documentB, boundDocument: documentA, selection });
  const handler = context.WpsAiToolRegistry.getDefinition("wps_apply_paragraph_style").handler;
  await assert.rejects(() => handler({ style: "Normal" }), /DOCUMENT_NOT_ACTIVE_FOR_SELECTION/);
  assert.equal(styleWrites, 0);
});

test("a Selection tool still works while the bound document remains active", async () => {
  const documentA = { FullName: "/tmp/a.docx" };
  let styleWrites = 0;
  const selection = {};
  Object.defineProperty(selection, "Style", { set: () => { styleWrites += 1; } });
  const context = loadTools({ activeDocument: documentA, boundDocument: documentA, selection });
  const handler = context.WpsAiToolRegistry.getDefinition("wps_apply_paragraph_style").handler;
  const result = await handler({ style: "Normal" });
  assert.equal(result.style, "Normal");
  assert.equal(styleWrites, 1);
});
