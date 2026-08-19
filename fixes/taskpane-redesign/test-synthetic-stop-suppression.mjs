import { JSDOM } from "jsdom";
import fs from "fs";

const src = fs.readFileSync(`${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`, "utf8");
const start = src.indexOf("function isSyntheticChatStop");
const end = src.indexOf("function installInspectionBusyObserver", start);
if (start < 0 || end <= start) throw new Error("synthetic stop helpers missing");

const dom = new JSDOM(`<div id="chatStream"></div><button id="chatStopBtn">stop</button>`);
const { window } = dom;
const api = new window.Function("window", `
  const document = window.document;
  const byId = (id) => document.getElementById(id);
  ${src.slice(start, end)}
  return { clickChatStopSilently, isSyntheticChatStop };
`)(window);

const stream = window.document.getElementById("chatStream");
const stop = window.document.getElementById("chatStopBtn");
let manualStopCount = 0;
stop.addEventListener("click", () => {
  if (!api.isSyntheticChatStop(stop)) manualStopCount += 1;
}, true);
// 模拟 app.js stopChat：Abort 后同步插入红色“（已停止）”。
stop.addEventListener("click", () => {
  const node = window.document.createElement("div");
  node.className = "tl-error";
  node.textContent = "（已停止）";
  stream.appendChild(node);
  stop.classList.add("hidden");
});

if (!api.clickChatStopSilently("test-stage")) throw new Error("silent stop did not execute");
if (stream.textContent.includes("已停止")) throw new Error("synthetic stop notice was not removed");
if (manualStopCount !== 0) throw new Error("synthetic stop polluted manual-stop state");
await new Promise((resolve) => window.setTimeout(resolve, 5));
if (stop.dataset.lingxiSyntheticStop) throw new Error("synthetic stop marker was not cleared");

// 真正用户点击仍应保留原生提示，并计为手动停止。
stop.classList.remove("hidden");
stop.click();
if (!stream.textContent.includes("已停止")) throw new Error("manual stop notice must remain visible");
if (manualStopCount !== 1) throw new Error("manual stop was not recorded");

console.log("PASS synthetic stage stop suppression and manual stop preservation");
