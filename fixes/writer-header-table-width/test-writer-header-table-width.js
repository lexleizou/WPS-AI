#!/usr/bin/env node
"use strict";
const assert = require("assert"), fs = require("fs"), vm = require("vm"), path = require("path");
function collection(items) { return { Count: items.length, Item(index) { return items[index - 1]; } }; }
function table(widths) { return { AllowAutoFit: true, PreferredWidthType: 0, PreferredWidth: widths.reduce((a, b) => a + b, 0), Columns: collection(widths.map((Width) => ({ Width }))), Rows: { Count: 3 } }; }
(async () => {
  const body = table([120, 180]), headerTable = table([9999999, 0, 0]);
  const header = { Range: { Tables: collection([headerTable]) } };
  const doc = { Tables: collection([body]), Sections: collection([{ Headers: collection([header, { Range: { Tables: collection([]) } }, { Range: { Tables: collection([]) } }]) }]) };
  const context = { window: null, console, Number, String, Object, Error, Promise, RegExp };
  context.window = context; context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc }; } };
  context.WpsAiToolRegistry = { registerTool() {} };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, "writer-header-table-width-host.js"), "utf8"), context);
  const api = context.WpsAiWriterHeaderTableWidth, read = await api.getHeaderTableMetrics({});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(read.header.columnWidths)), [9999999, 0, 0]);
  const before = JSON.stringify(headerTable);
  await assert.rejects(() => api.alignHeaderTableWidth({ expectedBodyMetrics: read.body }), /WRITE_PAUSED/);
  assert.equal(JSON.stringify(headerTable), before, "paused width writer must leave every table property unchanged");
  console.log(JSON.stringify({ ok: true, tests: 4 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
