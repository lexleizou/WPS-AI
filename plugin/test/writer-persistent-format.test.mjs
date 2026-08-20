import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIife } from "./helpers/load-iife.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const writerFile = path.resolve(here, "../js/hosts/writer.js");

function makeFormat(initial = {}) {
  const state = { ...initial };
  const format = {};
  for (const key of Object.keys(state)) {
    Object.defineProperty(format, key, {
      get: () => state[key],
      set: (value) => { state[key] = Number(value); },
      enumerable: true,
      configurable: true
    });
  }
  return { format, state };
}

test("selection paragraph formatting writes Paragraph.Format instead of transient Range.ParagraphFormat", async () => {
  const persistent = makeFormat({ CharacterUnitLeftIndent: 0, CharacterUnitFirstLineIndent: -1.74, LeftIndent: 20.85, FirstLineIndent: -20.85 });
  const transient = makeFormat({ CharacterUnitLeftIndent: 0, CharacterUnitFirstLineIndent: -1.74, LeftIndent: 20.85, FirstLineIndent: -20.85 });
  const paragraph = { Format: persistent.format, Range: { ParagraphFormat: transient.format } };
  const paragraphs = { Count: 1, Item: () => paragraph };
  const selectionRange = { Start: 10, End: 20, Paragraphs: paragraphs };
  const app = { ActiveDocument: { FullName: "/tmp/a.docx" }, Selection: { Range: selectionRange, Paragraphs: paragraphs, ParagraphFormat: transient.format } };
  const context = loadIife(writerFile, { Application: app });
  const result = await context.WpsAiHostWriter.formatParagraph({ leftIndent: 14.15, firstLineIndent: 0 });
  assert.equal(result.applied, true);
  assert.equal(result.affectedParagraphs, 1);
  assert.equal(persistent.state.LeftIndent, 14.15);
  assert.equal(persistent.state.FirstLineIndent, 0);
  assert.equal(persistent.state.CharacterUnitFirstLineIndent, 0);
  assert.equal(transient.state.LeftIndent, 20.85);
});

test("style formatting reassigns a ParagraphFormat clone so WPS can persist it", async () => {
  const persisted = { CharacterUnitLeftIndent: 0, CharacterUnitFirstLineIndent: -1.74, LeftIndent: 20.85, FirstLineIndent: -20.85 };
  const style = { NameLocal: "目录 2", Font: {} };
  Object.defineProperty(style, "ParagraphFormat", {
    get: () => ({ ...persisted }),
    set: (format) => { for (const key of Object.keys(persisted)) persisted[key] = Number(format[key]); },
    configurable: true
  });
  const document = { FullName: "/tmp/a.docx", Styles: { Item: () => style } };
  const context = loadIife(writerFile, { Application: { ActiveDocument: document } });
  const result = await context.WpsAiHostWriter.modifyStyle({
    name: "目录 2",
    paragraph: { leftIndent: 14.15, firstLineIndent: 0 }
  });
  assert.equal(result.applied, true);
  assert.equal(persisted.LeftIndent, 14.15);
  assert.equal(persisted.FirstLineIndent, 0);
  assert.equal(persisted.CharacterUnitFirstLineIndent, 0);
});
