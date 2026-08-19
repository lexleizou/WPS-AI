#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const hostSource = fs.readFileSync(path.join(root, "writer-format-guard-host.js"), "utf8");
const toolsSource = fs.readFileSync(path.join(root, "writer-format-guard-tools.js"), "utf8");
function collection(items) { return { Count: items.length, Item(index) { return items[index - 1]; } }; }
function paragraph(text, start, opts = {}) {
  const font = Object.assign({ Name: "宋体", NameFarEast: "宋体", NameAscii: "宋体", NameOther: "宋体", Size: 10.5 }, opts.font || {});
  const fmt = Object.assign({ Alignment: 0, LineSpacing: 18, LineSpacingRule: 1, SpaceBefore: 0, SpaceAfter: 0, FirstLineIndent: 0, LeftIndent: 0, RightIndent: 0 }, opts.format || {});
  const range = { Text: text + "\r", Start: start, End: start + text.length + 1, Font: font, ParagraphFormat: fmt, Information(code) { return code === 12 ? !!opts.inTable : false; } };
  return { Range: range };
}
function documentFixture() {
  let start = 0;
  const defs = [
    ["符合要求", {}],
    ["仅行距错误", { format: { LineSpacing: 12, LineSpacingRule: 0 } }],
    ["字体和行距错误", { font: { Name: "Arial", NameFarEast: "Arial", NameAscii: "Arial", NameOther: "Arial" }, format: { LineSpacing: 12, LineSpacingRule: 0 } }],
    ["表格中符合", { inTable: true }],
    ["表格中错误", { inTable: true, format: { LineSpacing: 12, LineSpacingRule: 0 } }]
  ];
  const items = defs.map(([text, opts]) => { const p = paragraph(text, start, opts); start = p.Range.End; return p; });
  const paras = collection(items);
  return { Name: "格式测试.docx", Paragraphs: paras, Content: { Text: items.map((p) => p.Range.Text).join(""), Paragraphs: paras }, Tables: { Count: 1 }, Sections: { Count: 1 } };
}
async function main() {
  const document = documentFixture();
  const registered = new Map();
  let legacyCalls = 0;
  const context = { console, Map, Set, Object, Array, String, Number, Math, JSON, Promise, Error, RegExp, Date, window: null };
  context.window = context;
  context.WpsAiAddon = { async getApplication() { return { ActiveDocument: document }; } };
  context.WpsAiToolRegistry = {
    registerTool(def) { registered.set(def.name, def); },
    getDefinition(name) { return registered.get(name) || null; }
  };
  registered.set("wps_format_paragraph", { name: "wps_format_paragraph", hosts: ["wps"], description: "legacy", handler: async () => { legacyCalls += 1; return { ok: true }; } });
  vm.createContext(context);
  vm.runInContext(hostSource, context, { filename: "writer-format-guard-host.js" });
  const guard = context.WpsAiWriterFormatGuard;
  assert(guard, "guard missing");
  const audit = await guard.auditParagraphFormat({ requirements: { fontName: "宋体", lineSpacingRule: "oneAndHalf", lineSpacing: 18 }, includeTables: true });
  assert.strictEqual(audit.checkedCount, 5);
  assert.strictEqual(audit.matchedCount, 2);
  assert.strictEqual(audit.mismatchCount, 3);
  assert.strictEqual(audit.mismatchGroups.length, 3);
  assert.strictEqual(document.Paragraphs.Item(2).Range.ParagraphFormat.LineSpacingRule, 0, "audit must not mutate");
  const skippedTables = await guard.auditParagraphFormat({ requirements: { lineSpacingRule: "oneAndHalf" }, includeTables: false });
  assert.strictEqual(skippedTables.checkedCount, 3);
  assert.strictEqual(skippedTables.skippedCount, 2);
  const applied = await guard.applyParagraphFormatMismatches({ auditId: audit.auditId, expectedDocumentFingerprint: audit.documentFingerprint });
  assert.strictEqual(applied.changedParagraphs, 3);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(applied.followTarget)), { kind: "paragraphRange", startAnchor: "§2", endAnchor: "§5", anchors: ["§2", "§3", "§5"] }, "only successful writes expose a follow target");
  assert.strictEqual(document.Paragraphs.Item(2).Range.Font.Name, "宋体", "font must remain untouched when only spacing differs");
  assert.strictEqual(document.Paragraphs.Item(2).Range.ParagraphFormat.LineSpacingRule, 1);
  assert.strictEqual(document.Paragraphs.Item(3).Range.Font.NameFarEast, "宋体");
  assert.strictEqual(document.Paragraphs.Item(5).Range.ParagraphFormat.LineSpacing, 18);
  const verified = await guard.auditParagraphFormat({ requirements: { fontName: "宋体", lineSpacingRule: "oneAndHalf", lineSpacing: 18 } });
  assert.strictEqual(verified.mismatchCount, 0);
  const identityAudit = await guard.auditParagraphFormat({ requirements: { lineSpacingRule: "oneAndHalf" } });
  document.Paragraphs.Item(2).Range.Text = "同长度内容xx\r"; // 非采样段同长度内容变化，必须由逐段 identity 阻止写入
  await assert.rejects(() => guard.applyParagraphFormatMismatches({ auditId: identityAudit.auditId, expectedDocumentFingerprint: identityAudit.documentFingerprint }), /STALE_FORMAT_AUDIT/);
  document.Paragraphs.Item(2).Range.Text = "仅行距错误\r";
  await assert.rejects(() => guard.applyParagraphFormatMismatches({ auditId: "missing", expectedDocumentFingerprint: verified.documentFingerprint }), /FORMAT_AUDIT_NOT_FOUND/);
  const stale = await guard.auditParagraphFormat({ requirements: { lineSpacingRule: "oneAndHalf" } });
  await assert.rejects(() => guard.applyParagraphFormatMismatches({ auditId: stale.auditId, expectedDocumentFingerprint: "wrong" }), /STALE_FORMAT_AUDIT/);
  vm.runInContext(toolsSource, context, { filename: "writer-format-guard-tools.js" });
  assert(registered.has("wps_audit_paragraph_format"));
  assert(registered.has("wps_apply_paragraph_format_mismatches"));
  assert(/^wps_audit_/.test("wps_audit_paragraph_format"));
  const wrapped = registered.get("wps_format_paragraph");
  await assert.rejects(() => wrapped.handler({ scope: "document" }), /BULK_FORMAT_BLOCKED/);
  await wrapped.handler({ scope: "selection" });
  assert.strictEqual(legacyCalls, 1);
  console.log(JSON.stringify({ ok: true, tests: 20, auditMismatches: audit.mismatchCount, changed: applied.changedParagraphs, tools: [...registered.keys()] }, null, 2));
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
