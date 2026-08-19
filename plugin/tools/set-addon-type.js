#!/usr/bin/env node
/**
 * 切换 package.json / manifest.json 中的 addonType，决定 `wpsjs debug`
 * 自动启动哪个 WPS 宿主，也保证 WPS 实际读取到的 manifest 宿主一致。
 *
 * 用法：
 *   node tools/set-addon-type.js wps   # WPS 文字
 *   node tools/set-addon-type.js et    # WPS 表格
 *   node tools/set-addon-type.js wpp   # WPS 演示
 *
 * 注意：wpsjs 一次只能把 addon 注册给一个宿主，所以在不同宿主里测试需要
 * 切换 addonType 后重启 `wpsjs debug`。插件 JS 代码已经做了多宿主适配，
 * 只要它被加载就能自动识别当前 host。
 */

const fs = require("fs");
const path = require("path");

const TARGETS = new Set(["wps", "et", "wpp", "pdf"]);
const target = process.argv[2];

if (!target || !TARGETS.has(target)) {
  console.error("用法：node tools/set-addon-type.js <wps|et|wpp|pdf>");
  process.exit(1);
}

const pkgPath = path.resolve(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const previous = pkg.addonType;
pkg.addonType = target;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const manifestPath = path.resolve(process.cwd(), "manifest.json");
let manifestPrevious = null;
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifestPrevious = manifest.addonType;
  manifest.addonType = target;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

const labels = { wps: "WPS 文字", et: "WPS 表格", wpp: "WPS 演示", pdf: "WPS PDF" };
const manifestNote = manifestPrevious === null
  ? ""
  : `, manifest: ${manifestPrevious || "(unset)"} → ${target}`;
console.log(`[set-addon-type] package: ${previous || "(unset)"} → ${target}${manifestNote}（${labels[target]}）`);
