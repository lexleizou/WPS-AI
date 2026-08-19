"use strict";

const assert = require("assert");
const fs = require("fs");

const js = fs.readFileSync("/Users/lexleizou/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js", "utf8");
const css = fs.readFileSync("/Users/lexleizou/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.css", "utf8");

assert(js.includes("LINGXI_CHAT_COPY_SYSTEM_MIRROR_V1"), "mirror marker missing");
assert(js.includes("function mirrorTextToSystemClipboard("), "mirror helper missing");
assert(js.includes('proxyUrl("/clipboard/text")'), "proxy clipboard endpoint missing");
assert(js.includes("mirrorTextToSystemClipboard(text).then"), "chat copy must always mirror selection to system clipboard");
assert(js.includes("showCopyHint("), "copy feedback hint missing");
assert(js.includes("__lingxiSystemMirrorV1"), "editable shortcut mirror wrapper missing");
assert(js.includes("copySelectionToClipboard") && js.includes("cutSelectionToClipboard"), "editable wrappers missing");
assert(css.includes(".lingxi-copy-hint"), "copy hint styles missing");

console.log("PASS chat copy system clipboard mirror");
assert(js.includes('addEventListener("copy"'), "copy event listener missing (macOS menu key equivalent path)");
assert(js.includes('clipboardData.setData("text/plain"'), "copy event must set clipboardData");
assert(js.includes("lingxi-floating-copy-btn"), "floating copy button missing (mouse path for native-menu-consumed Cmd+C)");
assert(js.includes('addEventListener("pointerup"'), "selection pointerup handler missing");
assert(css.includes(".lingxi-floating-copy-btn"), "floating copy styles missing");
console.log("PASS floating copy button");
