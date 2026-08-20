import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "../js/lingxi-graphite-taskpane.js"), "utf8");
const start = source.indexOf("function installMacPasteIsolation()");
const end = source.indexOf("function initServiceConfigurationSurface()", start);
const body = source.slice(start, end);

test("clipboard isolation focuses the native task pane and never undoes the document", () => {
  assert.ok(start >= 0 && end > start);
  assert.match(body, /getCurrentTaskPane/);
  assert.match(body, /lingxiSafePasteBtn/);
  assert.match(body, /WpsAiClipboard\?\.pasteInto/);
  assert.doesNotMatch(body, /\.Undo\s*\(/);
  assert.doesNotMatch(body, /revertDuplicatedDocumentPaste/);
});
