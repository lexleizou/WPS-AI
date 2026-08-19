"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function collection(items) {
  return { get Count() { return items.length; }, Item(index) { return items[index - 1] || null; } };
}
function textRange(initial, rowsDelete) {
  let raw = initial;
  return {
    get Text() { return raw; },
    set Text(value) { raw = String(value).replace(/\n/g, "\v") + "\r\x07"; },
    Start: 10, End: 20,
    Rows: rowsDelete ? { Delete: rowsDelete } : null
  };
}

const definitions = new Map();
const registry = { registerTool(definition) { definitions.set(definition.name, definition); } };
let rowCount = 17;
const deleteCells = [1, 2, 3].map((column) => ({ RowIndex: 4, Range: textRange(`r4c${column}\r\x07`, column === 1 ? () => { rowCount -= 1; } : null) }));
const deleteTable = {
  Rows: { get Count() { return rowCount; }, Item() { return null; }, Add() { rowCount += 1; } },
  Columns: { Count: 3, Add() {} },
  Cell(row, column) { if (row === 4) return deleteCells[column - 1]; return { RowIndex: row, Range: textRange(`r${row}c${column}\r\x07`) }; },
  Range: { Cells: collection(deleteCells) }
};
const deleteDocument = { Tables: collection([deleteTable]), Revisions: { Count: 0 }, Range() { return { Rows: null }; } };
const app = { ActiveDocument: deleteDocument, Undo() { throw new Error("undo must not run on verified deletion"); } };
const window = { WpsAiToolRegistry: registry, WpsAiAddon: { async getApplication() { return app; } }, addEventListener() {} };
window.window = window;
vm.runInNewContext(fs.readFileSync(`${__dirname}/writer-table-safe.js`, "utf8"), { window, console, Promise, Set, Math, Number, String, Array, Object, JSON, Error });

(async () => {
  assert(definitions.has("wps_delete_table_row") && definitions.has("wps_write_table_range"), "safe tools not registered");
  const deleted = await definitions.get("wps_delete_table_row").handler({ tableIndex: 1, rowIndex: 4 });
  assert.equal(deleted.strategy, "cell-range-rows", "must fall back when Rows.Item is unavailable");
  assert.equal(deleted.beforeRows, 17);
  assert.equal(deleted.remainingRows, 16);
  assert.equal(deleted.verification.ok, true);

  const first = { Range: textRange("旧内容\r第二段\r\x07") };
  const unchanged = { Range: textRange("保持\r两段\r\x07") };
  const writeTable = {
    Rows: { Count: 2, Add() {} }, Columns: { Count: 1, Add() {} },
    Cell(row) { return row === 1 ? first : unchanged; }
  };
  app.ActiveDocument = { Tables: collection([writeTable]), Revisions: { Count: 0 } };
  const written = await definitions.get("wps_write_table_range").handler({ tableIndex: 1, values: [["新内容\n第二段"], ["保持\n两段"]] });
  assert.equal(written.writtenCells, 1);
  assert.equal(written.skippedCells, 1, "normalized-identical cell must not be rewritten");
  assert.equal(written.paragraphBreakCells, 1, "generic LF must preserve paragraph semantics");
  assert.equal(written.softBreakCells, 0);
  assert(first.Range.Text.includes("\r") && !first.Range.Text.includes("\v"), "paragraph break was converted to soft break");
  assert(unchanged.Range.Text.includes("\r"), "unchanged cell structure was not preserved");

  const helper = window.WpsAiWriterTableSafeTools._internal;
  assert.equal(helper.prepareCellWriteText("a\nb", "x\vy\r\x07", "preserve"), "a\vb");
  assert.equal(helper.prepareCellWriteText("a\nb", "x\r\x07", "paragraph"), "a\rb");
  assert.equal(helper.prepareCellWriteText("a\nb", "x\r\x07", "soft"), "a\vb");
  console.log("PASS safe table row deletion fallback and line-break preservation");
})().catch((error) => { console.error(error); process.exit(1); });
