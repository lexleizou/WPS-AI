import fs from "node:fs";
import vm from "node:vm";

export function loadIife(file, overrides = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Set,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    ...overrides
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context;
}
