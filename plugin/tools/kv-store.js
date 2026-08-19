"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");

let _db = null;
let _available = null;

function dbPath() {
  if (process.env.LINGXI_KV_DB) return process.env.LINGXI_KV_DB;
  const dir = path.join(os.homedir(), ".lingxi-ai");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return path.join(dir, "lingxi.db");
}

function getDb() {
  if (_db) return _db;
  const { DatabaseSync } = require("node:sqlite"); // 无 flag / 老 Node 会抛 → available()=false
  const db = new DatabaseSync(dbPath());
  try { db.exec("PRAGMA journal_mode=WAL"); } catch (e) {}
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  _db = db;
  return _db;
}

function available() {
  if (_available !== null) return _available;
  try { getDb(); _available = true; } catch (e) { _available = false; }
  return _available;
}

function getAll() {
  const rows = getDb().prepare("SELECT key, value FROM kv").all();
  const items = {};
  for (const r of rows) items[r.key] = r.value;
  return items;
}

function batch({ sets = [], dels = [] } = {}) {
  const db = getDb();
  const now = Date.now();
  const up = db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
  const del = db.prepare("DELETE FROM kv WHERE key=?");
  db.exec("BEGIN");
  try {
    for (const s of sets) { if (s && typeof s.key === "string") up.run(s.key, String(s.value == null ? "" : s.value), now); }
    for (const k of dels) { if (typeof k === "string") del.run(k); }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
  return (sets ? sets.length : 0) + (dels ? dels.length : 0);
}

function isPlainObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

// deep-ish assign：patch 的键覆盖 stored；两边都是普通对象则递归合并（turns 索引场景，同 key 取更新的）
function assignMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    if (isPlainObj(out[k]) && isPlainObj(b[k])) out[k] = assignMerge(out[k], b[k]);
    else out[k] = b[k];
  }
  return out;
}
// add：数值叶子相加（token 计数场景）；lastAt 这类时间戳取 max；字符串叶子（model/provider）按 patch 覆盖
function addMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    const av = out[k], bv = b[k];
    if (typeof av === "number" && typeof bv === "number") out[k] = (k === "lastAt") ? Math.max(av, bv) : av + bv;
    else if (isPlainObj(av) && isPlainObj(bv)) out[k] = addMerge(av, bv);
    else out[k] = bv;
  }
  return out;
}

// 服务端原子 read-modify-write：按 idKey 去重 upsert，冲突时留 tsKey 更大的（incoming 平局胜），整表回写。
// 多宿主共用同一 DB，合并放在这里（DB 的唯一属主）才不会互相覆盖对方的写入。
function mergeList({ key, items = [], idKey = "id", tsKey } = {}) {
  if (typeof key !== "string" || !key) throw new Error("mergeList 缺少 key");
  const db = getDb();
  const now = Date.now();
  db.exec("BEGIN");
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    let cur = [];
    if (row && row.value) { try { const p = JSON.parse(row.value); if (Array.isArray(p)) cur = p; } catch (e) {} }
    const byId = new Map();
    for (const it of cur) { if (it && it[idKey] != null) byId.set(it[idKey], it); }
    for (const it of (Array.isArray(items) ? items : [])) {
      if (!it || it[idKey] == null) continue;
      const prev = byId.get(it[idKey]);
      if (!prev) { byId.set(it[idKey], it); continue; }
      if (!tsKey) { byId.set(it[idKey], it); continue; }
      if ((Number(it[tsKey]) || 0) >= (Number(prev[tsKey]) || 0)) byId.set(it[idKey], it);
    }
    let merged = Array.from(byId.values());
    if (tsKey) merged.sort((a, b) => (Number(a[tsKey]) || 0) - (Number(b[tsKey]) || 0));
    const up = db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    up.run(key, JSON.stringify(merged), now);
    db.exec("COMMIT");
    return merged;
  } catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
}

// 服务端原子对象合并。mode:"assign" → patch 覆盖（turns 索引）；mode:"add" → 数值叶子求和（token 计数）。
function mergeObject({ key, patch = {}, mode = "assign" } = {}) {
  if (typeof key !== "string" || !key) throw new Error("mergeObject 缺少 key");
  const db = getDb();
  const now = Date.now();
  db.exec("BEGIN");
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    let cur = {};
    if (row && row.value) { try { const p = JSON.parse(row.value); if (isPlainObj(p)) cur = p; } catch (e) {} }
    const merged = mode === "add" ? addMerge(cur, patch || {}) : assignMerge(cur, patch || {});
    const up = db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    up.run(key, JSON.stringify(merged), now);
    db.exec("COMMIT");
    return merged;
  } catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
}

function stats() {
  const rows = getDb().prepare("SELECT key, length(value) AS bytes FROM kv").all();
  let total = 0;
  const entries = rows.map((r) => { const b = r.bytes || 0; total += b; return { key: r.key, bytes: b }; });
  return { entries, total };
}

function clear({ keys } = {}) {
  const db = getDb();
  if (Array.isArray(keys) && keys.length) {
    const del = db.prepare("DELETE FROM kv WHERE key=?");
    db.exec("BEGIN");
    try { for (const k of keys) del.run(k); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
    return keys.length;
  }
  const n = db.prepare("SELECT COUNT(*) AS c FROM kv").get().c;
  db.exec("DELETE FROM kv");
  return n;
}

module.exports = { available, getAll, batch, mergeList, mergeObject, stats, clear, dbPath };
