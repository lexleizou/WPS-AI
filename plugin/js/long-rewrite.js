(function attachLongRewrite(global) {
  "use strict";

  const DEFAULT_MAX_CHARS = 6000;
  const DEFAULT_MAX_PARAGRAPHS = 40;

  // 把带 headingLevel 的段落清单切成"节"。标题起新节；非正文段（表格/图片/空段）
  // 断节且不进任何节（保留不动）；同一标题下正文超预算再切子节。
  function splitSections(segments, opts = {}) {
    const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    const maxParagraphs = opts.maxParagraphs || DEFAULT_MAX_PARAGRAPHS;
    const list = Array.isArray(segments) ? segments : [];
    const sections = [];
    let cur = null;
    let curHeading = null;
    let curLevel = 0;

    function flush() {
      if (cur && cur.paragraphs.length) sections.push(cur);
      cur = null;
    }
    function open(heading, level, seg) {
      cur = {
        heading, headingLevel: level,
        charStart: seg.start, charEnd: seg.end,
        paragraphs: [seg.text],
        segStartIdx: seg.idx, segEndIdx: seg.idx
      };
    }

    for (const seg of list) {
      if (!seg || seg.kind !== "paragraph") { flush(); continue; }
      const level = Number(seg.headingLevel) || 0;
      if (level >= 1) {                 // 标题 → 起新节，标题本身作为该节首段
        flush();
        curHeading = String(seg.text || "").trim() || null;
        curLevel = level;
        open(curHeading, curLevel, seg);
        continue;
      }
      if (!cur) { open(curHeading, curLevel, seg); continue; }
      const projected = cur.charEnd - cur.charStart + (seg.text || "").length;
      if (cur.paragraphs.length >= maxParagraphs || projected > maxChars) {
        flush();
        open(curHeading, curLevel, seg);   // 子节沿用当前标题
        continue;
      }
      cur.paragraphs.push(seg.text);
      cur.charEnd = seg.end;
      cur.segEndIdx = seg.idx;
    }
    flush();
    return sections;
  }

  function buildOutline(sections) {
    return (Array.isArray(sections) ? sections : [])
      .filter((s) => s && s.heading)
      .map((s) => ({ level: Number(s.headingLevel) || 1, text: String(s.heading) }));
  }

  function buildSpine({ title, outline, requirement, glossary, tone } = {}) {
    const lines = [];
    lines.push("你是资深中文文档改写助手。你每次只会拿到全文中的【一节】，请只改写这一节的正文，");
    lines.push("保持与全文主题、术语、语气一致；不要输出其它节的内容，不要添加解释。");
    lines.push('只输出 raw JSON：{"blocks":[{"type":"paragraph|heading","level":1,"text":"改写后的文本"}]}。');
    if (title) lines.push(`【全文标题】${title}`);
    if (Array.isArray(outline) && outline.length) {
      lines.push("【全文大纲】");
      for (const it of outline) lines.push(`  ${"#".repeat(Math.max(1, Math.min(3, it.level || 1)))} ${it.text}`);
    }
    if (glossary) lines.push(`【术语表】${glossary}`);
    if (tone) lines.push(`【语气基调】${tone}`);
    if (requirement) lines.push(`【改写要求】${requirement}`);
    return lines.join("\n");
  }

  function updateRollingSummary(prev, result, opts = {}) {
    const limit = opts.limit || 1200;
    const head = result && result.heading ? result.heading : `第${(result?.index ?? 0) + 1}节`;
    const gist = (result?.blocks || []).map((b) => String(b?.text || "")).join("").slice(0, 80);
    const line = `- ${head}：${gist}`;
    let s = (prev ? prev + "\n" : "") + line;
    if (s.length > limit) s = s.slice(s.length - limit);   // 保留最近
    return s;
  }

  async function run({ model, requirement, title, parseJson, onProgress, shouldStop, opts } = {}) {
    const W = global.WpsAiHostWriter;
    if (!W || !W.readDocumentSections) throw new Error("当前宿主不支持长文改写。");
    const parse = parseJson || JSON.parse;
    const { segments } = await W.readDocumentSections();
    const sections = splitSections(segments, opts || {});
    const outline = buildOutline(sections);
    const spine = buildSpine({ title, outline, requirement });
    const results = [];
    let failed = 0;
    let rolling = "";
    for (let i = 0; i < sections.length; i += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        return { sections, results, failed, stopped: true };
      }
      const sec = sections[i];
      const sys = rolling ? `${spine}\n【前文已改写要点】\n${rolling}` : spine;
      const messages = [
        { role: "system", content: sys },
        { role: "user", content: `请改写下面这一节（保持段落切分）：\n\n${sec.paragraphs.join("\n")}` }
      ];
      let result;
      try {
        const raw = await global.WpsAiOpenAI.chatCompletion({ model: model || undefined, messages, temperature: 0.3 });
        const parsed = parse(String(raw || "").trim());
        const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : null;
        if (!blocks || !blocks.length) throw new Error("模型未返回 blocks");
        result = { index: i, heading: sec.heading, ok: true, blocks, charStart: sec.charStart, charEnd: sec.charEnd };
        rolling = updateRollingSummary(rolling, result);
      } catch (e) {
        failed += 1;
        result = { index: i, heading: sec.heading, ok: false, blocks: null, error: String(e && e.message || e), charStart: sec.charStart, charEnd: sec.charEnd };
      }
      results.push(result);
      if (typeof onProgress === "function") onProgress(i + 1, sections.length);
    }
    return { sections, results, failed, stopped: false };
  }

  // 写回排序（纯函数）：只留 ok===true 且 blocks 是数组的结果，按 charStart 降序（自底向上）——
  // 后面的节先写回，不影响前面节的字符 offset。
  function orderResultsForWriteback(results) {
    return (Array.isArray(results) ? results : [])
      .filter((r) => r && r.ok === true && Array.isArray(r.blocks))
      .slice()
      .sort((a, b) => b.charStart - a.charStart);
  }

  const VALID_OPS = new Set(["keep", "move", "merge", "split"]);
  function parseStructurePlan(raw, sectionCount) {
    let obj;
    try { obj = JSON.parse(String(raw || "").trim()); } catch (e) { return null; }
    const arr = Array.isArray(obj?.plan) ? obj.plan : null;
    if (!arr) return null;
    return arr.filter((it) => it && VALID_OPS.has(it.op)
      && Number.isInteger(it.from) && it.from >= 0 && it.from < sectionCount
      && (it.to == null || (Number.isInteger(it.to) && it.to >= 0 && it.to <= sectionCount)))
      .map((it) => ({ op: it.op, from: it.from, ...(it.to != null ? { to: it.to } : {}) }));
  }
  async function planStructure({ model, outline, requirement, parseJson } = {}) {
    const sys = '你规划章节级结构调整。基于大纲输出 raw JSON：{"plan":[{"op":"keep|move","from":<节序号>}]}。'
      + '不改正文，只排结构。plan 数组必须按【最终期望顺序】依次列出条目：数组的第 1 项就是调整后的第 1 节，'
      + '第 2 项就是第 2 节，以此类推——顺序完全由数组次序决定，不要用 to 字段表达顺序（顺序信息会被忽略）。'
      + 'from = 该章节在原大纲中的原始序号（0-based，按下方大纲编号）。未提及的章节保留在原位置对应的相对顺序，'
      + '需要挪动的章节用 move，不挪动的用 keep。';
    const body = (outline || []).map((it, i) => `[${i}] ${"#".repeat(it.level || 1)} ${it.text}`).join("\n");
    let raw;
    try { raw = await global.WpsAiOpenAI.chatCompletion({ model: model || undefined, messages: [{ role: "system", content: sys }, { role: "user", content: `要求：${requirement}\n\n大纲：\n${body}` }], temperature: 0.2 }); }
    catch (e) { return null; }
    return parseStructurePlan(raw, (outline || []).length);
  }

  // 把结构 plan 编译成搬动序列：按 plan 出现顺序给出 targetOrder，附每节区间 + 唯一书签名。
  // 只处理 keep/move（merge/split 暂不支持整块搬动，过滤掉）。宿主（writer.js）拿这份清单先
  // 给每节区间打书签（addBookmarkAtRange），再按 targetOrder 用书签定位重排（reorderSectionsByBookmarks）。
  //
  // p.from 是 planStructure 让模型基于 buildOutline(sections) 编号的下标——buildOutline 只保留
  // 有 heading 的节（0-based）。所以这里必须对同一份「heading 过滤后」的清单取下标，不能直接用
  // 传入的完整 sections（其中可能含首个标题前的正文等无 heading 节，下标会错位、搬错节）。
  function compileStructureMoves(plan, sections) {
    const outlineSections = (Array.isArray(sections) ? sections : []).filter((s) => s && s.heading);
    const list = Array.isArray(plan) ? plan.filter((p) => p.op === "keep" || p.op === "move") : [];
    return list.map((p, order) => {
      const sec = outlineSections[p.from];
      if (!sec) return null;
      // heading 带上，供 reorderSectionsByBookmarks 的缺书签兜底做"按标题文字重定位"。
      // sections[].heading 由 splitSections 产出；缺省为 null（无标题节）。
      return { name: `lrw_sec_${p.from}`, charStart: sec.charStart, charEnd: sec.charEnd, targetOrder: order, heading: sec.heading };
    }).filter(Boolean);
  }

  global.WpsAiLongRewrite = {
    splitSections, buildOutline, buildSpine, updateRollingSummary, run,
    orderResultsForWriteback, parseStructurePlan, planStructure, compileStructureMoves
  };
})(typeof window !== "undefined" ? window : this);
