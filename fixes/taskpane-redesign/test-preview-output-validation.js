"use strict";

const assert = require("assert");
const fs = require("fs");
const jsPath = `${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.js`;
const cssPath = `${process.env.HOME}/.lingxi-ai/fixes/taskpane-redesign/lingxi-graphite-taskpane.css`;
const js = fs.readFileSync(jsPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

const start = js.indexOf("const PREVIEW_REQUIRED_FIELDS");
const end = js.indexOf("function compactPreviewEvidence", start);
assert(start >= 0 && end > start, "preview validation helpers missing");
const api = new Function(`${js.slice(start, end)}\nreturn { validateModificationPreview };`)();

const valid = `
# 修改预览
## 检查范围
已检查页眉、正文签批表及目录相关段落。
## 问题分类
格式、目录编号、页眉页脚。
## 证据锚点
§12、§48、T3、页眉第 1 节。
## 拟修改动作
仅调整不一致段落格式，并删除孤立手工页码。
## 预计影响数量
预计 3 个段落、1 个页眉单元格。
## 不会修改的内容
不改变技术含义、审批信息、签名和表格数据。
## 待确认事项
CE 缩略语定义、URS0102/URS0103 重复内容由用户确认。
`;
assert.strictEqual(api.validateModificationPreview(valid).valid, true, "complete seven-field preview must pass");

const refusal = `本轮可调用的 WPS 文字工具清单里没有任何写入类工具，因此无法执行修改。要继续请重新发起本任务。`;
const refusalResult = api.validateModificationPreview(refusal);
assert.strictEqual(refusalResult.valid, false, "write-tool refusal must fail preview validation");
assert.strictEqual(refusalResult.refusal, true, "write-tool refusal not detected");
assert(refusalResult.missing.includes("检查范围") && refusalResult.missing.includes("证据锚点"), "missing fields not reported");

const partial = `## 检查范围\n正文。\n## 问题分类\n格式。\n## 待确认事项\n无。`;
assert.strictEqual(api.validateModificationPreview(partial).valid, false, "partial preview must fail");

const escapeStart = js.indexOf("function escapeLongRewriteTermsInEvidence");
const escapeEnd = js.indexOf("function currentPreviewEvidenceContext", escapeStart);
assert(escapeStart >= 0 && escapeEnd > escapeStart, "evidence route escaping helper missing");
const escapeApi = new Function(`${js.slice(escapeStart, escapeEnd)}\nreturn { escapeLongRewriteTermsInEvidence };`)();
const escaped = escapeApi.escapeLongRewriteTermsInEvidence("全文缩写与统一术语，逐段润色并重写");
for (const trigger of ["全文", "缩写", "统一术语", "逐段", "润色", "重写"]) assert(!escaped.includes(trigger), `long-rewrite trigger leaked from evidence: ${trigger}`);
assert(escaped.includes("缩略语") && escaped.includes("全部内容"), "evidence semantics were not preserved");

for (const token of [
  "previewRepairAttempts", "buildPreviewRepairPrompt", "lastPreviewValidation", "preview_failed",
  "本阶段故意隐藏所有写入工具", "writePreviewGate.mapContext", "writePreviewGate.previewEvidence",
  "currentPreviewEvidenceContext", "compactPreviewEvidence"
]) assert(js.includes(token), `missing preview hardening token: ${token}`);
assert(js.includes('clickChatStopSilently("preview-map-boundary")'), "stage boundary missing");
assert(js.includes('writePreviewGate.previewRepairAttempts < 1'), "single repair attempt guard missing");
assert(js.includes('writePreviewGate.phase === "previewing" && /^(?:【阶段二：只读修改预览】|【修改预览格式纠偏)'), "internal preview request re-gating guard missing");
assert(css.includes('[data-phase="preview_failed"]') && css.includes("var(--lg-error)"), "failed preview visual state missing");

console.log("PASS deterministic modification preview validation and one-shot repair");
