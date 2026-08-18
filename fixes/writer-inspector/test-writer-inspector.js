#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const hostSource = fs.readFileSync(path.join(root, "writer-inspector-host.js"), "utf8");
const toolsSource = fs.readFileSync(path.join(root, "writer-inspector-tools.js"), "utf8");

function collection(items) {
  return {
    Count: items.length,
    Item(index) { return items[index - 1]; }
  };
}

function makeParagraph(text, style, start, overrides = {}) {
  const raw = text + "\r";
  const font = Object.assign({
    Name: "Arial", NameFarEast: "宋体", NameAscii: "Arial", NameOther: "Arial",
    Size: 12, Bold: 0, Italic: 0, Underline: 0, UnderlineColor: 0,
    Color: 0, ColorIndex: 1, StrikeThrough: 0, DoubleStrikeThrough: 0,
    Subscript: 0, Superscript: 0, SmallCaps: 0, AllCaps: 0, Hidden: 0,
    Spacing: 0, Scaling: 100, Position: 0, Kerning: 0
  }, overrides.font || {});
  const paragraphFormat = Object.assign({
    Alignment: 0, LineSpacing: 12, LineSpacingRule: 0, SpaceBefore: 0, SpaceAfter: 0,
    FirstLineIndent: 0, LeftIndent: 0, RightIndent: 0,
    CharacterUnitLeftIndent: 0, CharacterUnitFirstLineIndent: 0,
    CharacterUnitRightIndent: 0, KeepWithNext: 0, KeepTogether: 0,
    PageBreakBefore: 0, WidowControl: -1
  }, overrides.paragraph || {});
  const listFormat = Object.assign({ ListType: 0, ListLevelNumber: 0, ListValue: 0, ListString: "" }, overrides.list || {});
  const range = {
    Text: raw,
    Start: start,
    End: start + raw.length,
    Font: font,
    ParagraphFormat: paragraphFormat,
    ListFormat: listFormat,
    Information(code) { return code === 12 ? !!overrides.inTable : false; }
  };
  return { Style: { NameLocal: style }, Range: range };
}

function makeDocument() {
  let cursor = 0;
  const defs = [
    ["1 总则", "Heading 1", {}],
    ["本文规定系统用户需求。", "Normal", {}],
    ["缩写定义：URS = User Requirement Specification。", "Normal", {}],
    ["表格内容", "Normal", { inTable: true, font: { Bold: 9999999 } }],
    ["结束语", "Normal", {}]
  ];
  const paragraphs = defs.map(([text, style, overrides]) => {
    const p = makeParagraph(text, style, cursor, overrides);
    cursor = p.Range.End;
    return p;
  });
  const paras = collection(paragraphs);
  const tableRange = { Start: paragraphs[3].Range.Start, End: paragraphs[3].Range.End };
  const table = {
    Range: tableRange,
    Rows: { Count: 1 },
    Columns: { Count: 1 },
    Cell() { return { Range: { Text: "表格内容\x07" } }; }
  };
  const section = { Range: { Start: 0, End: cursor } };
  return {
    Name: "测试URS.docx",
    Paragraphs: paras,
    Content: { Text: paragraphs.map((p) => p.Range.Text).join(""), Paragraphs: paras },
    Tables: collection([table]),
    Sections: collection([section]),
    InlineShapes: { Count: 1 },
    Shapes: { Count: 0 }
  };
}

async function main() {
  const document = makeDocument();
  const registered = new Map();
  const context = {
    console,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    Promise,
    Error,
    RegExp,
    window: null
  };
  context.window = context;
  context.WpsAiAddon = { async getApplication() { return { ActiveDocument: document }; } };
  context.WpsAiHostWriter = {
    headingLevelFromStyle(style) {
      const match = /^(?:Heading|标题)\s*(\d)/i.exec(String(style || ""));
      return match ? Number(match[1]) : 0;
    },
    async readDocumentStructure() {
      return {
        segments: [
          { idx: 0, kind: "paragraph" },
          { idx: 1, kind: "paragraph" },
          { idx: 2, kind: "paragraph" },
          { idx: 3, kind: "table" },
          { idx: 4, kind: "paragraph" }
        ]
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(hostSource, context, { filename: "writer-inspector-host.js" });
  const inspector = context.WpsAiWriterInspector;
  assert(inspector, "宿主模块未导出");
  assert.strictEqual(inspector._internal.parseParagraphAnchor("§12"), 12);
  assert.throws(() => inspector._internal.parseParagraphAnchor("P12"), /无效段落锚点/);
  assert.strictEqual(inspector._internal.normalizeValue(9999999), "mixed");

  const map = await inspector.buildDocumentMap({ sampleInterval: 10, keywords: ["URS", "不存在"] });
  assert.strictEqual(map.version, 1);
  assert.strictEqual(map.document.paragraphs, 5);
  assert.strictEqual(map.headings[0].anchor, "§1");
  assert.strictEqual(map.headings[0].level, 1);
  assert.strictEqual(map.keywordLocations.URS[0].anchor, "§3");
  assert.strictEqual(map.tables[0].anchor, "T1");
  assert.strictEqual(map.sections[0].anchor, "S1");
  assert.strictEqual(typeof map.document.fingerprint, "string");

  const read = await inspector.readByAnchor({ startAnchor: "§2", endAnchor: "§4", expectedDocumentFingerprint: map.document.fingerprint });
  assert.strictEqual(read.fromAnchor, "§2");
  assert.strictEqual(read.toAnchor, "§4");
  assert(read.content.includes("[§3|Normal|paragraph]"));
  assert(read.content.includes("[§4|Normal|table]"));
  assert.strictEqual(read.blocks.length, 3);

  const around = await inspector.readByAnchor({ aroundKeyword: "缩写定义", contextBlocks: 1, maxParagraphs: 3 });
  assert.strictEqual(around.matchedKeyword.anchor, "§3");
  assert.strictEqual(around.fromAnchor, "§2");

  await assert.rejects(
    () => inspector.readByAnchor({ startAnchor: "§1", expectedDocumentFingerprint: "deadbeef" }),
    /STALE_DOCUMENT_MAP/
  );

  const format = await inspector.readParagraphFormat({ startAnchor: "§2", endAnchor: "§5", groupSimilar: false });
  assert.strictEqual(format.count, 4);
  const mixed = format.paragraphs.find((p) => p.anchor === "§4");
  assert.strictEqual(mixed.font.Bold, "mixed");
  assert.strictEqual(mixed.table.inTable, true);
  assert.strictEqual(mixed.table.tableIndex, 1);

  const grouped = await inspector.readParagraphFormat({ startAnchor: "§2", endAnchor: "§3", groupSimilar: true });
  assert.strictEqual(grouped.groups.length, 1);
  assert.strictEqual(grouped.groups[0].count, 2);
  assert.strictEqual(grouped.groups[0].startAnchor, "§2");
  assert.strictEqual(grouped.groups[0].endAnchor, "§3");

  context.WpsAiToolRegistry = {
    registerTool(def) {
      assert(!registered.has(def.name), `重复工具：${def.name}`);
      registered.set(def.name, def);
    }
  };
  vm.runInContext(toolsSource, context, { filename: "writer-inspector-tools.js" });
  const names = [...registered.keys()];
  assert.deepStrictEqual(names, ["wps_get_document_map", "wps_read_by_anchor", "wps_read_paragraph_format"]);
  for (const name of names) {
    assert(/(^|_)(get|list|read)_/.test(name), `${name} 未命中现有只读分类器`);
    assert.deepStrictEqual(Array.from(registered.get(name).hosts), ["wps"]);
  }
  assert.strictEqual(registered.get("wps_read_by_anchor").parameters.properties.maxParagraphs.maximum, 200);
  assert.strictEqual(registered.get("wps_read_paragraph_format").parameters.properties.maxParagraphs.default, 50);
  assert(/不改变当前选区、页面位置或阅读视图/.test(registered.get("wps_get_document_map").description));
  assert(/不会定位、滚动或改变当前选区/.test(registered.get("wps_read_by_anchor").description));
  assert(!/\.Select\s*\(|ScrollIntoView|SetRange/.test(hostSource), "inspector reads must not select, scroll, or move the document view");
  const toolMap = await registered.get("wps_get_document_map").handler({ keywords: ["URS"] });
  assert.strictEqual(toolMap.keywordLocations.URS[0].anchor, "§3");

  console.log(JSON.stringify({
    ok: true,
    tests: 26,
    tools: names,
    fingerprint: map.document.fingerprint,
    groups: grouped.groups.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
