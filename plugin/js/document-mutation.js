// Writer 文档修改协调器：统一备份前置、文档身份、部分失败判断和整轮回滚。
(function attachDocumentMutation(global) {
  "use strict";

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
    if (value && typeof value === "object") {
      if (value.ok === false) issues.push(issue("ok", value.error || "工具返回 ok=false"));
      if (value.partialFailure === true) issues.push(issue("partialFailure", "工具报告部分失败"));
      if (typeof value.failed === "number" && value.failed > 0) issues.push(issue("failed", value.failed));
      if (Array.isArray(value.failed) && value.failed.length) issues.push(issue("failed", value.failed.length));
      ["failedCells", "failedParagraphs", "failures"].forEach((key) => {
        if (Array.isArray(value[key]) && value[key].length) issues.push(issue(key, value[key].length));
      });
      if (value.verification && value.verification.ok !== true) {
        issues.push(issue("verification", value.verification.error || "写后验证未通过"));
        ["failures", "issues", "failedCells", "failedParagraphs"].forEach((key) => {
          if (Array.isArray(value.verification[key]) && value.verification[key].length) {
            issues.push(issue(`verification.${key}`, value.verification[key].length));
          }
        });
      }
    }
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
    if (history.isCurrentTurnBlocked?.()) {
      return { ok: false, code: "TURN_MUTATION_BLOCKED", error: "TURN_MUTATION_BLOCKED: 本轮已失败并进入回滚状态。" };
    }
    const docPathBefore = backup.getCurrentDocPath?.() || null;
    if (!docPathBefore) {
      return { ok: false, code: "DOCUMENT_NOT_SAVED", error: "DOCUMENT_NOT_SAVED: 当前文档尚未保存到磁盘。" };
    }
    let backupInfo = null;
    try { backupInfo = await history.ensureBackupForTurn?.(); }
    catch (e) {
      return { ok: false, code: "BACKUP_REQUIRED", error: `BACKUP_REQUIRED: ${e?.message || e}` };
    }
    const backupError = history.getTurnBackupError?.();
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
    return {
      ok: true,
      turnId: history.getCurrentTurnId?.() || null,
      docId: backupInfo.docId || activeDocId || null,
      docPath: backupInfo.docPath || docPathAfter,
      backupPath: backupInfo.backupPath
    };
  }

  async function rollbackCurrentTurn(reason) {
    const history = global.WpsAiHistory;
    const backup = global.WpsAiBackup;
    const turn = history?.getCurrentTurn?.() || null;
    try { history?.markCurrentTurnFailed?.(reason || "修改失败"); } catch (e) {}
    if (!turn?.backup?.backupPath || !(turn.backup.docPath || turn.docPath)) {
      return { ok: false, error: "ROLLBACK_UNAVAILABLE: 当前 turn 没有可用备份。" };
    }
    try { backup?.endUndoGroup?.(); } catch (e) {}
    try {
      const result = await backup.restoreFromBackup(
        turn.backup.backupPath,
        turn.backup.docPath || turn.docPath,
        { tryUndo: true, undoSteps: 1 }
      );
      if (result?.ok) return result;
      return { ok: false, error: result?.error || "回滚失败" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function run({ label, toolName, args, mutate, verify, forceNewTurn = false } = {}) {
    if (typeof mutate !== "function") {
      return { ok: false, code: "MUTATE_REQUIRED", error: "MUTATE_REQUIRED: mutate 必须是函数。" };
    }
    const prepared = await prepare({ label, toolName, forceNewTurn });
    if (!prepared.ok) return prepared;
    let value;
    try {
      value = await mutate(args || {});
    } catch (e) {
      const error = e?.message || String(e);
      const rollback = await rollbackCurrentTurn(error);
      return { ok: false, code: "MUTATION_THROWN", error, rollback };
    }
    let assessment = assessResult(value);
    if (assessment.ok && typeof verify === "function") {
      try {
        const verification = await verify(value, prepared);
        assessment = assessResult({ verification });
      } catch (e) {
        assessment = { ok: false, code: "VERIFICATION_THROWN", issues: [issue("verification", e?.message || e)] };
      }
    }
    if (!assessment.ok) {
      const error = assessment.issues.map((item) => `${item.label}:${item.detail}`).join("；");
      const rollback = await rollbackCurrentTurn(error);
      return { ok: false, code: assessment.code || "PARTIAL_MUTATION", error, issues: assessment.issues, rollback };
    }
    return { ok: true, value, prepared, verification: assessment };
  }

  global.WpsAiDocumentMutation = {
    prepare,
    assessResult,
    run,
    rollbackCurrentTurn
  };
})(window);
