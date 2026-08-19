"use strict";

const assert = require("assert");
const fs = require("fs");

const root = `${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign`;
const js = fs.readFileSync(`${root}/lingxi-graphite-taskpane.js`, "utf8");
const css = fs.readFileSync(`${root}/lingxi-graphite-taskpane.css`, "utf8");
assert.ok(js.includes("syncModelControlWidth"), "model label changes must recalculate the control width");
assert.ok(js.includes("--lg-model-control-width"), "calculated width must be exposed to CSS");
assert.ok(css.includes("var(--lg-model-control-width"), "composer model control must consume its calculated width");
assert.ok(!css.includes("min-width: 220px;"), "composer model control must not impose a fixed 220px minimum");
console.log("PASS model display width");
