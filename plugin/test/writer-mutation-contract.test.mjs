import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIife } from "./helpers/load-iife.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mutationFile = path.resolve(here, "../js/document-mutation.js");
const backupFile = path.resolve(here, "../js/backup.js");

function loadMutation(overrides = {}) {
  return loadIife(mutationFile, overrides).WpsAiDocumentMutation;
}

test("prepare rejects a missing durable backup", async () => {
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => "t1",
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async () => null,
      getTurnBackupError: () => null
    },
    WpsAiBackup: { getCurrentDocPath: () => "/tmp/a.docx" }
  });
  const result = await mutation.prepare({ label: "test", toolName: "wps_write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /BACKUP_REQUIRED/);
});

test("partial mutation result rolls back the current turn", async () => {
  let restored = 0;
  let blocked = 0;
  const history = {
    getCurrentTurnId: () => "t1",
    getCurrentTurn: () => ({
      id: "t1",
      docPath: "/tmp/a.docx",
      docId: "doc-1",
      backup: { backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" }
    }),
    isCurrentTurnBlocked: () => false,
    ensureBackupForTurn: async () => ({ backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" }),
    getTurnBackupError: () => null,
    markCurrentTurnFailed: () => { blocked += 1; },
    pathsEqual: (a, b) => a === b
  };
  const mutation = loadMutation({
    WpsAiHistory: history,
    WpsAiBackup: {
      getCurrentDocPath: () => "/tmp/a.docx",
      readDocId: () => "doc-1",
      endUndoGroup: () => true,
      restoreFromBackup: async () => { restored += 1; return { ok: true, method: "undo" }; }
    }
  });

  const result = await mutation.run({
    label: "partial",
    toolName: "wps_write_table_range",
    mutate: async () => ({ verification: { ok: false, failures: [{ field: "cell-2" }] } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PARTIAL_MUTATION");
  assert.equal(blocked, 1);
  assert.equal(restored, 1);
  assert.equal(result.rollback.ok, true);
});

test("backup failure closes the UndoRecord it opened", async () => {
  let starts = 0;
  let ends = 0;
  const app = {
    UndoRecord: {
      StartCustomRecord: () => { starts += 1; },
      EndCustomRecord: () => { ends += 1; }
    },
    ActiveDocument: {
      FullName: "/tmp/a.docx",
      Path: "/tmp",
      Name: "a.docx",
      Save: () => { throw new Error("disk full"); }
    }
  };
  const context = loadIife(backupFile, {
    wps: { WpsApplication: () => app }
  });
  const result = await context.WpsAiBackup.captureCurrentDoc();
  assert.equal(result.ok, false);
  assert.match(result.error, /Save 失败/);
  assert.equal(starts, 1);
  assert.equal(ends, 1);
});

test("successful mutation returns its value without rollback", async () => {
  let restored = 0;
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => "t1",
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async () => ({ backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx" }),
      getTurnBackupError: () => null,
      pathsEqual: (a, b) => a === b
    },
    WpsAiBackup: {
      getCurrentDocPath: () => "/tmp/a.docx",
      restoreFromBackup: async () => { restored += 1; return { ok: true }; }
    }
  });
  const result = await mutation.run({
    label: "ok",
    toolName: "wps_write",
    mutate: async () => ({ verification: { ok: true }, changed: 1 })
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.changed, 1);
  assert.equal(restored, 0);
});
