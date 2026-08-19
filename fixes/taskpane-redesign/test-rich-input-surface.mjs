import { JSDOM } from "jsdom";
import fs from "fs";

const src = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const start = src.indexOf("function escapeRichHtml");
const end = src.indexOf("function enhanceRichInputSurfaces");
if (start < 0 || end < 0) throw new Error("segment not found");
const seg = src.slice(start, end);

const dom = new JSDOM(`<div class="box"><textarea id="chatInput" rows="3"></textarea></div>`);
const { window } = dom;
const fn = new window.Function("window", `
  const document = window.document;
  const Event = window.Event;
  ${seg}
  return { renderRichInputHtml, attachRichSurface, numberRichLines, wrapRichSelection, toggleRichSectionLines };
`);
const api = fn(window);

// 渲染规则
const html = api.renderRichInputHtml("【执行原则】\n1. **先扫描**，再修改\n==高亮== 与 §95、T3\n普通行");
if (!html.includes('lri-section') || !html.includes('<span class="lri-num">1.</span>') || !html.includes('<strong class="lri-bold">先扫描</strong>') || !html.includes('<mark class="lri-mark">高亮</mark>') || !html.includes('>§95<') || !html.includes('>T3<')) {
  console.error(html); throw new Error("render rules broken");
}

// 背板同步
const ta = window.document.getElementById("chatInput");
ta.value = "【标题】\n1. 第一条";
const entry = api.attachRichSurface(ta);
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
if (!entry.backdrop.innerHTML.includes("lri-section")) throw new Error("backdrop not synced");
if (!ta.classList.contains("lri-active")) throw new Error("textarea not transparent-active");
if (ta.parentNode.className !== "lri-wrap") throw new Error("wrapper missing");

// app.js 发送完成后直接 chatInput.value = ""，不会触发 input；value accessor 必须同步背板。
ta.value = "程序赋值的新内容";
await Promise.resolve();
if (!entry.backdrop.textContent.includes("程序赋值的新内容")) throw new Error("programmatic value update not synced");
ta.value = "";
await Promise.resolve();
if (entry.backdrop.textContent.includes("程序赋值的新内容")) throw new Error("programmatic clear left stale backdrop text");

// 工具：编号
ta.value = "第一行\n第二行";
ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
api.numberRichLines(ta);
if (ta.value !== "1. 第一行\n2. 第二行") throw new Error("numbering broken: " + ta.value);

// 工具：粗体包裹
ta.value = "加粗我";
ta.selectionStart = 0; ta.selectionEnd = 3;
api.wrapRichSelection(ta, "**", "**");
if (ta.value !== "**加粗我**") throw new Error("bold wrap broken: " + ta.value);

// 工具：章节切换
ta.value = "执行原则";
ta.selectionStart = 0; ta.selectionEnd = 4;
api.toggleRichSectionLines(ta);
if (ta.value !== "【执行原则】") throw new Error("section toggle broken: " + ta.value);
api.toggleRichSectionLines(ta);
if (ta.value !== "执行原则") throw new Error("section untoggle broken: " + ta.value);

console.log("PASS rich input surface");
