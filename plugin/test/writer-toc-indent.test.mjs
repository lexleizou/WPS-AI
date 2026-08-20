import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIife } from "./helpers/load-iife.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardFile = path.resolve(here, "../js/hosts/writer-format-guard.js");

test("format guard preserves character-unit indentation requirements", () => {
  const context = loadIife(guardFile);
  const normalized = context.WpsAiWriterFormatGuard._internal.normalizeRequirements({
    leftIndent: 14.15,
    firstLineIndent: 0
  });
  assert.equal(normalized.leftIndent, 14.15);
  assert.equal(normalized.firstLineIndent, 0);
  assert.equal(normalized.characterUnitLeftIndent, 0);
  assert.equal(normalized.characterUnitFirstLineIndent, 0);
});

test("full format audit and apply verifies the paragraph object after all writes", async () => {
  const state = {
    CharacterUnitLeftIndent: 0,
    CharacterUnitFirstLineIndent: -1.74,
    LeftIndent: 20.85,
    FirstLineIndent: -20.85,
    Alignment: 0,
    LineSpacing: 12,
    LineSpacingRule: 0,
    SpaceBefore: 0,
    SpaceAfter: 0,
    CharacterUnitRightIndent: 0,
    RightIndent: 0
  };
  const paragraphFormat = {};
  for (const key of Object.keys(state)) {
    Object.defineProperty(paragraphFormat, key, {
      get: () => state[key],
      set: (value) => { state[key] = Number(value); },
      configurable: true
    });
  }
  const range = {
    Start: 0,
    End: 8,
    Text: "目录条目\r",
    Font: { Name: "宋体", NameFarEast: "宋体", NameAscii: "宋体", NameOther: "宋体", Size: 10.5 },
    // Simulate the transient Range.ParagraphFormat clone that WPS discards on save.
    ParagraphFormat: { ...state }
  };
  const paragraph = { Range: range, Format: paragraphFormat };
  const paragraphs = { Count: 1, Item: () => paragraph };
  const document = {
    Name: "toc.docx",
    Content: { Text: range.Text, Paragraphs: paragraphs },
    Paragraphs: paragraphs,
    Tables: { Count: 0 },
    Sections: { Count: 1 }
  };
  const context = loadIife(guardFile, { Application: { ActiveDocument: document } });
  const guard = context.WpsAiWriterFormatGuard;
  const audit = await guard.auditParagraphFormat({ requirements: { leftIndent: 14.15, firstLineIndent: 0 } });
  assert.equal(audit.mismatchCount, 1);
  const result = await guard.applyParagraphFormatMismatches({
    auditId: audit.auditId,
    expectedDocumentFingerprint: audit.documentFingerprint
  });
  assert.equal(result.partialFailure, false);
  assert.equal(result.failedParagraphs.length, 0);
  assert.equal(state.CharacterUnitFirstLineIndent, 0);
  assert.equal(state.LeftIndent, 14.15);
  assert.equal(state.FirstLineIndent, 0);
});

test("format guard clears character units before writing point indents and reads back", () => {
  const state = {
    CharacterUnitLeftIndent: 0,
    CharacterUnitFirstLineIndent: -1.74,
    LeftIndent: 20.85,
    FirstLineIndent: -20.85
  };
  const paragraphFormat = {};
  for (const key of Object.keys(state)) {
    Object.defineProperty(paragraphFormat, key, {
      get: () => state[key],
      set: (value) => {
        // Simulate WPS: point indents are ignored while a character-unit hanging indent remains.
        if ((key === "LeftIndent" || key === "FirstLineIndent") && state.CharacterUnitFirstLineIndent !== 0) return;
        state[key] = Number(value);
      },
      configurable: true
    });
  }
  const context = loadIife(guardFile);
  const applyDiff = context.WpsAiWriterFormatGuard._internal.applyDiff;
  const snapshot = { range: { Font: {}, ParagraphFormat: paragraphFormat } };
  const requirements = {
    characterUnitLeftIndent: 0,
    characterUnitFirstLineIndent: 0,
    leftIndent: 14.15,
    firstLineIndent: 0
  };
  const diff = Object.fromEntries(Object.keys(requirements).map((key) => [key, true]));
  const result = applyDiff(snapshot, requirements, diff);
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(state.CharacterUnitFirstLineIndent, 0);
  assert.equal(state.LeftIndent, 14.15);
  assert.equal(state.FirstLineIndent, 0);
});
