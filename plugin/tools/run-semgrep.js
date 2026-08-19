#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const defaultArgs = ["scan", "--config", "p/javascript", "--config", "p/security-audit"];
const userArgs = process.argv.slice(2);
const semgrepArgs = userArgs.length === 0
  ? defaultArgs
  : (userArgs[0].startsWith("-") ? [...defaultArgs, ...userArgs] : userArgs);

const home = os.homedir();
const pythonUserBins = ["3.13", "3.12", "3.11", "3.10", "3.9"].flatMap((version) => [
  path.join(home, "Library", "Python", version, "bin", "semgrep"),
  path.join(home, "Library", "Python", version, "bin", "pysemgrep"),
  path.join(home, ".local", "bin", "semgrep"),
  path.join(home, ".local", "bin", "pysemgrep")
]);

const candidates = [
  ["semgrep", semgrepArgs],
  ["pysemgrep", semgrepArgs],
  ...pythonUserBins.map((bin) => [bin, semgrepArgs]),
  ["python3", ["-m", "semgrep", ...semgrepArgs]],
  ["python", ["-m", "semgrep", ...semgrepArgs]]
];

let lastFailure = null;

for (const [command, args] of candidates) {
  const env = { ...process.env };
  env.SEMGREP_SEND_METRICS = env.SEMGREP_SEND_METRICS || "off";
  env.PYTHONWARNINGS = env.PYTHONWARNINGS || "ignore";
  if (path.isAbsolute(command)) {
    env.PATH = `${path.dirname(command)}${path.delimiter}${env.PATH || ""}`;
  }
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error && result.error.code === "ENOENT") {
    lastFailure = result.error;
    continue;
  }
  if (result.error) {
    console.error(`[semgrep] ${command} 启动失败: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

console.error("[semgrep] 未找到 Semgrep CLI。请先安装官方 Semgrep：");
console.error("  python3 -m pip install --user semgrep");
console.error("或把 semgrep/pysemgrep 加入 PATH 后重试 npm run scan:semgrep。");
if (lastFailure) console.error(`[semgrep] 最后一次错误: ${lastFailure.message}`);
process.exit(127);
