// Writer 文档修改协调器：统一备份前置、文档身份、部分失败判断和整轮回滚。
(function attachDocumentMutation(global) {
  "use strict";

  // 所有 Writer 修改通过同一队列串行执行，避免两个异步备份/写入互相抢 currentTurn。
  let mutationTail = Promise.resolve();
  let activeTransaction = null;
  function withMutationLock(fn) {
    const next = mutationTail.then(fn, fn);
    mutationTail = next.catch(() => {});
    return next;
  }

  function getActiveDocumentRef() {
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.()
        || global.Application
        || global.wps?.Application
        || (typeof global.wps?.WpsApplication === "function" ? global.wps.WpsApplication() : null);
      return app?.ActiveDocument || null;
    } catch (e) { return null; }
  }

  function documentRefPath(documentRef) {
    try { return String(documentRef?.FullName || "") || null; } catch (e) { return null; }
  }

  function getActiveTransaction() { return activeTransaction; }
  function getBoundDocument() { return activeTransaction?.documentRef || null; }

  function pathsEqual(history, a, b) {
    if (!a || !b) return false;
    try { return history?.pathsEqual ? history.pathsEqual(a, b) : String(a) === String(b); }
    catch (e) { return String(a) === String(b); }
  }

  function issue(label, detail) {
    return { label, detail: detail == null ? "" : String(detail) };
  }

  function assessResult(value) {
    const issues = [];
    const seen = new Set();
    function add(label, detail) {
      const key = `${label}:${detail}`;
      if (!seen.has(key)) { seen.add(key); issues.push(issue(label, detail)); }
    }
    function scan(node, path, depth) {
      if (!node || typeof node !== "object" || depth > 4) return;
      if (node.ok === false) add(`${path}.ok`, node.error || "工具返回 ok=false");
      if (node.applied === false) add(`${path}.applied`, node.error || "工具报告 applied=false");
      if (node.partialFailure === true) add(`${path}.partialFailure`, "工具报告部分失败");
      if (["failed", "partial", "error"].includes(String(node.status || "").toLowerCase())) add(`${path}.status`, node.status);
      Object.entries(node).forEach(([key, child]) => {
        const childPath = `${path}.${key}`;
        if (/^(failed|failure|failures|failedCount|failureCount|failedCells|failedParagraphs)$/i.test(key)) {
          if (typeof child === "number" && child > 0) add(childPath, child);
          else if (Array.isArray(child) && child.length) add(childPath, child.length);
        }
        if (key === "verification" && child && typeof child === "object" && child.ok !== true) {
          add(childPath, child.error || "写后验证未通过");
        }
        if (["verification", "levels", "results", "items", "details"].includes(key)) {
          if (Array.isArray(child)) child.forEach((item, index) => scan(item, `${childPath}[${index}]`, depth + 1));
          else scan(child, childPath, depth + 1);
        }
      });
    }
    scan(value, "result", 0);
    return issues.length
      ? { ok: false, code: "PARTIAL_MUTATION", issues }
      : { ok: true, code: "VERIFIED_OR_NO_FAILURE_SIGNAL", issues: [] };
  }

  async function prepare({ label, toolName, forceNewTurn = false } = {}) {
    const history = global.WpsAiHistory;
    const backup = global.WpsAiBackup;
    if (!history || !backup) {
      return { ok: false, code: "BACKUP_REQUIRED", error: "BACKUP_REQUIRED: 文档修改安全模块未完整加载。" };
    }
    if (forceNewTurn || !history.getCurrentTurnId?.()) {
      try { history.startTurn?.(label || `external:${toolName || "mutation"}`); }
      catch (e) { return { ok: false, code: "TURN_START_FAILED", error: `TURN_START_FAILED: ${e?.message || e}` }; }
    }
    const turnId = history.getCurrentTurnId?.() || null;
    if (!turnId) return { ok: false, code: "TURN_START_FAILED", error: "TURN_START_FAILED: 未取得 turnId。" };
    if (history.isTurnBlocked?.(turnId) || history.isCurrentTurnBlocked?.()) {
      return { ok: false, code: "TURN_MUTATION_BLOCKED", error: "TURN_MUTATION_BLOCKED: 本轮已失败并进入回滚状态。" };
    }
    const docPathBefore = backup.getCurrentDocPath?.() || null;
    if (!docPathBefore) {
      return { ok: false, code: "DOCUMENT_NOT_SAVED", error: "DOCUMENT_NOT_SAVED: 当前文档尚未保存到磁盘。" };
    }
    let backupInfo = null;
    try { backupInfo = await history.ensureBackupForTurn?.(turnId); }
    catch (e) {
      return { ok: false, code: "BACKUP_REQUIRED", error: `BACKUP_REQUIRED: ${e?.message || e}` };
    }
    if (history.getCurrentTurnId?.() !== turnId) {
      return { ok: false, code: "TURN_CHANGED_DURING_BACKUP", error: "TURN_CHANGED_DURING_BACKUP: 备份期间活动 turn 发生变化。" };
    }
    const backupError = history.getTurnBackupError?.(turnId);
    if (backupError || !backupInfo?.backupPath) {
      return {
        ok: false,
        code: "BACKUP_REQUIRED",
        error: `BACKUP_REQUIRED: ${backupError || "未取得持久备份路径"}`
      };
    }
    const docPathAfter = backup.getCurrentDocPath?.() || null;
    if (!pathsEqual(history, docPathAfter, backupInfo.docPath || docPathBefore)) {
      return { ok: false, code: "DOCUMENT_CHANGED_DURING_BACKUP", error: "DOCUMENT_CHANGED_DURING_BACKUP: 备份期间活动文档发生变化。" };
    }
    let activeDocId = null;
    try { activeDocId = backup.readDocId?.() || null; } catch (e) {}
    if (activeDocId && backupInfo.docId && String(activeDocId) !== String(backupInfo.docId)) {
      return { ok: false, code: "DOCUMENT_CHANGED_DURING_BACKUP", error: "DOCUMENT_CHANGED_DURING_BACKUP: 当前文档身份与备份不一致。" };
    }
    const documentRef = getActiveDocumentRef();
    const refPath = documentRefPath(documentRef);
    if (documentRef && refPath && !pathsEqual(history, refPath, backupInfo.docPath || docPathAfter)) {
      return { ok: false, code: "DOCUMENT_CHANGED_DURING_BACKUP", error: "DOCUMENT_CHANGED_DURING_BACKUP: 固定文档引用与备份路径不一致。" };
    }
    return {
      ok: true,
      turnId,
      docId: backupInfo.docId || activeDocId || null,
      docPath: backupInfo.docPath || docPathAfter,
      backupPath: backupInfo.backupPath,
      documentRef
    };
  }

  function validateTransaction(transaction) {
    const history = global.WpsAiHistory;
    const backup = global.WpsAiBackup;
    if (!transaction?.turnId || history?.getCurrentTurnId?.() !== transaction.turnId) {
      return { ok: false, code: "TURN_CHANGED_DURING_MUTATION", error: "TURN_CHANGED_DURING_MUTATION: 活动 turn 已变化。" };
    }
    const boundPath = documentRefPath(transaction.documentRef);
    const currentPath = boundPath || backup?.getCurrentDocPath?.() || null;
    if (!pathsEqual(history, currentPath, transaction.docPath)) {
      return { ok: false, code: "DOCUMENT_CHANGED_DURING_MUTATION", error: "DOCUMENT_CHANGED_DURING_MUTATION: 固定文档身份已变化。" };
    }
    // 只有没有固定 COM 引用时才读取当前活动文档 ID；有引用时允许用户浏览其它文档。
    if (!transaction.documentRef) {
      let currentDocId = null;
      try { currentDocId = backup?.readDocId?.() || null; } catch (e) {}
      if (transaction.docId && currentDocId && String(transaction.docId) !== String(currentDocId)) {
        return { ok: false, code: "DOCUMENT_CHANGED_DURING_MUTATION", error: "DOCUMENT_CHANGED_DURING_MUTATION: 文档身份已变化。" };
      }
    }
    return { ok: true };
  }

  async function rollbackTransaction(transaction, reason) {
    const history = global.WpsAiHistory;
    const backup = global.WpsAiBackup;
    const turn = history?.getTurn?.(transaction?.turnId) || null;
    try {
      if (typeof history?.markTurnFailed === "function") history.markTurnFailed(transaction?.turnId, reason || "修改失败");
      else if (history?.getCurrentTurnId?.() === transaction?.turnId) history?.markCurrentTurnFailed?.(reason || "修改失败");
    } catch (e) {}
    const backupPath = transaction?.backupPath || turn?.backup?.backupPath;
    const docPath = transaction?.docPath || turn?.backup?.docPath || turn?.docPath;
    if (!backupPath || !docPath) {
      return { ok: false, error: "ROLLBACK_UNAVAILABLE: 该事务没有可用备份。" };
    }
    const activePath = backup?.getCurrentDocPath?.() || null;
    if (!pathsEqual(history, activePath, docPath)) {
      const activated = backup?.activateDocumentByPath?.(docPath) === true;
      if (!activated || !pathsEqual(history, backup?.getCurrentDocPath?.(), docPath)) {
        return {
          ok: false,
          deferred: true,
          error: "ROLLBACK_DEFERRED: 目标文档当前不是活动文档，未对其他文档执行 Undo 或磁盘覆盖；备份已保留。"
        };
      }
    }
    if (transaction?.docId) {
      let rollbackDocId = null;
      try { rollbackDocId = backup?.readDocId?.() || null; } catch (e) {}
      if (rollbackDocId && String(rollbackDocId) !== String(transaction.docId)) {
        return { ok: false, deferred: true, error: "ROLLBACK_DEFERRED: 目标路径相同但文档 ID 不一致，已拒绝恢复。" };
      }
    }
    try { backup?.endUndoGroup?.(); } catch (e) {}
    try {
      const result = await backup.restoreFromBackup(backupPath, docPath, { tryUndo: true, undoSteps: 1 });
      if (result?.ok) return result;
      return { ok: false, error: result?.error || "回滚失败" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function rollbackCurrentTurn(reason) {
    const history = global.WpsAiHistory;
    const turn = history?.getCurrentTurn?.() || null;
    return rollbackTransaction(turn ? {
      turnId: turn.id,
      docId: turn.backup?.docId || turn.docId || null,
      docPath: turn.backup?.docPath || turn.docPath || null,
      backupPath: turn.backup?.backupPath || null
    } : null, reason);
  }

  async function run({ label, toolName, args, mutate, verify, forceNewTurn = false } = {}) {
    if (typeof mutate !== "function") {
      return { ok: false, code: "MUTATE_REQUIRED", error: "MUTATE_REQUIRED: mutate 必须是函数。" };
    }
    return withMutationLock(async () => {
      const prepared = await prepare({ label, toolName, forceNewTurn });
      if (!prepared.ok) return prepared;
      const beforeCheck = validateTransaction(prepared);
      if (!beforeCheck.ok) return beforeCheck;
      let value;
      const previousTransaction = activeTransaction;
      activeTransaction = prepared;
      try {
        value = await mutate(args || {}, prepared);
      } catch (e) {
        const error = e?.message || String(e);
        const rollback = await rollbackTransaction(prepared, error);
        return { ok: false, code: "MUTATION_THROWN", error, rollback, prepared };
      } finally {
        activeTransaction = previousTransaction;
      }
      const afterCheck = validateTransaction(prepared);
      if (!afterCheck.ok) {
        const rollback = await rollbackTransaction(prepared, afterCheck.error);
        return Object.assign({}, afterCheck, { rollback, prepared });
      }
      let assessment = assessResult(value);
      if (assessment.ok && typeof verify === "function") {
        try {
          const previousVerificationTransaction = activeTransaction;
          activeTransaction = prepared;
          let verification;
          try { verification = await verify(value, prepared); }
          finally { activeTransaction = previousVerificationTransaction; }
          assessment = assessResult({ verification });
        } catch (e) {
          assessment = { ok: false, code: "VERIFICATION_THROWN", issues: [issue("verification", e?.message || e)] };
        }
      }
      if (!assessment.ok) {
        const error = assessment.issues.map((item) => `${item.label}:${item.detail}`).join("；");
        const rollback = await rollbackTransaction(prepared, error);
        return { ok: false, code: assessment.code || "PARTIAL_MUTATION", error, issues: assessment.issues, rollback, prepared };
      }
      const finalCheck = validateTransaction(prepared);
      if (!finalCheck.ok) {
        const rollback = await rollbackTransaction(prepared, finalCheck.error);
        return Object.assign({}, finalCheck, { rollback, prepared });
      }
      return { ok: true, value, prepared, verification: assessment };
    });
  }

  global.WpsAiDocumentMutation = {
    prepare,
    assessResult,
    run,
    validateTransaction,
    getActiveTransaction,
    getBoundDocument,
    rollbackTransaction,
    rollbackCurrentTurn
  };
})(window);
