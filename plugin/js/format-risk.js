// WpsAiFormatRisk：AI 排版的段落风险画像（P0-1，参考察元 assessChunkRiskProfile）。
//
// 目的：识别「结构敏感」段落——疑似表格行 / 编号密集 / 符号密集 / 签署栏——
// 送 AI 排版前打标，提示词里要求这类段落 text 原样保留，只判断样式类型，
// 不改写、不合并、不拆分。治「表格样文本被 AI 拆乱」的老坑。
(function attachFormatRisk(global) {
  "use strict";

  // 中文编号 / 章节 / 条款开头（这类段落的编号是文档结构，AI 重写容易弄丢或改序）
  const NUMBERING_RE = /^\s*(?:第[0-9一二三四五六七八九十百千]+[章节条款篇部卷]|[一二三四五六七八九十]+[、.．]|[(（][一二三四五六七八九十0-9]+[)）]|\d+(?:\.\d+)+[、.．)）]?|\d+[、.．)）])/;

  // 疑似表格行：| 分隔 ≥2 / tab ≥2 / 连续多空格分列 ≥3
  function looksTabular(line) {
    const s = String(line || "");
    const pipes = (s.match(/\|/g) || []).length;
    const tabs = (s.match(/\t/g) || []).length;
    const multiSpaceCols = (s.match(/ {2,}/g) || []).length;
    return pipes >= 2 || tabs >= 2 || multiSpaceCols >= 3;
  }

  // 签署栏 / 填空线：下划线连续段（甲方：____ 这类，重写会破坏填空位）
  function looksSignature(line) {
    return /_{4,}|＿{3,}/.test(String(line || ""));
  }

  // 符号密度：ASCII 结构符号占比 ≥8%（代码、路径、公式类内容）。
  // 刻意不数全角（）【】——中文行文常用，数进去会把「（一）xxx」这类正常段落误判。
  function punctuationDense(line) {
    const s = String(line || "");
    if (s.length < 12) return false;
    const marks = (s.match(/[()[\]\\/|{}<>=+]/g) || []).length;
    return marks / s.length >= 0.08;
  }

  /**
   * 评估单个段落的排版风险。
   * @returns {{ level: "low"|"medium"|"high", reasons: string[] }}
   */
  function assess(text) {
    const s = String(text || "").trim();
    if (!s) return { level: "low", reasons: [] };
    const reasons = [];
    if (looksTabular(s)) reasons.push("table_like");
    if (looksSignature(s)) reasons.push("signature_line");
    if (NUMBERING_RE.test(s)) reasons.push("numbering");
    if (punctuationDense(s)) reasons.push("punctuation_dense");
    let level = "low";
    if (reasons.includes("table_like") || reasons.includes("signature_line")) level = "high";
    else if (reasons.length >= 2) level = "high";
    else if (reasons.length === 1) level = "medium";
    return { level, reasons };
  }

  // 便捷判断：该段落是否需要「原样保留」标注（medium 及以上）
  function isSensitive(text) {
    return assess(text).level !== "low";
  }

  global.WpsAiFormatRisk = { assess, isSensitive };
})(window);
