"use strict";
// 选一个能跑 proxy 的 node：node:sqlite 需要 --experimental-sqlite 且 Node >= 22.5。
// 优先用内置 runtime/*/node(.exe)（保证是我们打包的 v22.11、一定支持该 flag）；
// 找不到内置就用当前 node（仅当其版本 >= 22.5）。两者都不满足 → 返回 { error }，
// 由调用方明确报错退出，绝不"降级不带 flag 悄悄跑"（缓存不允许退回 localStorage）。
const fs = require("fs");
const path = require("path");

function nodeSupportsSqlite(ver) {
  const m = /v?(\d+)\.(\d+)/.exec(String(ver || ""));
  if (!m) return false;
  const maj = Number(m[1]), min = Number(m[2]);
  return maj > 22 || (maj === 22 && min >= 5);
}

// 在 <cwd>/runtime/*/ 下找当前平台可用的 node 可执行文件。
// 关键：必须按平台过滤——开发机为交叉打包可能同时放着 node-linux-arm64 等其它平台
// 的 runtime，按目录名字母序瞎拿第一个会在 Windows 上选中 Linux 二进制（跑不起来，
// spawn 报"不是内部或外部命令"）。目录命名约定：node-<win|darwin|linux>-<x64|arm64>。
function findBundledNode(cwd) {
  const root = path.resolve(cwd, "runtime");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { return null; }
  const plat = process.platform === "win32" ? "win" : process.platform; // win / darwin / linux
  const mine = dirs.filter((d) => d.indexOf("-" + plat + "-") >= 0);
  // 架构完全匹配优先；同平台其它架构兜底（如 Win11 ARM 跑 x64 exe、mac Rosetta）
  mine.sort((a, b) => {
    const rank = (d) => (d.indexOf("-" + process.arch) >= 0 ? 0 : 1);
    return rank(a) - rank(b);
  });
  const rels = process.platform === "win32"
    ? ["node.exe"]
    : [path.join("bin", "node"), "node"];
  for (const d of mine) {
    for (const rel of rels) {
      const p = path.join(root, d, rel);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  return null;
}

// 成功 → { nodeBin, args }（args 已含 --experimental-sqlite + 脚本绝对路径）。
// 没有可用 node → { error }，由调用方报错退出（绝不降级不带 flag 跑）。
function pickProxyLauncher(cwd, scriptRelPath) {
  const script = path.resolve(cwd, scriptRelPath);
  const bundled = findBundledNode(cwd);
  if (bundled) return { nodeBin: bundled, args: ["--experimental-sqlite", script] };
  if (nodeSupportsSqlite(process.version)) {
    return { nodeBin: process.execPath, args: ["--experimental-sqlite", script] };
  }
  return {
    error:
      "SQLite 存储需要 Node >= 22.5（当前 " + process.version + "），且未找到内置 runtime node。" +
      "请用内置 node 启动，或将本机 Node 升级到 22.5+（如 nvm install 22.11）后重试。"
  };
}

module.exports = { pickProxyLauncher, findBundledNode, nodeSupportsSqlite };
