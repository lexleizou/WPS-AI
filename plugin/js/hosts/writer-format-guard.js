(function attachWriterFormatGuard(global) {
  "use strict";

  // LINGXI_WRITER_FORMAT_GUARD_V1
  const VERSION = 1;
  const AUDIT_TTL_MS = 15 * 60 * 1000;
  const EPSILON = 0.01;
  const LINE_RULES = Object.freeze({ single: 0, oneAndHalf: 1, double: 2, atLeast: 3, exactly: 4, multiple: 5 });
  const NUMERIC_FIELDS = Object.freeze({
    fontSize: ["font", "Size"],
    lineSpacing: ["paragraph", "LineSpacing"],
    alignment: ["paragraph", "Alignment"],
    spaceBefore: ["paragraph", "SpaceBefore"],
    spaceAfter: ["paragraph", "SpaceAfter"],
    characterUnitFirstLineIndent: ["paragraph", "CharacterUnitFirstLineIndent"],
    characterUnitLeftIndent: ["paragraph", "CharacterUnitLeftIndent"],
    characterUnitRightIndent: ["paragraph", "CharacterUnitRightIndent"],
    firstLineIndent: ["paragraph", "FirstLineIndent"],
    leftIndent: ["paragraph", "LeftIndent"],
    rightIndent: ["paragraph", "RightIndent"]
  });
  const audits = new Map();
  let auditCounter = 0;

  async function getApplication() {
    const app = global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
    if (!app) throw new Error("未获取到 WPS Application。");
    return app;
  }

  async function getDocument() {
    const bound = global.WpsAiDocumentMutation?.getBoundDocument?.() || null;
    if (bound) return bound;
    const app = await getApplication();
    const document = app.ActiveDocument || global.WpsAiDocument?.getActiveDocument?.();
    const resolved = document && typeof document.then === "function" ? await document : document;
    if (!resolved) throw new Error("未获取到当前 WPS 文字文档。");
    return resolved;
  }

  function countOf(collection) { try { return Math.max(0, Number(collection?.Count) || 0); } catch (error) { return 0; } }
  function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  function closeEnough(left, right) { const a = numberOrNull(left), b = numberOrNull(right); return a != null && b != null && Math.abs(a - b) <= EPSILON; }
  function safeRead(object, key) {
    try {
      const value = object?.[key];
      if (typeof value === "function") return null;
      return Number(value) === 9999999 ? "mixed" : value;
    } catch (error) { return null; }
  }
  function safeWrite(object, key, value) {
    try { object[key] = value; return { ok: true }; }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  }
  function cleanFontName(value) { return String(value == null ? "" : value).trim(); }
  function normalizeText(value) { return String(value == null ? "" : value).replace(/[\r\n\v\x07]+$/g, "").replace(/\x07/g, ""); }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const text = String(value == null ? "" : value);
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash.toString(16).padStart(8, "0");
  }

  async function documentFingerprint(document) {
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const count = countOf(paragraphs);
    const picks = [];
    for (const index of Array.from(new Set([1, Math.max(1, Math.ceil(count / 2)), count]))) {
      if (index < 1 || index > count) continue;
      try { picks.push(normalizeText(paragraphs.Item(index)?.Range?.Text).slice(0, 160)); } catch (error) { picks.push(""); }
    }
    let name = "", contentLength = 0;
    try { name = String(document?.Name || ""); } catch (error) {}
    try { contentLength = String(document?.Content?.Text || "").length; } catch (error) {}
    return fnv1a(JSON.stringify({ name, count, contentLength, tables: countOf(document?.Tables), sections: countOf(document?.Sections), picks }));
  }

  function parseAnchor(anchor) {
    const match = /^§([1-9]\d*)$/.exec(String(anchor || "").trim());
    if (!match) throw new Error(`无效段落锚点：${anchor || "(空)"}，应为 §N。`);
    return Number(match[1]);
  }

  function normalizeRequirements(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const normalized = {};
    if (source.fontName != null) {
      const name = cleanFontName(source.fontName);
      if (!name) throw new Error("fontName 不能为空。");
      normalized.fontName = name;
    }
    if (source.lineSpacingRule != null) {
      const rule = String(source.lineSpacingRule);
      if (!(rule in LINE_RULES)) throw new Error("lineSpacingRule 必须为 single/oneAndHalf/double/atLeast/exactly/multiple。");
      normalized.lineSpacingRule = rule;
    }
    for (const field of Object.keys(NUMERIC_FIELDS)) {
      if (field === "alignment") continue;
      if (source[field] == null) continue;
      const value = numberOrNull(source[field]);
      if (value == null) throw new Error(`${field} 必须为数值。`);
      normalized[field] = value;
    }
    if (source.alignment != null) {
      const map = { left: 0, center: 1, right: 2, justify: 3, distribute: 4 };
      const value = typeof source.alignment === "string" ? map[source.alignment] : numberOrNull(source.alignment);
      if (value == null || value < 0 || value > 4) throw new Error("alignment 必须为 left/center/right/justify/distribute。");
      normalized.alignment = value;
    }
    // 明确设置点值缩进即表示以 point 为权威；未显式给 CharacterUnit 时自动补 0，
    // 避免 WPS 的字符单位属性静默覆盖 LeftIndent/FirstLineIndent。
    if (source.leftIndent != null && source.characterUnitLeftIndent == null) normalized.characterUnitLeftIndent = 0;
    if (source.rightIndent != null && source.characterUnitRightIndent == null) normalized.characterUnitRightIndent = 0;
    if (source.firstLineIndent != null && source.characterUnitFirstLineIndent == null) normalized.characterUnitFirstLineIndent = 0;
    if (!Object.keys(normalized).length) throw new Error("requirements 至少指定一个字体或段落格式字段。");
    return normalized;
  }

  function requirementSummary(requirements) {
    const output = { ...requirements };
    if (output.alignment != null) output.alignment = ["left", "center", "right", "justify", "distribute"][output.alignment] || output.alignment;
    return output;
  }

  function indexesForScope(options, paragraphCount) {
    const max = Math.max(1, Math.min(5000, Math.floor(numberOrNull(options.maxParagraphs) || paragraphCount || 1)));
    let indexes = [];
    if (Array.isArray(options.anchors) && options.anchors.length) {
      indexes = [...new Set(options.anchors.map(parseAnchor))].sort((a, b) => a - b);
    } else if (options.startAnchor != null) {
      const from = parseAnchor(options.startAnchor), to = options.endAnchor != null ? parseAnchor(options.endAnchor) : from;
      if (from > to) throw new Error("锚点范围无效：起点在终点之后。");
      for (let index = from; index <= to; index += 1) indexes.push(index);
    } else {
      for (let index = 1; index <= paragraphCount; index += 1) indexes.push(index);
    }
    indexes = indexes.filter((index) => index >= 1 && index <= paragraphCount);
    if (!indexes.length) throw new Error("没有可审计的有效段落。");
    const requested = indexes.length;
    return { indexes: indexes.slice(0, max), requested, truncated: requested > max };
  }

  function isInTable(range) { try { return !!range?.Information?.(12); } catch (error) { return false; } }

  function paragraphSnapshot(paragraph, index) {
    const range = paragraph?.Range;
    const font = range?.Font;
    const paragraphFormat = range?.ParagraphFormat;
    return {
      index,
      anchor: `§${index}`,
      range,
      inTable: isInTable(range),
      identity: fnv1a([index, safeRead(range, "Start"), safeRead(range, "End"), normalizeText(range?.Text)].join("|")),
      text: normalizeText(range?.Text).replace(/[\r\n\v]+/g, " ").trim().slice(0, 120),
      font: {
        Name: cleanFontName(safeRead(font, "Name")),
        NameFarEast: cleanFontName(safeRead(font, "NameFarEast")),
        NameAscii: cleanFontName(safeRead(font, "NameAscii")),
        NameOther: cleanFontName(safeRead(font, "NameOther")),
        Size: safeRead(font, "Size")
      },
      paragraph: {
        Alignment: safeRead(paragraphFormat, "Alignment"),
        LineSpacing: safeRead(paragraphFormat, "LineSpacing"),
        LineSpacingRule: safeRead(paragraphFormat, "LineSpacingRule"),
        SpaceBefore: safeRead(paragraphFormat, "SpaceBefore"),
        SpaceAfter: safeRead(paragraphFormat, "SpaceAfter"),
        CharacterUnitFirstLineIndent: safeRead(paragraphFormat, "CharacterUnitFirstLineIndent"),
        CharacterUnitLeftIndent: safeRead(paragraphFormat, "CharacterUnitLeftIndent"),
        CharacterUnitRightIndent: safeRead(paragraphFormat, "CharacterUnitRightIndent"),
        FirstLineIndent: safeRead(paragraphFormat, "FirstLineIndent"),
        LeftIndent: safeRead(paragraphFormat, "LeftIndent"),
        RightIndent: safeRead(paragraphFormat, "RightIndent")
      }
    };
  }

  function diffSnapshot(snapshot, requirements) {
    const diff = {};
    if (requirements.fontName != null) {
      const names = ["Name", "NameFarEast", "NameAscii", "NameOther"];
      const differing = names.filter((key) => snapshot.font[key] && snapshot.font[key] !== requirements.fontName);
      if (differing.length || !names.some((key) => snapshot.font[key] === requirements.fontName)) diff.fontName = differing.length ? differing : ["Name", "NameFarEast"];
    }
    if (requirements.lineSpacingRule != null && Number(snapshot.paragraph.LineSpacingRule) !== LINE_RULES[requirements.lineSpacingRule]) diff.lineSpacingRule = true;
    for (const [field, [section, key]] of Object.entries(NUMERIC_FIELDS)) {
      if (field === "alignment" || requirements[field] == null) continue;
      if (!closeEnough(snapshot[section][key], requirements[field])) diff[field] = true;
    }
    if (requirements.alignment != null && Number(snapshot.paragraph.Alignment) !== requirements.alignment) diff.alignment = true;
    return diff;
  }

  function diffSignature(diff) { return JSON.stringify(Object.keys(diff).sort().map((key) => [key, Array.isArray(diff[key]) ? diff[key].slice().sort() : true])); }

  function groupMismatches(records) {
    const groups = [];
    let current = null;
    for (const record of records) {
      const signature = diffSignature(record.diff);
      const mixedFields = [
        ...Object.entries(record.font).filter(([, value]) => value === "mixed").map(([key]) => `font.${key}`),
        ...Object.entries(record.paragraph).filter(([, value]) => value === "mixed").map(([key]) => `paragraph.${key}`)
      ];
      if (!current || current.lastIndex + 1 !== record.index || current.signature !== signature) {
        current = { startAnchor: record.anchor, endAnchor: record.anchor, count: 1, lastIndex: record.index, signature, differences: Object.keys(record.diff), mixedFields, sampleTexts: record.text ? [record.text] : [] };
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

  function pruneAudits() {
    const now = Date.now();
    audits.forEach((audit, id) => { if (now - audit.createdAt > AUDIT_TTL_MS) audits.delete(id); });
  }

  async function auditParagraphFormat(options = {}) {
    pruneAudits();
    const requirements = normalizeRequirements(options.requirements);
    const document = await getDocument();
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const fingerprint = await documentFingerprint(document);
    const resolved = indexesForScope(options, countOf(paragraphs));
    const includeTables = options.includeTables !== false;
    const mismatches = [];
    let checkedCount = 0, matchedCount = 0, skippedCount = 0;
    for (const index of resolved.indexes) {
      const paragraph = paragraphs.Item(index);
      const snapshot = paragraphSnapshot(paragraph, index);
      if (!includeTables && snapshot.inTable) { skippedCount += 1; continue; }
      checkedCount += 1;
      const diff = diffSnapshot(snapshot, requirements);
      if (Object.keys(diff).length) mismatches.push({ ...snapshot, diff });
      else matchedCount += 1;
    }
    const id = `fmt-audit-${Date.now().toString(36)}-${(++auditCounter).toString(36)}`;
    audits.set(id, {
      id, createdAt: Date.now(), fingerprint, requirements, indexes: resolved.indexes, includeTables,
      paragraphIdentities: Object.fromEntries([...mismatches, ...resolved.indexes.map((index) => {
        try {
          const snapshot = paragraphSnapshot(paragraphs.Item(index), index);
          return includeTables || !snapshot.inTable ? [String(index), snapshot.identity] : null;
        } catch (error) { return null; }
      }).filter(Boolean)].map((record) => Array.isArray(record) ? record : [String(record.index), record.identity]))
    });
    return {
      auditId: id,
      expiresInSeconds: Math.floor(AUDIT_TTL_MS / 1000),
      documentFingerprint: fingerprint,
      requirements: requirementSummary(requirements),
      requestedCount: resolved.requested,
      checkedCount,
      matchedCount,
      mismatchCount: mismatches.length,
      skippedCount,
      truncated: resolved.truncated,
      mismatchGroups: groupMismatches(mismatches)
    };
  }

  function applyDiff(snapshot, requirements, diff) {
    const range = snapshot.range;
    const font = range?.Font;
    const paragraphFormat = range?.ParagraphFormat;
    const applied = [], failed = [];
    function write(target, key, value, label) {
      const result = safeWrite(target, key, value);
      if (!result.ok) {
        failed.push({ field: label, expected: value, error: result.error });
        return;
      }
      const actual = safeRead(target, key);
      if (typeof value === "number" ? closeEnough(actual, value) : actual === value) applied.push(label);
      else failed.push({ field: label, expected: value, actual });
    }
    if (diff.fontName) {
      const names = Array.isArray(diff.fontName) ? diff.fontName : ["Name", "NameFarEast"];
      names.forEach((key) => write(font, key, requirements.fontName, `font.${key}`));
    }
    if (diff.fontSize) write(font, "Size", requirements.fontSize, "font.Size");
    if (diff.lineSpacingRule) write(paragraphFormat, "LineSpacingRule", LINE_RULES[requirements.lineSpacingRule], "paragraph.LineSpacingRule");
    // WPS 同时维护字符单位和点值缩进；字符单位非零时，直接写 LeftIndent/FirstLineIndent
    // 可能被静默恢复。先清字符单位，再写点值，并逐字段即时回读。
    const keys = {
      characterUnitFirstLineIndent: "CharacterUnitFirstLineIndent",
      characterUnitLeftIndent: "CharacterUnitLeftIndent",
      characterUnitRightIndent: "CharacterUnitRightIndent",
      lineSpacing: "LineSpacing", alignment: "Alignment", spaceBefore: "SpaceBefore", spaceAfter: "SpaceAfter",
      leftIndent: "LeftIndent", rightIndent: "RightIndent", firstLineIndent: "FirstLineIndent"
    };
    Object.entries(keys).forEach(([field, key]) => { if (diff[field]) write(paragraphFormat, key, requirements[field], `paragraph.${key}`); });
    return { applied, failed };
  }

  async function applyParagraphFormatMismatches(options = {}) {
    pruneAudits();
    const auditId = String(options.auditId || "").trim();
    const audit = audits.get(auditId);
    if (!audit) throw new Error("FORMAT_AUDIT_NOT_FOUND：审计不存在或已过期，请重新调用 wps_audit_paragraph_format。");
    if (String(options.expectedDocumentFingerprint || "") !== audit.fingerprint) throw new Error("STALE_FORMAT_AUDIT：文档指纹不匹配，请重新审计后再修改。");
    const document = await getDocument();
    const fingerprint = await documentFingerprint(document);
    if (fingerprint !== audit.fingerprint) throw new Error("STALE_DOCUMENT_MAP：文档内容已变化，请重新审计后再修改。");
    const paragraphs = document?.Paragraphs || document?.Content?.Paragraphs;
    const changed = [], skippedAsAlreadyMatching = [], failedParagraphs = [], groups = [];
    let currentGroup = null;
    for (const index of audit.indexes) {
      const paragraph = paragraphs.Item(index);
      const snapshot = paragraphSnapshot(paragraph, index);
      if (!audit.includeTables && snapshot.inTable) continue;
      if (audit.paragraphIdentities?.[String(index)] !== snapshot.identity) {
        throw new Error(`STALE_FORMAT_AUDIT：${snapshot.anchor} 的内容或位置已变化，请重新审计后再修改。`);
      }
      const diff = diffSnapshot(snapshot, audit.requirements);
      if (!Object.keys(diff).length) { skippedAsAlreadyMatching.push(snapshot.anchor); continue; }
      const writeResult = applyDiff(snapshot, audit.requirements, diff);
      if (!writeResult.applied.length) throw new Error(`FORMAT_APPLY_FAILED：${snapshot.anchor} 没有任何格式字段成功写入。`);
      // 必须在本段全部字段写完后再完整回读一次：后写的点值可能让 WPS 重新计算 CharacterUnit，
      // 只做逐字段即时回读仍可能产生“先成功、最后又被覆盖”的假成功。
      const verifiedSnapshot = paragraphSnapshot(paragraph, index);
      const remaining = diffSnapshot(verifiedSnapshot, audit.requirements);
      Object.keys(remaining).forEach((field) => {
        if (writeResult.failed.some((item) => item.field === field)) return;
        const mapping = NUMERIC_FIELDS[field];
        const actual = field === "fontName"
          ? verifiedSnapshot.font.name
          : (field === "lineSpacingRule"
            ? verifiedSnapshot.paragraph.LineSpacingRule
            : (mapping?.[0] === "font" ? verifiedSnapshot.font[mapping[1]] : verifiedSnapshot.paragraph[mapping?.[1]]));
        writeResult.failed.push({ field, expected: audit.requirements[field], actual, phase: "finalReadback" });
      });
      changed.push({ anchor: snapshot.anchor, appliedFields: writeResult.applied, failedFields: writeResult.failed });
      if (writeResult.failed.length) failedParagraphs.push({ anchor: snapshot.anchor, failedFields: writeResult.failed });
      const signature = JSON.stringify(writeResult.applied);
      if (!currentGroup || currentGroup.lastIndex + 1 !== index || currentGroup.signature !== signature) {
        currentGroup = { startAnchor: snapshot.anchor, endAnchor: snapshot.anchor, count: 1, lastIndex: index, signature, appliedFields: writeResult.applied };
        groups.push(currentGroup);
      } else { currentGroup.endAnchor = snapshot.anchor; currentGroup.count += 1; currentGroup.lastIndex = index; }
    }
    audits.delete(auditId);
    return {
      auditId,
      changedParagraphs: changed.length,
      changed,
      skippedAsAlreadyMatching: skippedAsAlreadyMatching.length,
      skippedAnchors: skippedAsAlreadyMatching,
      changedGroups: groups.map(({ lastIndex, signature, ...group }) => group),
      // 供写入后的非破坏性视图跟随使用；审计工具绝不会返回该字段。
      // 格式写入不改变段落文本/范围，因此首末锚点仍可稳定定位刚完成的改动。
      followTarget: changed.length ? {
        kind: "paragraphRange",
        startAnchor: changed[0].anchor,
        endAnchor: changed[changed.length - 1].anchor,
        anchors: changed.map((item) => item.anchor)
      } : null,
      failedParagraphs,
      partialFailure: failedParagraphs.length > 0,
      verificationRequired: true,
      nextStep: failedParagraphs.length ? "部分字段写入失败；请先报告 failedParagraphs，再重新审计，不得声称已完成。" : "请再次调用 wps_audit_paragraph_format，以确认 remaining mismatchCount 为 0。"
    };
  }

  global.WpsAiWriterFormatGuard = {
    version: VERSION,
    auditParagraphFormat,
    applyParagraphFormatMismatches,
    _internal: { normalizeRequirements, diffSnapshot, groupMismatches, applyDiff, documentFingerprint, audits, LINE_RULES }
  };
})(window);
