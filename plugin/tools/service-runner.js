#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    log: "",
    staticPort: "3889",
    proxyPort: "3890",
    script: "",
    root: ""
  };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    if (key === "--log" && value) out.log = value, i += 1;
    else if (key === "--static-port" && value) out.staticPort = value, i += 1;
    else if (key === "--proxy-port" && value) out.proxyPort = value, i += 1;
    else if (key === "--script" && value) out.script = value, i += 1;
    else if (key === "--root" && value) out.root = value, i += 1;
  }
  return out;
}

function installLogSink(logPath) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const write = (level, args) => {
    const line = args.map((arg) => {
      if (typeof arg === "string") return arg;
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    }).join(" ");
    stream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
  };
  ["log", "info", "warn", "error"].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      write(level, args);
      original(...args);
    };
  });
  process.on("exit", () => {
    try { stream.end(); } catch (_) {}
  });
}

const opts = parseArgs();
if (!opts.script) {
  console.error("[service-runner] missing --script");
  process.exit(2);
}

installLogSink(opts.log);
process.env.LINGXI_STATIC_PORT = String(Number(opts.staticPort) || 3889);
process.env.PROXY_PORT = String(Number(opts.proxyPort) || 3890);

process.argv = [
  process.argv[0],
  opts.script,
  "--root",
  opts.root || path.resolve(path.dirname(opts.script), ".."),
  "--static-port",
  process.env.LINGXI_STATIC_PORT,
  "--proxy-port",
  process.env.PROXY_PORT
];

console.log("[service-runner] starting", {
  script: opts.script,
  root: opts.root,
  staticPort: process.env.LINGXI_STATIC_PORT,
  proxyPort: process.env.PROXY_PORT
});

require(path.resolve(opts.script));
