const fs = require("fs");
const path = require("path");
const os = require("os");

// NOTE: wpsjs debug（dev 模式）默认跑在 3891；
//       serve-permanent（永久安装）跑在 3889。
//       通过 --port <n> 参数覆盖，默认使用 dev 端口 3891。
const portArg = process.argv.indexOf("--port");
const rawPort = portArg !== -1 ? process.argv[portArg + 1] : "3891";
// 修 LOW：--port 作为最后一个参数时值为 undefined，会写出 :undefined 的坏 URL。校验为纯数字端口。
const port = /^\d{1,5}$/.test(String(rawPort || "")) ? String(rawPort) : "3891";
if (String(rawPort) !== port) {
  console.warn(`[install-mac-publish] 端口参数无效(${rawPort})，回退到 ${port}`);
}

const lingxiEntry = `  <jspluginonline name="lingxi-ai" type="wps" url="http://127.0.0.1:${port}/" debug="" enable="enable_dev" install="null"/>`;

const targets = [
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml"),
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml")
];

// 修 T3：publish.xml 是共享清单，保留别家插件的 <jspluginonline> 条目，只增删 lingxi 的。
function buildMerged(existingPath) {
  let others = [];
  try {
    if (fs.existsSync(existingPath)) {
      others = fs.readFileSync(existingPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => /jspluginonline/i.test(l) && !/lingxi-ai/i.test(l));
    }
  } catch (e) { /* 读不了就当没有 */ }
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<jsplugins>',
    ...others,
    lingxiEntry,
    '</jsplugins>',
    ''
  ].join("\n");
}

for (const target of targets) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildMerged(target), "utf8");
    console.log(`[install-mac-publish] wrote (port=${port}) → ${target}`);
  } catch (e) {
    console.error(`[install-mac-publish] 写入失败 ${target}: ${e && e.message}`);
  }
}

