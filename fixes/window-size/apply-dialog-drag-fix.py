#!/usr/bin/env python3
"""Install/check/remove the LingxiAI macOS ShowDialog drag-resize patch."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
FIX_DIR = HOME / ".lingxi-ai" / "fixes" / "window-size"
BACKUP_ROOT = FIX_DIR / "drag-backups"
HOSTS = ("wps", "et", "wpp", "pdf")
APP_TARGETS = {
    **{f"runtime-{h}-app": HOME / ".lingxi-ai" / f"plugin-{h}" / "js" / "app.js" for h in HOSTS},
    "source-app": HOME / "Library" / "Application Support" / "LingxiAI" / "plugin" / "js" / "app.js",
}
ADAPTER_TARGETS = {
    **{f"runtime-{h}-adapter": HOME / ".lingxi-ai" / f"plugin-{h}" / "js" / "wps-addon-adapter.js" for h in HOSTS},
    "source-adapter": HOME / "Library" / "Application Support" / "LingxiAI" / "plugin" / "js" / "wps-addon-adapter.js",
}
TARGETS = {**APP_TARGETS, **ADAPTER_TARGETS}
APP_MARKER = "LINGXI_MACOS_DIALOG_DRAG_RESIZE_V1"
ADAPTER_MARKER = "LINGXI_MACOS_DIALOG_SIZE_MEMORY_V1"

APP_OLD_RESIZE = '''  // 浮动模式下 8 个 resize handle 共用同一套 mouse drag 逻辑：
  //   按 screenX/screenY 的 delta 直接调 pane.Width/Height（必要时也调 Left/Top，
  //   从北/西方向拉时窗口左上角会移动）
  function bindFloatingResizeHandles() {
    const handles = document.querySelectorAll(".resize-handle");
    if (handles.length === 0) return;
    handles.forEach((h) => {
      h.addEventListener("mousedown", (ev) => startResize(ev, h.dataset.edge || "se"));
    });
  }

  function startResize(ev, edge) {
    if (!document.body.classList.contains("is-floating")) return;
    const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
    if (!pane) return;
    let initialW = 0, initialH = 0, initialLeft = 0, initialTop = 0;
    try { initialW = Number(pane.Width) || 0; } catch (e) {}
    try { initialH = Number(pane.Height) || 0; } catch (e) {}
    try { initialLeft = Number(pane.Left) || 0; } catch (e) {}
    try { initialTop = Number(pane.Top) || 0; } catch (e) {}
    const startX = ev.screenX;
    const startY = ev.screenY;
    ev.preventDefault();
    ev.stopPropagation();

    function onMove(e) {
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      let newW = initialW, newH = initialH, newL = initialLeft, newT = initialTop;
      if (edge.includes("e")) newW = Math.max(280, initialW + dx);
      if (edge.includes("w")) { newW = Math.max(280, initialW - dx); newL = initialLeft + (initialW - newW); }
      if (edge.includes("s")) newH = Math.max(240, initialH + dy);
      if (edge.includes("n")) { newH = Math.max(240, initialH - dy); newT = initialTop + (initialH - newH); }
      try { if ("Width" in pane && newW !== initialW) pane.Width = Math.round(newW); } catch (er) {}
      try { if ("Height" in pane && newH !== initialH) pane.Height = Math.round(newH); } catch (er) {}
      try { if ("Left" in pane && newL !== initialLeft) pane.Left = Math.round(newL); } catch (er) {}
      try { if ("Top" in pane && newT !== initialTop) pane.Top = Math.round(newT); } catch (er) {}
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }
'''

APP_NEW_RESIZE = '''  // LINGXI_MACOS_DIALOG_DRAG_RESIZE_V1
  // 浮动 TaskPane 与 macOS/Linux 主 ShowDialog 共用 8 个 resize handle。
  // TaskPane 写 pane.Width/Height；ShowDialog 没有 pane 句柄时回退到 window.resizeTo/moveTo。
  const MAIN_DIALOG_SIZE_KEY = "lingxi_ai_main_dialog_size_v1";

  function isMainDialogWindow() {
    try {
      const qs = new URLSearchParams(global.location?.search || "");
      return qs.get("pane") === "dialog" && !qs.get("mode");
    } catch (e) { return false; }
  }

  function persistMainDialogSize() {
    if (!isMainDialogWindow()) return;
    try {
      const width = Math.round(Number(global.outerWidth || global.innerWidth) || 0);
      const height = Math.round(Number(global.outerHeight || global.innerHeight) || 0);
      if (width >= 420 && height >= 520) {
        global.localStorage?.setItem(MAIN_DIALOG_SIZE_KEY, JSON.stringify({ width, height, updatedAt: Date.now() }));
      }
    } catch (e) {}
  }

  function bindFloatingResizeHandles() {
    const handles = document.querySelectorAll(".resize-handle");
    if (handles.length === 0) return;
    handles.forEach((h) => {
      h.addEventListener("mousedown", (ev) => startResize(ev, h.dataset.edge || "se"));
    });
    if (isMainDialogWindow()) {
      let saveTimer = null;
      global.addEventListener("resize", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persistMainDialogSize, 250);
      });
    }
  }

  function startResize(ev, edge) {
    if (!document.body.classList.contains("is-floating")) return;
    const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
    const dialogMode = !pane && isMainDialogWindow() && typeof global.resizeTo === "function";
    if (!pane && !dialogMode) return;

    let initialW = 0, initialH = 0, initialLeft = 0, initialTop = 0;
    if (pane) {
      try { initialW = Number(pane.Width) || 0; } catch (e) {}
      try { initialH = Number(pane.Height) || 0; } catch (e) {}
      try { initialLeft = Number(pane.Left) || 0; } catch (e) {}
      try { initialTop = Number(pane.Top) || 0; } catch (e) {}
    } else {
      initialW = Number(global.outerWidth || global.innerWidth) || 620;
      initialH = Number(global.outerHeight || global.innerHeight) || 720;
      initialLeft = Number(global.screenX) || 0;
      initialTop = Number(global.screenY) || 0;
    }

    const startX = ev.screenX;
    const startY = ev.screenY;
    const sw = Number(global.screen?.availWidth || global.screen?.width) || 1920;
    const sh = Number(global.screen?.availHeight || global.screen?.height) || 1080;
    const minW = dialogMode ? 420 : 280;
    const minH = dialogMode ? 520 : 240;
    const maxW = Math.max(minW, sw - 40);
    const maxH = Math.max(minH, sh - 40);
    ev.preventDefault();
    ev.stopPropagation();

    function onMove(e) {
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      let newW = initialW, newH = initialH, newL = initialLeft, newT = initialTop;
      if (edge.includes("e")) newW = Math.min(maxW, Math.max(minW, initialW + dx));
      if (edge.includes("w")) {
        newW = Math.min(maxW, Math.max(minW, initialW - dx));
        newL = initialLeft + (initialW - newW);
      }
      if (edge.includes("s")) newH = Math.min(maxH, Math.max(minH, initialH + dy));
      if (edge.includes("n")) {
        newH = Math.min(maxH, Math.max(minH, initialH - dy));
        newT = initialTop + (initialH - newH);
      }

      if (pane) {
        try { if ("Width" in pane && newW !== initialW) pane.Width = Math.round(newW); } catch (er) {}
        try { if ("Height" in pane && newH !== initialH) pane.Height = Math.round(newH); } catch (er) {}
        try { if ("Left" in pane && newL !== initialLeft) pane.Left = Math.round(newL); } catch (er) {}
        try { if ("Top" in pane && newT !== initialTop) pane.Top = Math.round(newT); } catch (er) {}
      } else {
        try {
          if ((edge.includes("w") || edge.includes("n")) && typeof global.moveTo === "function") {
            global.moveTo(Math.round(newL), Math.round(newT));
          }
          global.resizeTo(Math.round(newW), Math.round(newH));
        } catch (er) {}
      }
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      if (dialogMode) setTimeout(persistMainDialogSize, 80);
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }
'''

APP_OLD_FLOATING = '''    // Mac/Linux 主面板已是浮窗，不显示「脱离右侧固定区」按钮
    if (preferFloatingPanel()) { els.dockToggleBtn.classList.add("hidden"); return; }
'''
APP_NEW_FLOATING = '''    // Mac/Linux 主面板是独立 ShowDialog：隐藏停靠按钮，但启用页面内拖拽抓手。
    if (preferFloatingPanel()) {
      els.dockToggleBtn.classList.add("hidden");
      document.body?.classList.toggle("is-floating", isMainDialogWindow());
      return;
    }
'''

ADAPTER_OLD = '''  function pickMainDialogSize() {
    const dpr = Number(global.devicePixelRatio) || 1;
    const sw = Number(global.screen?.availWidth || global.screen?.width) || 1440;
    const sh = Number(global.screen?.availHeight || global.screen?.height) || 900;
    const logicalWidth = Math.max(620, Math.min(760, Math.round(sw * 0.46)));
    const logicalHeight = Math.max(720, Math.min(900, Math.round(sh - 120)));
    return {
      width: Math.round(logicalWidth * dpr),
      height: Math.round(logicalHeight * dpr),
      logicalWidth,
      logicalHeight
    };
  }
'''

ADAPTER_NEW = '''  // LINGXI_MACOS_DIALOG_SIZE_MEMORY_V1
  const MAIN_DIALOG_SIZE_KEY = "lingxi_ai_main_dialog_size_v1";

  function pickMainDialogSize() {
    const dpr = Number(global.devicePixelRatio) || 1;
    const sw = Number(global.screen?.availWidth || global.screen?.width) || 1440;
    const sh = Number(global.screen?.availHeight || global.screen?.height) || 900;
    const maxW = Math.max(420, sw - 40);
    const maxH = Math.max(520, sh - 40);
    let logicalWidth = Math.max(620, Math.min(760, Math.round(sw * 0.46)));
    let logicalHeight = Math.max(720, Math.min(900, Math.round(sh - 120)));
    try {
      const saved = JSON.parse(global.localStorage?.getItem(MAIN_DIALOG_SIZE_KEY) || "null");
      const savedW = Number(saved?.width);
      const savedH = Number(saved?.height);
      if (Number.isFinite(savedW) && savedW >= 420) logicalWidth = Math.min(maxW, Math.max(420, Math.round(savedW)));
      if (Number.isFinite(savedH) && savedH >= 520) logicalHeight = Math.min(maxH, Math.max(520, Math.round(savedH)));
    } catch (e) {}
    return {
      width: Math.round(logicalWidth * dpr),
      height: Math.round(logicalHeight * dpr),
      logicalWidth,
      logicalHeight
    };
  }
'''


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def marker_for(name: str) -> str:
    return APP_MARKER if name in APP_TARGETS else ADAPTER_MARKER


def status() -> tuple[bool, dict]:
    info = {}
    ok = True
    for name, path in TARGETS.items():
        exists = path.exists()
        text = path.read_text("utf-8") if exists else ""
        installed = marker_for(name) in text
        info[name] = {"path": str(path), "exists": exists, "installed": installed, "sha256": sha256(path) if exists else None}
        ok = ok and exists and installed
    app_hashes = {info[n]["sha256"] for n in APP_TARGETS if info[n]["sha256"]}
    adapter_hashes = {info[n]["sha256"] for n in ADAPTER_TARGETS if info[n]["sha256"]}
    info["app_copies_match"] = len(app_hashes) == 1
    info["adapter_copies_match"] = len(adapter_hashes) == 1
    ok = ok and info["app_copies_match"] and info["adapter_copies_match"]
    return ok, info


def patch_app(text: str) -> str:
    if APP_MARKER in text:
        return text
    if text.count(APP_OLD_RESIZE) != 1 or text.count(APP_OLD_FLOATING) != 1:
        raise ValueError("app anchor mismatch")
    return text.replace(APP_OLD_RESIZE, APP_NEW_RESIZE, 1).replace(APP_OLD_FLOATING, APP_NEW_FLOATING, 1)


def patch_adapter(text: str) -> str:
    if ADAPTER_MARKER in text:
        return text
    if text.count(ADAPTER_OLD) != 1:
        raise ValueError("adapter anchor mismatch")
    return text.replace(ADAPTER_OLD, ADAPTER_NEW, 1)


def install() -> int:
    missing = [str(p) for p in TARGETS.values() if not p.exists()]
    if missing:
        print("missing targets: " + ", ".join(missing), file=sys.stderr)
        return 2
    texts = {name: path.read_text("utf-8") for name, path in TARGETS.items()}
    if all(marker_for(name) in text for name, text in texts.items()):
        ok, info = status(); print(json.dumps(info, ensure_ascii=False, indent=2)); return 0 if ok else 3
    try:
        patched = {name: (patch_app(text) if name in APP_TARGETS else patch_adapter(text)) for name, text in texts.items()}
    except ValueError as exc:
        print(str(exc), file=sys.stderr); return 4

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    manifest = {"createdAt": stamp, "targets": {}}
    for name, path in TARGETS.items():
        backup = backup_dir / f"{name}.js"
        shutil.copy2(path, backup)
        manifest["targets"][name] = {"path": str(path), "backup": str(backup), "marker": marker_for(name)}
    (backup_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    for name, path in TARGETS.items():
        path.write_text(patched[name], "utf-8")
    ok, info = status(); info["backup"] = str(backup_dir)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0 if ok else 5


def backup_dirs() -> list[Path]:
    return sorted((p for p in BACKUP_ROOT.iterdir() if p.is_dir())) if BACKUP_ROOT.exists() else []


def find_prepatch_backup(target: Path, marker: str) -> Path | None:
    for d in backup_dirs():
        mp = d / "manifest.json"
        if not mp.exists(): continue
        try: manifest = json.loads(mp.read_text("utf-8"))
        except Exception: continue
        for item in manifest.get("targets", {}).values():
            if Path(item.get("path", "")) != target: continue
            p = Path(item.get("backup", ""))
            if p.exists() and marker not in p.read_text("utf-8"): return p
    return None


def remove() -> int:
    restored = {}
    for name, target in TARGETS.items():
        src = find_prepatch_backup(target, marker_for(name))
        if not src:
            print(f"no pre-patch backup for {target}", file=sys.stderr); return 2
        shutil.copy2(src, target); restored[name] = str(src)
    print(json.dumps({"restored": restored}, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group()
    g.add_argument("--check", action="store_true")
    g.add_argument("--remove", action="store_true")
    args = p.parse_args()
    if args.check:
        ok, info = status(); print(json.dumps(info, ensure_ascii=False, indent=2)); return 0 if ok else 1
    if args.remove: return remove()
    return install()


if __name__ == "__main__":
    raise SystemExit(main())
