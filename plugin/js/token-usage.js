(function attachTokenUsage(global) {
  "use strict";

  // AI token 用量：按 provider::model 聚合持久化 + 本会话小计。
  // 每次 record 都 read-modify-write，避免 4 宿主共享同一 localStorage 时整表覆盖丢数据。
  const STORAGE_KEY = "lingxi_token_usage_v1";
  const listeners = new Set();
  const session = { input: 0, output: 0, total: 0, calls: 0 };

  function loadAll() {
    try {
      const raw = global.WpsAiStore.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) { return {}; }
  }
  function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function normalizeTs(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function startOfLocalDay(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function addLocalDays(dayStart, offset) {
    const d = new Date(dayStart);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
  }
  function normalizeDays(opts) {
    const raw = opts && opts.days;
    if (raw == null || raw === "" || raw === "all") return null;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function rowFromEntry(e) {
    e = e || {};
    return {
      model: String(e.model || "unknown"),
      provider: String(e.provider || "unknown"),
      input: Number(e.input) || 0,
      output: Number(e.output) || 0,
      total: Number(e.total) || 0,
      calls: Number(e.calls) || 0,
      lastAt: Number(e.lastAt) || 0
    };
  }
  function sortRows(rows) {
    return rows.sort((a, b) => (b.total - a.total) || (b.lastAt - a.lastAt));
  }
  function getDailyMap(map) {
    return isObj(map && map.__daily) ? map.__daily : {};
  }
  function mergeRowsByModel(days) {
    const byKey = {};
    days.forEach((day) => {
      const models = isObj(day.models) ? day.models : {};
      Object.keys(models).forEach((key) => {
        const r = rowFromEntry(models[key]);
        const cur = byKey[key] || { provider: r.provider, model: r.model, input: 0, output: 0, total: 0, calls: 0, lastAt: 0 };
        cur.provider = r.provider;
        cur.model = r.model;
        cur.input += r.input;
        cur.output += r.output;
        cur.total += r.total;
        cur.calls += r.calls;
        cur.lastAt = Math.max(cur.lastAt, r.lastAt);
        byKey[key] = cur;
      });
    });
    return sortRows(Object.keys(byKey).map((key) => byKey[key]));
  }

  function getDailyBreakdown(opts = {}) {
    const map = loadAll();
    const daily = getDailyMap(map);
    const days = normalizeDays(opts);
    const now = normalizeTs(opts.now);
    if (days) {
      const todayStart = startOfLocalDay(now);
      const rows = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const ts = addLocalDays(todayStart, -i);
        const key = dayKey(ts);
        const e = isObj(daily[key]) ? daily[key] : {};
        rows.push({
          date: key,
          input: Number(e.input) || 0,
          output: Number(e.output) || 0,
          total: Number(e.total) || 0,
          calls: Number(e.calls) || 0,
          lastAt: Number(e.lastAt) || 0,
          models: isObj(e.models) ? e.models : {}
        });
      }
      return rows;
    }
    return Object.keys(daily).sort().map((key) => {
      const e = isObj(daily[key]) ? daily[key] : {};
      return {
        date: key,
        input: Number(e.input) || 0,
        output: Number(e.output) || 0,
        total: Number(e.total) || 0,
        calls: Number(e.calls) || 0,
        lastAt: Number(e.lastAt) || 0,
        models: isObj(e.models) ? e.models : {}
      };
    });
  }

  // 修 Critical 1：每次 record 只提交"本次增量"给服务端原子累加（mergeObject add 模式），
  // 数值叶子（input/output/total/calls）逐一相加、lastAt 取 max、model/provider 覆盖，
  // 这样 4 宿主并发计数是"求和"而不是"整表覆盖丢数"。fire-and-forget；返回后再 notify 一次
  // 让持久化明细刷新（本会话小计已同步更新）。
  function record({ provider, model, input, output, ts: recordTs } = {}) {
    const inTok = Math.max(0, Number(input) || 0);
    const outTok = Math.max(0, Number(output) || 0);
    if (inTok === 0 && outTok === 0) return;
    const mdl = String(model || "unknown");
    const prov = String(provider || "unknown");
    const key = prov + "::" + mdl;
    const ts = normalizeTs(recordTs);
    const date = dayKey(ts);
    const row = { model: mdl, provider: prov, input: inTok, output: outTok, total: inTok + outTok, calls: 1, lastAt: ts };
    const patch = {
      [key]: row,
      __daily: {
        [date]: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
          calls: 1,
          lastAt: ts,
          models: { [key]: row }
        }
      }
    };
    try {
      const p = global.WpsAiStore.mergeObject(STORAGE_KEY, patch, "add");
      Promise.resolve(p).then(() => notify()).catch(() => {});
    } catch (e) {}
    session.input += inTok;
    session.output += outTok;
    session.total = session.input + session.output;
    session.calls += 1;
    notify();
  }

  function getBreakdown(opts = {}) {
    const map = loadAll();
    if (normalizeDays(opts)) return mergeRowsByModel(getDailyBreakdown(opts));
    return sortRows(Object.keys(map)
      .filter((k) => k.charAt(0) !== "_")
      .map((k) => rowFromEntry(map[k])));
  }

  function getTotals(opts = {}) {
    return getBreakdown(opts).reduce((acc, e) => {
      acc.input += e.input; acc.output += e.output; acc.total += e.total; acc.calls += e.calls;
      return acc;
    }, { input: 0, output: 0, total: 0, calls: 0 });
  }

  function getSession() {
    return { input: session.input, output: session.output, total: session.total, calls: session.calls };
  }

  function clear() {
    try { global.WpsAiStore.removeItem(STORAGE_KEY); } catch (e) {}
    session.input = 0; session.output = 0; session.total = 0; session.calls = 0;
    notify();
  }

  function onChange(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }
  function offChange(fn) { listeners.delete(fn); }

  global.WpsAiTokenUsage = { record, getBreakdown, getTotals, getSession, getDailyBreakdown, clear, onChange, offChange };
})(window);
