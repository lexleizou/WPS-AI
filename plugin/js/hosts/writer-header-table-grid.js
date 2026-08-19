(function (g) {
  "use strict";
  const MARKER = "LINGXI_WRITER_HEADER_TABLE_GRID_V2";
  const HEADER_INDEX = Object.freeze({ primary: 1, firstPage: 2, evenPages: 3 });

  async function documentOf() {
    const app = g.WpsAiAddon?.getApplication ? await g.WpsAiAddon.getApplication() : g.Application;
    const raw = app?.ActiveDocument || g.WpsAiDocument?.getActiveDocument?.();
    const document = raw && typeof raw.then === "function" ? await raw : raw;
    if (!document) throw new Error("未获取到当前 WPS 文字文档。");
    return document;
  }
  function count(value) { return Math.max(0, Number(value?.Count) || 0); }
  function item(collection, index, label) {
    if (!Number.isInteger(index) || index < 1 || index > count(collection)) throw new Error(`${label}不存在：${index}`);
    const value = collection.Item(index);
    if (!value) throw new Error(`无法读取${label}：${index}`);
    return value;
  }
  function clean(value) { return String(value || "").replace(/[\r\n\x07]+/g, " ").trim(); }
  function hash(value) {
    let result = 2166136261;
    for (const char of JSON.stringify(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return (result >>> 0).toString(16);
  }
  function kindOf(value) {
    const kind = String(value || "primary");
    if (!HEADER_INDEX[kind]) throw new Error("headerKind 必须为 primary/firstPage/evenPages。");
    return kind;
  }
  function headerAt(document, sectionIndex, headerKind) {
    const section = item(document.Sections, sectionIndex, "节");
    const header = item(section.Headers, HEADER_INDEX[headerKind], "页眉");
    return { section, header };
  }
  function ownerOf(document, sectionIndex, headerKind) {
    let ownerSectionIndex = sectionIndex;
    let located = headerAt(document, ownerSectionIndex, headerKind);
    const linked = !!located.header.LinkToPrevious;
    while (ownerSectionIndex > 1 && !!located.header.LinkToPrevious) {
      ownerSectionIndex -= 1;
      located = headerAt(document, ownerSectionIndex, headerKind);
    }
    return { ...located, ownerSectionIndex, isLinkedToPrevious: linked };
  }
  function locate(document, options = {}) {
    const sectionIndex = Number(options.sectionIndex) || 1;
    const headerKind = kindOf(options.headerKind);
    const tableIndex = Number(options.tableIndex) || 1;
    const requested = headerAt(document, sectionIndex, headerKind);
    const owner = ownerOf(document, sectionIndex, headerKind);
    const table = item(owner.header.Range?.Tables, tableIndex, "页眉表格");
    return { sectionIndex, headerKind, tableIndex, requestedHeader: requested.header, ownerHeader: owner.header, ownerSectionIndex: owner.ownerSectionIndex, isLinkedToPrevious: owner.isLinkedToPrevious, table };
  }
  function cellAt(table, rowIndex, columnIndex) {
    try { return table.Cell(rowIndex, columnIndex); }
    catch (error) {
      const row = item(table.Rows, rowIndex, "行");
      const cells = row.Range?.Cells || row.Cells;
      if (cells && count(cells) >= columnIndex) return item(cells, columnIndex, "单元格");
      throw new Error(`无法读取第 ${rowIndex} 行第 ${columnIndex} 列单元格。`);
    }
  }
  function objectInfo(range) {
    let inlineObjects = 0;
    try { inlineObjects = count(range?.InlineShapes); } catch (error) {}
    const raw = String(range?.Text || "");
    return { inlineObjects, hasInlineObjectMarker: raw.includes("\u0001") };
  }
  function rowInfo(table, rowIndex) {
    const cells = [], seen = new Set();
    for (let columnIndex = 1; columnIndex <= count(table.Columns); columnIndex += 1) {
      try {
        const cell = cellAt(table, rowIndex, columnIndex);
        const start = Number(cell.Range?.Start);
        if (seen.has(start)) continue;
        seen.add(start);
        const objects = objectInfo(cell.Range);
        const entry = {
          index: columnIndex,
          text: clean(cell.Range?.Text).slice(0, 300),
          start,
          end: Number(cell.Range?.End),
          horizontalMerge: Number(cell.HorizontalMerge),
          verticalMerge: Number(cell.VerticalMerge),
          ...objects
        };
        entry.fingerprint = hash(entry);
        cells.push(entry);
      } catch (error) {}
    }
    if (!cells.length) throw new Error(`页眉表格第 ${rowIndex} 行无法读取单元格。`);
    return { index: rowIndex, cells, fingerprint: hash(cells) };
  }
  function gridOf(located) {
    const rows = [];
    for (let rowIndex = 1; rowIndex <= count(located.table.Rows); rowIndex += 1) rows.push(rowInfo(located.table, rowIndex));
    return { rows, rowsCount: count(located.table.Rows), columns: count(located.table.Columns), fingerprint: hash(rows) };
  }
  function structureOf(grid) {
    const cellCounts = grid.rows.map((row) => row.cells.length);
    const firstColumn = grid.rows.map((row) => row.cells[0]).filter(Boolean);
    const logo = firstColumn[0] || null;
    const leftStarts = firstColumn.map((cell) => cell.start);
    const verticalMergeEvidence = leftStarts.length === 3 && new Set(leftStarts).size === 1;
    const expectedShape = grid.rowsCount === 3 && grid.columns === 3 && cellCounts.join(",") === "2,2,3";
    const hasLogo = !!logo && (logo.hasInlineObjectMarker || logo.inlineObjects > 0);
    return {
      rows: grid.rowsCount,
      columns: grid.columns,
      cellCounts,
      expectedThreeByThreeShape: expectedShape,
      logoInFirstCell: hasLogo,
      firstColumnStarts: leftStarts,
      verticalMergeEvidence,
      canNormalizeRowsOneOrTwo: grid.rowsCount === 3 && grid.columns === 3 && cellCounts[2] === 3 && (cellCounts[0] === 2 || cellCounts[1] === 2),
      status: expectedShape && hasLogo ? "healthy" : "needs-recovery"
    };
  }
  async function recoveryProfile(options = {}) {
    const document = await documentOf();
    const located = locate(document, options);
    const grid = gridOf(located);
    const headerText = clean(located.ownerHeader.Range?.Text).slice(0, 1000);
    const structure = structureOf(grid);
    const profile = {
      marker: MARKER,
      sectionIndex: located.sectionIndex,
      ownerSectionIndex: located.ownerSectionIndex,
      headerKind: located.headerKind,
      tableIndex: located.tableIndex,
      isLinkedToPrevious: located.isLinkedToPrevious,
      headerText,
      headerTextFingerprint: hash(headerText),
      grid,
      structure
    };
    profile.fingerprint = hash(profile);
    return profile;
  }
  function normalizedExpectedTexts(value) {
    const terms = Array.isArray(value) ? value.map((item) => clean(item)).filter(Boolean) : [];
    if (!terms.length) throw new Error("HEADER_IDENTITY_REQUIRED：页眉写入必须提供来自用户目标的 expectedHeaderText（公司名、标题或文件编号至少一项）。");
    return terms;
  }
  function assertWriteGate(options, profile) {
    if (String(options.expectedRecoveryProfileFingerprint || "") !== String(profile.fingerprint)) {
      throw new Error("STALE_HEADER_RECOVERY_PROFILE：页眉档案已变化，请重新只读审计。");
    }
    const expectedTexts = normalizedExpectedTexts(options.expectedHeaderText);
    if (!expectedTexts.every((term) => profile.headerText.includes(term))) {
      throw new Error("HEADER_IDENTITY_MISMATCH：当前页眉与用户指定的标题/文件编号不一致，已拒绝写入。");
    }
    if (profile.isLinkedToPrevious || profile.ownerSectionIndex !== profile.sectionIndex) {
      throw new Error(`LINKED_HEADER_WRITE_REQUIRES_OWNER：第 ${profile.sectionIndex} 节页眉链接到第 ${profile.ownerSectionIndex} 节；请只对实际所有者节重做审计。`);
    }
  }
  async function grid(options = {}) { return recoveryProfile(options); }
  async function normalize(options = {}) {
    const before = await recoveryProfile(options);
    assertWriteGate(options, before);
    const rowIndex = Number(options.row);
    const referenceRow = Number(options.referenceRow || 3);
    const target = before.grid.rows[rowIndex - 1];
    const reference = before.grid.rows[referenceRow - 1];
    if (!before.structure.canNormalizeRowsOneOrTwo || !target || !reference || target.cells.length !== 2 || reference.cells.length !== 3) {
      throw new Error("HEADER_TABLE_NORMALIZE_PRECONDITION_FAILED：仅允许规范化 3×3 表格中“两格目标行 + 三格参考行”的已审计结构。");
    }
    const protectedLogo = before.grid.rows[0]?.cells[0];
    const protectedText = before.headerText;
    const protectedReference = reference.fingerprint;
    const document = await documentOf();
    const located = locate(document, options);
    try { cellAt(located.table, rowIndex, 2).Split(1, 2); }
    catch (error) { throw new Error(`HEADER_TABLE_NORMALIZE_SPLIT_FAILED：${error?.message || error}`); }
    const expanded = rowInfo(located.table, rowIndex);
    if (expanded.cells.length !== 3) throw new Error("HEADER_TABLE_NORMALIZE_VERIFY_FAILED：补列后目标行不是三格；已停止后续写入。");
    try { cellAt(located.table, rowIndex, 2).Merge(cellAt(located.table, rowIndex, 3)); }
    catch (error) { throw new Error(`HEADER_TABLE_NORMALIZE_MERGE_FAILED：${error?.message || error}`); }
    const after = await recoveryProfile({ sectionIndex: options.sectionIndex, headerKind: options.headerKind, tableIndex: options.tableIndex });
    const afterReference = after.grid.rows[referenceRow - 1];
    const afterLogo = after.grid.rows[0]?.cells[0];
    const verified = after.structure.expectedThreeByThreeShape && after.headerText === protectedText && afterReference?.fingerprint === protectedReference && afterLogo?.start === protectedLogo?.start && afterLogo?.hasInlineObjectMarker === protectedLogo?.hasInlineObjectMarker;
    if (!verified) {
      throw new Error("HEADER_TABLE_NORMALIZE_POSTCHECK_FAILED：写后无法证明 Logo、参考行、文本和 3×3 合并结构均被保留；已停止，禁止继续调整宽度。");
    }
    return { before, after, changed: { row: rowIndex, operation: "split-right-then-merge-2-3" }, verification: { ok: true, protectedLogo, protectedReference } };
  }
  g.WpsAiHeaderTableGrid = { recoveryProfile, grid, normalize, _internal: { structureOf, hash } };
})(window);
