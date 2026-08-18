#!/usr/bin/env node
"use strict";
const assert = require("assert"), fs = require("fs"), vm = require("vm"), path = require("path");
const root = __dirname, hostSource = fs.readFileSync(path.join(root, "writer-header-table-width-host.js"), "utf8"), toolsSource = fs.readFileSync(path.join(root, "writer-header-table-width-tools.js"), "utf8");
function collection(items) { return { Count: items.length, Item(index) { return items[index - 1]; } }; }
function table(widths, text) {
  const cols = widths.map((width) => ({ Width: width }));
  return { AllowAutoFit: true, PreferredWidthType: 0, PreferredWidth: widths.reduce((a,b) => a+b,0), Columns: collection(cols), Rows: { Count: 1 }, Range: { Text: text } };
}
(async () => {
  const body = table([120, 180], "正文保持不变"), target = table([50, 50], "页眉保持不变"), untouched = table([80], "另一个页眉表格");
  const header = { Range: { Tables: collection([target, untouched]) } };
  const doc = { Tables: collection([body]), Sections: collection([{ Headers: collection([header, { Range: { Tables: collection([]) } }, { Range: { Tables: collection([]) } }]) }]) };
  const registered = new Map(), context = { window: null, console, Number, String, Object, Error, Promise, RegExp };
  context.window = context; context.WpsAiAddon = { async getApplication() { return { ActiveDocument: doc }; } }; context.WpsAiToolRegistry = { registerTool(def) { registered.set(def.name, def); } };
  vm.createContext(context); vm.runInContext(hostSource, context); const api = context.WpsAiWriterHeaderTableWidth;
  const read = await api.getHeaderTableMetrics({});
  assert.strictEqual(read.body.columnsWidth, 300); assert.strictEqual(read.header.columnsWidth, 100); assert.strictEqual(target.AllowAutoFit, true, "reader must not mutate");
  await assert.rejects(() => api.getHeaderTableMetrics({ headerTableIndex: 3 }), /不存在/);
  const beforeBody = JSON.stringify(body), beforeUntouched = JSON.stringify(untouched);
  const aligned = await api.alignHeaderTableWidth({ expectedBodyMetrics: read.body });
  assert.strictEqual(target.AllowAutoFit, false); assert.strictEqual(target.PreferredWidthType, 3); assert.strictEqual(target.PreferredWidth, 300); assert.strictEqual(aligned.verification.ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(aligned.appliedColumnWidths)), [150, 150], "writes actual header column widths, not only PreferredWidth");
  assert.strictEqual(aligned.after.columnsWidth, 300, "verification uses actual rendered column total");
  assert.strictEqual(JSON.stringify(body), beforeBody, "must not mutate source body table"); assert.strictEqual(JSON.stringify(untouched), beforeUntouched, "must not mutate other header tables");
  body.Columns.Item(1).Width = 121;
  await assert.rejects(() => api.alignHeaderTableWidth({ expectedBodyMetrics: read.body }), /STALE_BODY_TABLE_METRICS/);
  vm.runInContext(toolsSource, context); assert(registered.has("wps_get_header_table_metrics")); assert(registered.has("wps_align_header_table_width"));
  console.log(JSON.stringify({ ok: true, tests: 12 }, null, 2));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
