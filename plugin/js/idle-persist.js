// WpsAiIdlePersist：高频持久化的 idle 错峰器（P0-3，参考察元 throttledPersist 思路）。
//
// 解决的问题：conversations 每轮全量 JSON.stringify + 网络合并落在关键路径上，
// 大对话时用户能感知到卡顿。
//
// 机制：
//   - debounce 合并突发调用（默认 250ms）——连续多次 persist 只写最后一次
//   - leading：空闲一段时间后的第一笔立即执行，避免极端情况"开头丢"
//   - 到点后用 requestIdleCallback 错峰主线程（不支持的环境退 setTimeout 0）
//   - flushSync()：beforeunload 等场景强制立即执行 pending 写入
//
// 注意：run 回调必须自己读"当前最新状态"（如模块级数组），
// 而不是捕获调用时的快照——延迟执行时读到的才是最终态。
(function attachIdlePersist(global) {
  "use strict";

  function createIdlePersister(run, options = {}) {
    const wait = Number(options.wait) > 0 ? Number(options.wait) : 250;
    const leading = options.leading !== false;
    // 空闲判定窗口：距上次真实执行超过 wait*4 视为"新的一波操作"，leading 立即写一次
    const idleGap = wait * 4;
    let timer = null;
    let pending = false;
    let lastRunAt = 0;

    function invoke() {
      pending = false;
      lastRunAt = Date.now();
      try { run(); } catch (e) { /* 持久化失败不影响调用方 */ }
    }

    function onTimer() {
      timer = null;
      if (!pending) return;
      const ric = global.requestIdleCallback;
      if (typeof ric === "function") ric(() => invoke(), { timeout: 1000 });
      else (global.setTimeout || setTimeout)(invoke, 0);
    }

    function schedule() {
      pending = true;
      if (leading && !timer && Date.now() - lastRunAt > idleGap) {
        invoke();
        return;
      }
      if (timer) (global.clearTimeout || clearTimeout)(timer);
      timer = (global.setTimeout || setTimeout)(onTimer, wait);
    }

    function flushSync() {
      if (timer) { (global.clearTimeout || clearTimeout)(timer); timer = null; }
      if (pending) invoke();
    }

    return {
      schedule,
      flushSync,
      isPending: () => pending
    };
  }

  global.WpsAiIdlePersist = { createIdlePersister };
})(window);
