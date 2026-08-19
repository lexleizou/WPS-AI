// 一次性脚本：把 gen-bold-schemes.js 生成的三段内容 splice 进 registry.js / app.js / taskpane.html
// 幂等：再跑一遍会判断是否已插入；已插入则跳过该文件。

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GEN = path.join(__dirname, ".gen");

const registryBlock = fs.readFileSync(path.join(GEN, "registry-block.txt"), "utf8");
const appMirrorBlock = fs.readFileSync(path.join(GEN, "app-mirror-block.txt"), "utf8");
const htmlOptionsBlock = fs.readFileSync(path.join(GEN, "html-options.txt"), "utf8");

// ---------- 1. registry.js ----------
{
  const file = path.join(ROOT, "js/providers/registry.js");
  let src = fs.readFileSync(file, "utf8");
  if (src.includes('"8-bit-orbit": Object.freeze({')) {
    console.log("[registry.js] already spliced, skip");
  } else {
    // 锚点：paper-ink 的结束 `}) \n    })` —— COLOR_SCHEMES 的最后一项
    // 改成：`}),\n<新 entries>\n    })`
    const anchor = '        titleFont: "宋体", bodyFont: "宋体"\n      })\n    })';
    if (!src.includes(anchor)) throw new Error("[registry.js] anchor not found");
    const replaced = '        titleFont: "宋体", bodyFont: "宋体"\n      }),\n' + registryBlock + '    })';
    src = src.replace(anchor, replaced);
    fs.writeFileSync(file, src, "utf8");
    console.log("[registry.js] spliced");
  }
}

// ---------- 2. app.js 镜像 ----------
{
  const file = path.join(ROOT, "js/app.js");
  let src = fs.readFileSync(file, "utf8");
  if (src.includes('"8-bit-orbit":')) {
    console.log("[app.js] already spliced, skip");
  } else {
    // 锚点：paper-ink 的结束行 + 接下来的 `};`
    const anchor = '    "paper-ink":         { darkMode: false, primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B", backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF", titleColor: "#1C1917", bodyColor: "#292524", titleFont: "宋体",            bodyFont: "宋体" }\n  };';
    if (!src.includes(anchor)) throw new Error("[app.js] anchor not found");
    const replaced = '    "paper-ink":         { darkMode: false, primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B", backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF", titleColor: "#1C1917", bodyColor: "#292524", titleFont: "宋体",            bodyFont: "宋体" },\n' + appMirrorBlock + '  };';
    src = src.replace(anchor, replaced);
    fs.writeFileSync(file, src, "utf8");
    console.log("[app.js] spliced");
  }
}

// ---------- 3. taskpane.html <select> ----------
{
  const file = path.join(ROOT, "taskpane.html");
  let src = fs.readFileSync(file, "utf8");
  if (src.includes('value="8-bit-orbit"')) {
    console.log("[taskpane.html] already spliced, skip");
  } else {
    // 锚点：极简 / 文学 optgroup 的结束 + select 的结束
    const anchor = '              <optgroup label="极简 / 文学">\n                <option value="swiss-modern">Swiss Modern · 极简精准</option>\n                <option value="paper-ink">Paper & Ink · 文学沉稳</option>\n              </optgroup>\n            </select>';
    if (!src.includes(anchor)) throw new Error("[taskpane.html] anchor not found");
    const replaced = '              <optgroup label="极简 / 文学">\n                <option value="swiss-modern">Swiss Modern · 极简精准</option>\n                <option value="paper-ink">Paper & Ink · 文学沉稳</option>\n              </optgroup>\n' + htmlOptionsBlock + '            </select>';
    src = src.replace(anchor, replaced);
    fs.writeFileSync(file, src, "utf8");
    console.log("[taskpane.html] spliced");
  }
}

console.log("done");
