"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const providerPath = `${process.env.HOME}/.lingxi-ai/plugin-wps/js/providers/openai.js`;
let source = fs.readFileSync(providerPath, "utf8");
source = source.replace("})(window);", "window.__buildToolContinuationPrompt = buildToolContinuationPrompt;\n})(window);");
const window = { WpsAiProviderRegistry: { register() {} } };
window.window = window;
vm.runInNewContext(source, { window, console, Set, Array, String, Object, JSON, Math, Number, Promise, URLSearchParams, DOMException });
const build = window.__buildToolContinuationPrompt;
assert.equal(typeof build, "function", "continuation prompt helper was not exposed to test");
const specs = (...names) => names.map((name) => ({ function: { name } }));

const writer = build(specs("get_host_info", "wps_read_document", "wps_write_table_range", "wps_insert_text", "wps_format_paragraph"));
assert(writer.includes("WPS 文字"));
assert(writer.includes("wps_write_table_range"));
assert(!writer.includes("et_write_range"), "Writer retry must not inject ET tools");

const writerReadOnly = build(specs("get_host_info", "wps_read_document", "wps_read_selection"));
assert(writerReadOnly.includes("WPS 文字"));
assert(writerReadOnly.includes("没有可用的写入工具"));
assert(!/et_|wpp_/.test(writerReadOnly));

const sheet = build(specs("get_host_info", "et_read_range", "et_write_range", "et_format_range", "et_autofit"));
assert(sheet.includes("WPS 表格"));
assert(sheet.includes("et_write_range"));
assert(!sheet.includes("wps_write_table_range"));

const slides = build(specs("wpp_read_slide", "wpp_replace_shape_text", "wpp_add_slide"));
assert(slides.includes("WPS 演示"));
assert(slides.includes("wpp_replace_shape_text"));
assert(!slides.includes("et_write_range"));

const pdf = build(specs("pdf_get_info", "pdf_read_document"));
assert(pdf.includes("WPS PDF"));
assert(pdf.includes("没有可用的写入工具"));
assert(!/et_|wps_write|wpp_/.test(pdf));

assert(!source.includes("需要修改当前 WPS 表格/文档时，必须调用相应工具（例如 et_write_range"), "legacy cross-host prompt remains");
console.log("PASS host-aware plan retry prompt");
