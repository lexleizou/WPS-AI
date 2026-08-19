// WpsAiTaskStore：后台长任务统一抽象（P2-1，参考易标 RejectionBackgroundTaskState）。
//
// 所有长任务（批注校对 / 合规检查 / 整套 PPT / 分批排版 / 历史压缩…）统一登记：
//   { id, type, title, status: running|success|error|stopped, progress 0-100,
//     logs[]（上限 50 条）, error, startedAt, updatedAt }
//
// 价值：任务中断可查（重开面板还能看到状态与日志）、停止信号统一、
// 未来「任务中心」UI 直接读这份数据。持久化走 SQLite 受管键 + idle 错峰。
(function attachTaskStore(global) {
  "use strict";

  const STORE_KEY = "lingxi_task_store_v1";
  const MAX_TASKS = 30;   // 归档上限（旧任务先出）
  const MAX_LOGS = 50;    // 单任务日志上限

  let tasks = null; // 懒加载

  function load() {
    if (tasks) return tasks;
    try {
      const raw = global.WpsAiStore?.getItem?.(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      tasks = Array.isArray(arr) ? arr : [];
    } catch (e) { tasks = []; }
    return tasks;
  }

  let _persister = null;
  function persistNow() {
    try { global.WpsAiStore?.setItem?.(STORE_KEY, JSON.stringify(tasks || [])); } catch (e) {}
  }
  function persist() {
    if (!_persister && global.WpsAiIdlePersist?.createIdlePersister) {
      _persister = global.WpsAiIdlePersist.createIdlePersister(persistNow, { wait: 300 });
      try {
        global.addEventListener && global.addEventListener("beforeunload", () => {
          try { _persister.flushSync(); } catch (e) {}
        });
      } catch (e) {}
    }
    if (_persister) _persister.schedule();
    else persistNow();
  }

  function newId(type) {
    return `${type || "task"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 登记新任务，返回任务对象（引用即句柄，后续用 update/log） */
  function add({ type, title } = {}) {
    const list = load();
    const task = {
      id: newId(type),
      type: String(type || "task"),
      title: String(title || "").slice(0, 80),
      status: "running",
      progress: 0,
      logs: [],
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    list.push(task);
    if (list.length > MAX_TASKS) list.splice(0, list.length - MAX_TASKS);
    persist();
    return task;
  }

  function get(id) {
    return load().find((t) => t.id === id) || null;
  }

  /** 更新任务：status / progress(0-100) / error；带 log 时追加一条日志 */
  function update(id, patch = {}) {
    const task = get(id);
    if (!task) return null;
    if (patch.status && ["running", "success", "error", "stopped"].includes(patch.status)) task.status = patch.status;
    if (Number.isFinite(patch.progress)) task.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
    if (patch.error != null) task.error = String(patch.error).slice(0, 500);
    if (patch.log) {
      task.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${String(patch.log).slice(0, 200)}`);
      if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS);
    }
    task.updatedAt = Date.now();
    persist();
    return task;
  }

  /** 便捷收尾 */
  function finish(id, { error } = {}) {
    return update(id, error ? { status: "error", error, log: `失败：${error}` } : { status: "success", progress: 100, log: "完成" });
  }

  /** 最近任务列表（新的在前） */
  function list({ limit = 20, type } = {}) {
    let arr = load().slice().reverse();
    if (type) arr = arr.filter((t) => t.type === type);
    return arr.slice(0, limit);
  }

  // ---- 停止信号（跨窗口，走 localStorage 轮询语义） ----
  function stopKey(id) { return `lingxi_task_stop_${id}`; }
  function requestStop(id) {
    try { global.localStorage.setItem(stopKey(id), "1"); } catch (e) {}
    update(id, { log: "收到停止请求" });
  }
  function isStopRequested(id) {
    try { return global.localStorage.getItem(stopKey(id)) === "1"; } catch (e) { return false; }
  }
  function clearStop(id) {
    try { global.localStorage.removeItem(stopKey(id)); } catch (e) {}
  }

  // WpsAiStore hydrate 后重灌（boot 时机与其它缓存一致）
  function reloadFromStore() {
    tasks = null;
    load();
  }

  global.WpsAiTaskStore = { add, get, update, finish, list, requestStop, isStopRequested, clearStop, reloadFromStore, MAX_TASKS, MAX_LOGS };
})(window);
