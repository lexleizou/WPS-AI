(function attachPreserveObjects(global) {
  "use strict";

  const OBJECT_KINDS = { image: true, table: true, shape: true, equation: true };

  // 占位符标签：内嵌图/图表/内嵌视频 -> 图片；表格 -> 表格；公式 -> 公式；浮动对象/在线视频 -> 对象
  const LABELS = { image: "图片", table: "表格", equation: "公式", shape: "对象" };

  // 占位符 token（非捕获组，供 split 用不产生额外元素）。宽松兼容 视频/图表 以防提示词/旧数据出现。
  const TOKEN_SOURCE = "\\[(?:图片|表格|视频|公式|图表|对象)\\s*\\d*\\]";
  const TOKEN_SPLIT = new RegExp(TOKEN_SOURCE, "g");
  const TOKEN_ONLY = new RegExp("^\\s*" + TOKEN_SOURCE + "\\s*$");
  const TOKEN_HAS = new RegExp(TOKEN_SOURCE);

  function classifySegment(flags) {
    const f = flags || {};
    if (f.inTable) return "table";
    if (f.hasInlineShape) return "image";
    if (f.hasAnchoredShape) return "shape";
    if (f.hasEquation) return "equation";
    if (f.textEmpty) return "empty";
    return "paragraph";
  }

  function isObjectKind(kind) { return !!OBJECT_KINDS[kind]; }

  function placeholderLabelFor(kind) { return LABELS[kind] || "对象"; }

  function renderStructureWithPlaceholders(structure) {
    const segs = (structure && Array.isArray(structure.segments)) ? structure.segments : [];
    const objects = [];
    const lines = [];
    let seq = 0;
    for (const s of segs) {
      if (isObjectKind(s.kind)) {
        seq += 1;
        const label = s.label || placeholderLabelFor(s.kind);
        objects.push({ seq, kind: s.kind, label, start: s.start, end: s.end });
        lines.push("[" + label + seq + "]");
      } else if (s.kind === "empty") {
        continue;
      } else {
        lines.push(String(s.text || ""));
      }
    }
    return { text: lines.join("\n"), objects };
  }

  // 由段清单构建"对象之间的文本区槽"。槽数 = 对象段数 + 1。
  // 每个对象段触发一次 flush（关闭它前面的文本区槽），循环结束再 flush 一次（末槽）。
  function buildZones(segments) {
    const segs = Array.isArray(segments) ? segments : [];
    const zones = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.count > 0) zones.push({ start: cur.start, end: cur.end, hasRange: true });
      else zones.push({ start: null, end: null, hasRange: false });
      cur = null;
    };
    for (const s of segs) {
      if (isObjectKind(s.kind)) {
        flush();
      } else if (s.kind === "empty") {
        continue; // 空段不作为可写内容，也不并入区间
      } else {
        if (!cur) cur = { start: s.start, end: s.end, count: 0 };
        cur.start = Math.min(cur.start, s.start);
        cur.end = Math.max(cur.end, s.end);
        cur.count += 1;
      }
    }
    flush();
    return zones;
  }

  function isTextBlock(b) {
    if (!b || typeof b !== "object") return true;
    const t = b.type;
    return !t || t === "paragraph" || t === "heading" || t === "quote";
  }

  // 把 AI 输出 blocks 按占位符 token 切成若干组。
  function splitBlocksByPlaceholder(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const groups = [[]];
    let markerCount = 0;
    const newBoundary = () => { groups.push([]); markerCount += 1; };
    const last = () => groups[groups.length - 1];
    for (const b of list) {
      if (!isTextBlock(b)) { last().push(b); continue; }
      const text = (b && typeof b === "object") ? String(b.text || "") : String(b || "");
      if (TOKEN_ONLY.test(text)) { newBoundary(); continue; }
      if (TOKEN_HAS.test(text)) {
        const parts = text.split(TOKEN_SPLIT);
        parts.forEach((seg, i) => {
          const t = seg.trim();
          if (t) last().push({ type: (b && b.type) || "paragraph", text: t });
          if (i < parts.length - 1) newBoundary();
        });
        continue;
      }
      last().push(b);
    }
    return { groups, markerCount };
  }

  // 组 -> 文本区槽映射。仅返回 hasRange 槽；空槽内容并入最近可写槽（前优先，其次后）。
  function mapGroupsToZones(groups, zones) {
    const g = Array.isArray(groups) ? groups : [];
    const z = Array.isArray(zones) ? zones : [];
    if (z.length === 0) return [];
    const perSlot = z.map((_, i) => (g[i] ? g[i].slice() : []));
    for (let i = z.length; i < g.length; i += 1) {
      perSlot[z.length - 1] = perSlot[z.length - 1].concat(g[i]);
    }
    const nearestWritable = (from) => {
      for (let d = 1; d < z.length; d += 1) {
        if (z[from - d] && z[from - d].hasRange) return from - d;
        if (z[from + d] && z[from + d].hasRange) return from + d;
      }
      return -1;
    };
    z.forEach((zone, i) => {
      if (zone.hasRange || !perSlot[i].length) return;
      const t = nearestWritable(i);
      if (t >= 0) { perSlot[t] = perSlot[t].concat(perSlot[i]); perSlot[i] = []; }
    });
    const assignments = [];
    z.forEach((zone, i) => { if (zone.hasRange) assignments.push({ zone, blocks: perSlot[i] }); });
    return assignments;
  }

  global.WpsAiPreserveObjects = {
    classifySegment,
    isObjectKind,
    placeholderLabelFor,
    renderStructureWithPlaceholders,
    buildZones,
    splitBlocksByPlaceholder,
    mapGroupsToZones
  };
})(window);
