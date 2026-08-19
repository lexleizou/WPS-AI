// 读取/查询类内置工具的共享分页 / 范围纯函数。
//
// 无 COM / DOM 依赖，纯逻辑，供 tools/*.js 的读取工具复用，并可用 node:test 独立单测。
// 统一约定见 docs/superpowers/specs/2026-08-03-read-query-tools-params-design.md：
//   - 分页：offset(≥0) + 上限(maxChars/limit) → 返回 { truncated, nextOffset }
//   - 范围：段落/页/幻灯片用 1-based 闭区间
(function attachReadUtils(global) {
  "use strict";

  // 文本分页：从 offset 起最多取 maxChars 个字符。
  // 返回 { slice, truncated, nextOffset }。maxChars 省略/非正 → 取到结尾、不截断。
  function paginateText(text, opts) {
    const s = typeof text === "string" ? text : "";
    const options = opts || {};
    let offset = Math.floor(Number(options.offset) || 0);
    if (offset < 0) offset = 0;
    if (offset > s.length) offset = s.length;
    const maxChars = Math.floor(Number(options.maxChars) || 0);
    if (!(maxChars > 0)) {
      return { slice: s.slice(offset), truncated: false, nextOffset: null };
    }
    const end = offset + maxChars;
    const slice = s.slice(offset, end);
    const truncated = end < s.length;
    return { slice, truncated, nextOffset: truncated ? end : null };
  }

  // 归一 1-based 闭区间到 [1, count]。from 省略→1，to 省略→count。
  // from>to 时收敛（取交集/夹紧），保证返回合法。count=0 → 空区间 {from:1,to:0}。
  function clampIndexRange(opts) {
    const options = opts || {};
    const count = Math.max(0, Math.floor(Number(options.count) || 0));
    if (count === 0) return { from: 1, to: 0 }; // 空区间（无内容可取）
    const clamp = (v, dflt) => {
      const n = options[v] == null ? dflt : Math.floor(Number(options[v]));
      if (!Number.isFinite(n)) return dflt;
      return n;
    };
    let from = clamp("from", 1);
    let to = clamp("to", count);
    // 夹紧到 [1, count]
    from = Math.min(Math.max(from, 1), count);
    to = Math.min(Math.max(to, 1), count);
    // 顺序颠倒（用户传反）时交换成合法非空区间
    if (from > to) { const t = from; from = to; to = t; }
    return { from, to };
  }

  // 列表窗口：items 从 offset 起最多取 limit 条。
  // 返回 { window, truncated, nextOffset, total }。limit 省略/非正 → 取到结尾。
  function applyListWindow(items, opts) {
    const arr = Array.isArray(items) ? items : [];
    const total = arr.length;
    const options = opts || {};
    let offset = Math.floor(Number(options.offset) || 0);
    if (offset < 0) offset = 0;
    if (offset > total) offset = total;
    const limit = Math.floor(Number(options.limit) || 0);
    if (!(limit > 0)) {
      return { window: arr.slice(offset), truncated: false, nextOffset: null, total };
    }
    const end = offset + limit;
    const window = arr.slice(offset, end);
    const truncated = end < total;
    return { window, truncated, nextOffset: truncated ? end : null, total };
  }

  const api = { paginateText, clampIndexRange, applyListWindow };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.WpsAiReadUtils = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
