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

test("mutation assessment rejects applied=false and nested level failures", () => {
  const mutation = loadMutation();
  const appliedFalse = mutation.assessResult({ applied: false, error: "not applied" });
  assert.equal(appliedFalse.ok, false);
  const nestedFailure = mutation.assessResult({
    applied: false,
    levels: [{ level: 2, failures: [{ field: "LeftIndent" }] }]
  });
  assert.equal(nestedFailure.ok, false);
  assert.ok(nestedFailure.issues.some((item) => /levels/.test(item.label)));
});

test("prepare refuses a new turn created while the backup is pending", async () => {
  let currentTurnId = "t1";
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => currentTurnId,
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async (turnId) => {
        assert.equal(turnId, "t1");
        currentTurnId = "t2";
        return { backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" };
      },
      getTurnBackupError: () => null
    },
    WpsAiBackup: { getCurrentDocPath: () => "/tmp/a.docx", readDocId: () => "doc-1" }
  });
  const result = await mutation.prepare({ label: "race", toolName: "wps_write" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TURN_CHANGED_DURING_BACKUP");
});

test("a document switch before write prevents mutate from running", async () => {
  let pathReads = 0;
  let mutated = 0;
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => "t1",
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async () => ({ backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" }),
      getTurnBackupError: () => null,
      pathsEqual: (a, b) => a === b
    },
    WpsAiBackup: {
      getCurrentDocPath: () => (++pathReads >= 3 ? "/tmp/b.docx" : "/tmp/a.docx"),
      readDocId: () => "doc-1"
    }
  });
  const result = await mutation.run({ toolName: "wps_write", mutate: async () => { mutated += 1; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DOCUMENT_CHANGED_DURING_MUTATION");
  assert.equal(mutated, 0);
});

test("rollback uses the immutable transaction even if current turn changes", async () => {
  let currentTurnId = "t1";
  let restoredArgs = null;
  let failedTurn = null;
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => currentTurnId,
      getTurn: () => null,
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async () => ({ backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" }),
      getTurnBackupError: () => null,
      markTurnFailed: (turnId) => { failedTurn = turnId; },
      pathsEqual: (a, b) => a === b
    },
    WpsAiBackup: {
      getCurrentDocPath: () => "/tmp/a.docx",
      readDocId: () => "doc-1",
      endUndoGroup: () => true,
      restoreFromBackup: async (...args) => { restoredArgs = args; return { ok: true }; }
    }
  });
  const result = await mutation.run({
    toolName: "wps_write",
    mutate: async () => { currentTurnId = "t2"; return { ok: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TURN_CHANGED_DURING_MUTATION");
  assert.equal(failedTurn, "t1");
  assert.equal(restoredArgs[0], "/tmp/a.backup.docx");
  assert.equal(restoredArgs[1], "/tmp/a.docx");
});

test("a bound document reference prevents an async handler from modifying the newly active document", async () => {
  const documentA = { FullName: "/tmp/a.docx", modified: false };
  const documentB = { FullName: "/tmp/b.docx", modified: false };
  const app = { ActiveDocument: documentA };
  const mutation = loadMutation({
    WpsAiAddon: { getApplicationSync: () => app },
    WpsAiHistory: {
      getCurrentTurnId: () => "t1",
      isCurrentTurnBlocked: () => false,
      ensureBackupForTurn: async () => ({ backupPath: "/tmp/a.backup.docx", docPath: "/tmp/a.docx", docId: "doc-1" }),
      getTurnBackupError: () => null,
      pathsEqual: (a, b) => a === b
    },
    WpsAiBackup: {
      getCurrentDocPath: () => app.ActiveDocument.FullName,
      readDocId: () => "doc-1"
    }
  });
  const result = await mutation.run({
    toolName: "wps_async_write",
    mutate: async () => {
      await Promise.resolve();
      app.ActiveDocument = documentB;
      const bound = mutation.getBoundDocument();
      bound.modified = true;
      return { applied: true };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(documentA.modified, true);
  assert.equal(documentB.modified, false);
});

test("rollback never restores a non-active document when activation fails", async () => {
  let restored = 0;
  const mutation = loadMutation({
    WpsAiHistory: {
      getCurrentTurnId: () => "t2",
      getTurn: () => null,
      markTurnFailed: () => true,
      pathsEqual: (a, b) => a === b
    },
    WpsAiBackup: {
      getCurrentDocPath: () => "/tmp/b.docx",
      activateDocumentByPath: () => false,
      restoreFromBackup: async () => { restored += 1; return { ok: true }; }
    }
  });
  const result = await mutation.rollbackTransaction({
    turnId: "t1",
    docId: "doc-1",
    docPath: "/tmp/a.docx",
    backupPath: "/tmp/a.backup.docx"
  }, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(restored, 0);
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

test("backup failure closes the UndoRecord on its owner app after an app switch", async () => {
  let ownerEnds = 0;
  let otherEnds = 0;
  const makeDoc = (name) => ({
    FullName: `/tmp/${name}.docx`, Path: "/tmp", Name: `${name}.docx`, Save: () => {}
  });
  const ownerApp = {
    UndoRecord: { StartCustomRecord: () => {}, EndCustomRecord: () => { ownerEnds += 1; } },
    ActiveDocument: makeDoc("a")
  };
  const otherApp = {
    UndoRecord: { StartCustomRecord: () => {}, EndCustomRecord: () => { otherEnds += 1; } },
    ActiveDocument: makeDoc("b")
  };
  let currentApp = ownerApp;
  const context = loadIife(backupFile, {
    wps: { WpsApplication: () => currentApp },
    fetch: async () => {
      currentApp = otherApp;
      return { ok: false, status: 500, text: async () => "failed" };
    }
  });
  const result = await context.WpsAiBackup.captureCurrentDoc();
  assert.equal(result.ok, false);
  assert.equal(ownerEnds, 1);
  assert.equal(otherEnds, 0);
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
