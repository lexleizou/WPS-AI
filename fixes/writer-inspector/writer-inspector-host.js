(function attachWriterInspector(global) {
  "use strict";

  // LINGXI_WRITER_INSPECTOR_PHASE1_V1
  const VERSION = 1;
  const WD_UNDEFINED = 9999999;
  const FONT_KEYS = [
    "Name", "NameFarEast", "NameAscii", "NameOther", "Size", "Bold", "Italic",
    "Underline", "UnderlineColor", "Color", "ColorIndex", "StrikeThrough",
    "DoubleStrikeThrough", "Subscript", "Superscript", "SmallCaps", "AllCaps",
    "Hidden", "Spacing", "Scaling", "Position", "Kerning"
  ];
  const PARA_KEYS = [
    "Alignment", "LineSpacing", "LineSpacingRule", "SpaceBefore", "SpaceAfter",
    "FirstLineIndent", "LeftIndent", "RightIndent", "CharacterUnitLeftIndent",
    "CharacterUnitFirstLineIndent", "CharacterUnitRightIndent", "KeepWithNext",
    "KeepTogether", "PageBreakBefore", "WidowControl"
  ];
  const LIST_KEYS = ["ListType", "ListLevelNumber", "ListValue", "ListString"];

  async function getApp() {
    return global.WpsAiAddon?.getApplication
      ? await global.WpsAiAddon.getApplication()
      : global.Application;
  }

  async function ensureDocument() {
    const app = await getApp();
    const doc = app?.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = doc && typeof doc.then === "function" ? await doc : doc;
    if (!resolved) throw new Error("未获取到当前 WPS 文字文档。");
    return resolved;
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function countOf(collection) {
    try { return Math.max(0, Number(collection?.Count) || 0); } catch (e) { return 0; }
  }

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/[\r\n\v\x07]+$/g, "")
      .replace(/\x07/g, "");
  }

  function previewText(value, maxChars) {
    const text = cleanText(value).replace(/[\r\n\v]+/g, " ").trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  }

  function normalizeValue(value) {
    if (value == null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      if (value === WD_UNDEFINED) return "mixed";
      return value;
    }
    if (typeof value === "string" || typeof value === "boolean") return value;
    try {
      const n = Number(value);
      if (Number.isFinite(n)) return n === WD_UNDEFINED ? "mixed" : n;
    } catch (e) {}
    return null;
  }

  function safeRead(obj, key) {
    try {
      const value = obj?.[key];
      if (typeof value === "function") return null;
      return normalizeValue(value);
    } catch (e) {
      return null;
    }
  }

  function rangeNumber(range, key) {
    try {
      const n = Number(range?.[key]);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  function readStyleName(paragraph, range) {
    const candidates = [];
    try { candidates.push(paragraph?.Style); } catch (e) {}
    try { candidates.push(range?.Style); } catch (e) {}
    for (const style of candidates) {
      try {
        if (typeof style === "string" && style) return style;
        const name = style?.NameLocal || style?.Name;
        if (name) return String(name);
      } catch (e) {}
    }
    return "";
  }

  function headingLevelFromStyle(styleName) {
    try {
      const shared = global.WpsAiHostWriter?.headingLevelFromStyle;
      if (typeof shared === "function") {
        const level = Number(shared(styleName));
        if (level >= 1 && level <= 9) return level;
      }
    } catch (e) {}
    const match = /^(?:Heading|标题)\s*(\d)/i.exec(String(styleName || "").trim());
    if (!match) return 0;
    const level = Number(match[1]);
    return level >= 1 && level <= 9 ? level : 0;
  }

  function parseParagraphAnchor(anchor) {
    if (typeof anchor === "number" && Number.isFinite(anchor)) {
      const index = Math.floor(anchor);
      if (index >= 1) return index;
    }
    const match = /^§(\d+)$/.exec(String(anchor || "").trim());
    if (!match) throw new Error(`无效段落锚点：${anchor || "(空)"}，应为 §N。`);
    const index = Number(match[1]);
    if (!(index >= 1)) throw new Error(`无效段落锚点：${anchor}`);
    return index;
  }

  function stableSerialize(value) {
    if (value == null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableSerialize(value[key])).join(",") + "}";
  }

  function fnv1a(value) {
    const text = String(value == null ? "" : value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function paragraphFingerprint(record) {
    return fnv1a([
      record.index, record.range?.start, record.range?.end,
      record.style, record.kind, record.text
    ].join("|"));
  }

  function paragraphRange(paragraph) {
    let range = null;
    try { range = paragraph?.Range; } catch (e) {}
    return range;
  }

  function paragraphText(paragraph, range) {
    try { return cleanText(range?.Text); } catch (e) {}
    try { return cleanText(paragraph?.Range?.Text); } catch (e) {}
    return "";
  }

  async function getDocumentFingerprint(document) {
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const count = countOf(paragraphs);
    let characters = 0;
    try { characters = String(document?.Content?.Text || "").length; } catch (e) {}
    const picks = [];
    const indexes = Array.from(new Set([1, Math.max(1, Math.ceil(count / 2)), count])).filter((n) => n >= 1 && n <= count);
    for (const index of indexes) {
      try {
        const p = paragraphs.Item(index);
        picks.push(previewText(paragraphText(p, paragraphRange(p)), 160));
      } catch (e) { picks.push(""); }
    }
    let name = "";
    try { name = String(document?.Name || ""); } catch (e) {}
    const tables = countOf(document?.Tables);
    const sections = countOf(document?.Sections);
    const fingerprint = fnv1a(stableSerialize({ name, count, characters, tables, sections, picks }));
    return { fingerprint, name, paragraphs: count, characters, tables, sections };
  }

  async function buildKindMap() {
    const map = new Map();
    try {
      const reader = global.WpsAiHostWriter?.readDocumentStructure;
      if (typeof reader !== "function") return map;
      const structure = await reader.call(global.WpsAiHostWriter);
      for (const segment of (structure?.segments || [])) {
        const index = Number(segment?.idx) + 1;
        if (index >= 1) map.set(index, String(segment?.kind || "paragraph"));
      }
    } catch (e) {}
    return map;
  }

  function readParagraphRecord(document, index, kindMap, textLimit = 0) {
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const paragraph = paragraphs?.Item(index);
    if (!paragraph) throw new Error(`段落 ${index} 不存在。`);
    const range = paragraphRange(paragraph);
    const fullText = paragraphText(paragraph, range);
    const style = readStyleName(paragraph, range);
    const record = {
      anchor: `§${index}`,
      index,
      range: { start: rangeNumber(range, "Start"), end: rangeNumber(range, "End") },
      style,
      headingLevel: headingLevelFromStyle(style),
      kind: kindMap?.get(index) || "paragraph",
      text: textLimit > 0 && fullText.length > textLimit ? fullText.slice(0, textLimit) + "…" : fullText
    };
    record.textTruncated = textLimit > 0 && fullText.length > textLimit;
    record.fingerprint = paragraphFingerprint({ ...record, text: fullText });
    return record;
  }

  function tableSummaries(document, maxTables, previewChars) {
    const tables = document?.Tables;
    const total = countOf(tables);
    const out = [];
    const cap = Math.min(total, maxTables);
    for (let i = 1; i <= cap; i += 1) {
      try {
        const table = tables.Item(i);
        const range = table?.Range;
        let firstCell = "";
        try { firstCell = previewText(table.Cell(1, 1)?.Range?.Text, previewChars); } catch (e) {}
        out.push({
          anchor: `T${i}`,
          index: i,
          rows: countOf(table?.Rows),
          cols: countOf(table?.Columns),
          range: { start: rangeNumber(range, "Start"), end: rangeNumber(range, "End") },
          firstCell
        });
      } catch (e) {}
    }
    return { total, items: out, truncated: total > out.length };
  }

  function sectionSummaries(document) {
    const sections = document?.Sections;
    const total = countOf(sections);
    const items = [];
    for (let i = 1; i <= total; i += 1) {
      try {
        const section = sections.Item(i);
        const range = section?.Range;
        items.push({
          anchor: `S${i}`,
          index: i,
          range: { start: rangeNumber(range, "Start"), end: rangeNumber(range, "End") }
        });
      } catch (e) {}
    }
    return { total, items };
  }

  function normalizeKeywords(keywords) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(keywords) ? keywords : [])) {
      const keyword = String(value || "").trim();
      if (!keyword) continue;
      const key = keyword.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(keyword);
      if (out.length >= 20) break;
    }
    return out;
  }

  async function buildDocumentMap(options = {}) {
    const document = await ensureDocument();
    const sampleInterval = clampInt(options.sampleInterval, 100, 10, 1000);
    const maxHeadings = clampInt(options.maxHeadings, 200, 1, 500);
    const maxSamples = clampInt(options.maxSamples, 40, 1, 100);
    const maxTables = clampInt(options.maxTables, 50, 1, 100);
    const maxKeywordHits = clampInt(options.maxKeywordHits, 20, 1, 100);
    const previewChars = clampInt(options.previewChars, 100, 20, 300);
    const keywords = normalizeKeywords(options.keywords);
    const fp = await getDocumentFingerprint(document);
    const kindMap = await buildKindMap();
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const headings = [];
    const samples = [];
    const keywordLocations = {};
    const headingState = { truncated: false };
    const sampleState = { truncated: false };
    for (const keyword of keywords) keywordLocations[keyword] = [];

    for (let i = 1; i <= fp.paragraphs; i += 1) {
      let record;
      try { record = readParagraphRecord(document, i, kindMap, previewChars); } catch (e) { continue; }
      if (record.headingLevel > 0) {
        if (headings.length < maxHeadings) headings.push({ ...record, level: record.headingLevel });
        else headingState.truncated = true;
      }
      const shouldSample = i === 1 || i === fp.paragraphs || ((i - 1) % sampleInterval === 0);
      if (shouldSample) {
        if (samples.length < maxSamples) samples.push({ ...record });
        else sampleState.truncated = true;
      }
      if (keywords.length) {
        const haystack = record.text.toLocaleLowerCase();
        for (const keyword of keywords) {
          const bucket = keywordLocations[keyword];
          if (bucket.length >= maxKeywordHits) continue;
          if (haystack.includes(keyword.toLocaleLowerCase())) {
            bucket.push({ anchor: record.anchor, index: i, preview: record.text, fingerprint: record.fingerprint });
          }
        }
      }
    }

    const tableData = tableSummaries(document, maxTables, previewChars);
    const sectionData = sectionSummaries(document);
    let inlineShapes = 0, shapes = 0;
    try { inlineShapes = countOf(document?.InlineShapes); } catch (e) {}
    try { shapes = countOf(document?.Shapes); } catch (e) {}

    return {
      version: VERSION,
      document: {
        name: fp.name,
        paragraphs: fp.paragraphs,
        characters: fp.characters,
        tables: fp.tables,
        sections: fp.sections,
        inlineShapes,
        shapes,
        fingerprint: fp.fingerprint
      },
      headings,
      samples,
      keywordLocations,
      tables: tableData.items,
      sections: sectionData.items,
      truncated: {
        headings: headingState.truncated,
        samples: sampleState.truncated,
        tables: tableData.truncated,
        keywordLocations: Object.fromEntries(keywords.map((keyword) => [keyword, keywordLocations[keyword].length >= maxKeywordHits]))
      },
      usageHint: "先用 wps_read_by_anchor 按 §N 范围或关键词精读；需要核对排版时再用 wps_read_paragraph_format。"
    };
  }

  function assertExpectedFingerprint(expected, actual) {
    if (expected && String(expected) !== String(actual)) {
      const error = new Error("STALE_DOCUMENT_MAP：当前文档结构已变化，请重新调用 wps_get_document_map。");
      error.code = "STALE_DOCUMENT_MAP";
      throw error;
    }
  }

  function resolveAnchorRange(options, paragraphCount) {
    const maxParagraphs = clampInt(options.maxParagraphs, 100, 1, 200);
    let from = options.startAnchor != null ? parseParagraphAnchor(options.startAnchor) : null;
    let to = options.endAnchor != null ? parseParagraphAnchor(options.endAnchor) : null;
    if (from == null && to == null) throw new Error("请提供 startAnchor/endAnchor，或使用 aroundKeyword。");
    if (from == null) from = Math.max(1, to - maxParagraphs + 1);
    if (to == null) to = Math.min(paragraphCount, from + maxParagraphs - 1);
    from = Math.max(1, Math.min(paragraphCount, from));
    to = Math.max(1, Math.min(paragraphCount, to));
    if (from > to) throw new Error(`锚点范围无效：§${from} 在 §${to} 之后。`);
    const requestedTo = to;
    to = Math.min(to, from + maxParagraphs - 1);
    return { from, to, requestedTo, maxParagraphs };
  }

  function findKeywordParagraph(document, keyword, occurrence) {
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const total = countOf(paragraphs);
    const needle = String(keyword || "").trim().toLocaleLowerCase();
    if (!needle) throw new Error("aroundKeyword 不能为空。");
    let hit = 0;
    for (let i = 1; i <= total; i += 1) {
      try {
        const paragraph = paragraphs.Item(i);
        const text = paragraphText(paragraph, paragraphRange(paragraph)).toLocaleLowerCase();
        if (text.includes(needle)) {
          hit += 1;
          if (hit === occurrence) return i;
        }
      } catch (e) {}
    }
    throw new Error(`未找到关键词：${keyword}`);
  }

  async function readByAnchor(options = {}) {
    const document = await ensureDocument();
    const fp = await getDocumentFingerprint(document);
    assertExpectedFingerprint(options.expectedDocumentFingerprint, fp.fingerprint);
    const maxParagraphs = clampInt(options.maxParagraphs, 100, 1, 200);
    const maxChars = clampInt(options.maxChars, 12000, 1, 50000);
    let range;
    let matchedKeyword = null;
    if (String(options.aroundKeyword || "").trim()) {
      const occurrence = clampInt(options.occurrence, 1, 1, 10000);
      const contextBlocks = clampInt(options.contextBlocks, 25, 0, 100);
      const found = findKeywordParagraph(document, options.aroundKeyword, occurrence);
      matchedKeyword = { keyword: String(options.aroundKeyword), occurrence, anchor: `§${found}` };
      const from = Math.max(1, found - contextBlocks);
      const requestedTo = Math.min(fp.paragraphs, found + contextBlocks);
      range = { from, to: Math.min(requestedTo, from + maxParagraphs - 1), requestedTo, maxParagraphs };
    } else {
      range = resolveAnchorRange({ ...options, maxParagraphs }, fp.paragraphs);
    }

    const kindMap = await buildKindMap();
    const lines = [];
    const blocks = [];
    let length = 0;
    let lastIncluded = range.from - 1;
    let truncatedWithinAnchor = null;
    for (let i = range.from; i <= range.to; i += 1) {
      const record = readParagraphRecord(document, i, kindMap, 0);
      const label = `[${record.anchor}|${record.style || "No Style"}|${record.kind}] `;
      const line = label + record.text;
      const separator = lines.length ? "\n" : "";
      if (length + separator.length + line.length > maxChars) {
        const remain = Math.max(0, maxChars - length - separator.length);
        if (remain > 0) {
          lines.push(separator + line.slice(0, remain));
          length += separator.length + remain;
          truncatedWithinAnchor = record.anchor;
        }
        break;
      }
      lines.push(separator + line);
      length += separator.length + line.length;
      lastIncluded = i;
      if (options.includeMetadata !== false) {
        blocks.push({
          anchor: record.anchor,
          index: record.index,
          range: record.range,
          style: record.style,
          headingLevel: record.headingLevel,
          kind: record.kind,
          textPreview: previewText(record.text, 160),
          fingerprint: record.fingerprint
        });
      }
    }

    const completedTo = lastIncluded >= range.from ? lastIncluded : range.from - 1;
    const moreByParagraph = completedTo < range.requestedTo;
    const truncated = moreByParagraph || !!truncatedWithinAnchor;
    const nextAnchor = truncatedWithinAnchor
      ? truncatedWithinAnchor
      : (moreByParagraph && completedTo + 1 <= fp.paragraphs ? `§${completedTo + 1}` : null);
    const out = {
      content: lines.join(""),
      fromAnchor: `§${range.from}`,
      toAnchor: completedTo >= range.from ? `§${completedTo}` : null,
      paragraphCount: Math.max(0, completedTo - range.from + 1),
      length,
      truncated,
      nextAnchor,
      truncatedWithinAnchor,
      documentFingerprint: fp.fingerprint
    };
    if (matchedKeyword) out.matchedKeyword = matchedKeyword;
    if (options.includeMetadata !== false) out.blocks = blocks;
    return out;
  }

  function captureProps(obj, keys) {
    const out = {};
    for (const key of keys) out[key] = safeRead(obj, key);
    return out;
  }

  function readTableRanges(document) {
    const out = [];
    const tables = document?.Tables;
    const count = countOf(tables);
    for (let i = 1; i <= count; i += 1) {
      try {
        const range = tables.Item(i)?.Range;
        const start = rangeNumber(range, "Start");
        const end = rangeNumber(range, "End");
        if (start != null && end != null) out.push({ index: i, start, end });
      } catch (e) {}
    }
    return out;
  }

  function tableContextForRange(range, tableRanges) {
    const start = rangeNumber(range, "Start");
    const end = rangeNumber(range, "End");
    let inTable = false;
    try { inTable = !!range?.Information?.(12); } catch (e) {}
    let tableIndex = null;
    if (start != null && end != null) {
      const matched = tableRanges.find((item) => start >= item.start && end <= item.end);
      if (matched) { inTable = true; tableIndex = matched.index; }
    }
    return { inTable, tableIndex };
  }

  function formatOfRecord(record) {
    return {
      style: record.style,
      headingLevel: record.headingLevel,
      kind: record.kind,
      font: record.font,
      paragraph: record.paragraph,
      list: record.list,
      table: record.table
    };
  }

  function groupFormatRecords(records) {
    const groups = [];
    let current = null;
    for (const record of records) {
      const format = formatOfRecord(record);
      const signature = fnv1a(stableSerialize(format));
      const consecutive = current && record.index === current.lastIndex + 1;
      if (!current || current.signature !== signature || !consecutive) {
        current = {
          startAnchor: record.anchor,
          endAnchor: record.anchor,
          count: 1,
          lastIndex: record.index,
          signature,
          format,
          sampleTexts: record.text ? [record.text] : []
        };
        groups.push(current);
      } else {
        current.endAnchor = record.anchor;
        current.count += 1;
        current.lastIndex = record.index;
        if (record.text && current.sampleTexts.length < 3) current.sampleTexts.push(record.text);
      }
    }
    return groups.map(({ lastIndex, signature, ...group }) => group);
  }

  function resolveFormatIndexes(options, paragraphCount) {
    const maxParagraphs = clampInt(options.maxParagraphs, 50, 1, 200);
    let indexes = [];
    if (Array.isArray(options.anchors) && options.anchors.length) {
      const seen = new Set();
      for (const anchor of options.anchors.slice(0, 200)) {
        const index = parseParagraphAnchor(anchor);
        if (index >= 1 && index <= paragraphCount && !seen.has(index)) {
          seen.add(index);
          indexes.push(index);
        }
      }
      indexes.sort((a, b) => a - b);
    } else {
      const from = parseParagraphAnchor(options.startAnchor);
      const to = options.endAnchor != null ? parseParagraphAnchor(options.endAnchor) : from;
      if (from > to) throw new Error(`锚点范围无效：§${from} 在 §${to} 之后。`);
      for (let i = Math.max(1, from); i <= Math.min(paragraphCount, to); i += 1) indexes.push(i);
    }
    if (!indexes.length) throw new Error("没有可读取的有效段落锚点。");
    const requested = indexes.length;
    indexes = indexes.slice(0, maxParagraphs);
    return { indexes, requested, truncated: requested > indexes.length };
  }

  async function readParagraphFormat(options = {}) {
    const document = await ensureDocument();
    const fp = await getDocumentFingerprint(document);
    assertExpectedFingerprint(options.expectedDocumentFingerprint, fp.fingerprint);
    const resolved = resolveFormatIndexes(options, fp.paragraphs);
    const kindMap = await buildKindMap();
    const tableRanges = readTableRanges(document);
    const includeText = options.includeText !== false;
    const records = [];
    for (const index of resolved.indexes) {
      const basic = readParagraphRecord(document, index, kindMap, includeText ? 300 : 0);
      const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
      const paragraph = paragraphs.Item(index);
      const range = paragraphRange(paragraph);
      const listFormat = (() => { try { return range?.ListFormat; } catch (e) { return null; } })();
      records.push({
        anchor: basic.anchor,
        index,
        range: basic.range,
        text: includeText ? basic.text : undefined,
        textTruncated: includeText ? basic.textTruncated : undefined,
        fingerprint: basic.fingerprint,
        style: basic.style,
        headingLevel: basic.headingLevel,
        kind: basic.kind,
        font: captureProps(range?.Font, FONT_KEYS),
        paragraph: captureProps(range?.ParagraphFormat, PARA_KEYS),
        list: captureProps(listFormat, LIST_KEYS),
        table: tableContextForRange(range, tableRanges)
      });
    }
    const grouped = options.groupSimilar !== false;
    return {
      version: VERSION,
      documentFingerprint: fp.fingerprint,
      requested: resolved.requested,
      count: records.length,
      truncated: resolved.truncated,
      grouped,
      groups: grouped ? groupFormatRecords(records) : undefined,
      paragraphs: grouped ? undefined : records
    };
  }

  global.WpsAiWriterInspector = {
    version: VERSION,
    buildDocumentMap,
    readByAnchor,
    readParagraphFormat,
    _internal: {
      clampInt,
      cleanText,
      normalizeValue,
      parseParagraphAnchor,
      stableSerialize,
      fnv1a,
      groupFormatRecords,
      resolveAnchorRange
    }
  };
})(window);
