#!/usr/bin/env python3
"""Install, check, or remove the LingxiAI adaptive macOS window-size patch."""

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
BACKUP_ROOT = FIX_DIR / "backups"
TARGETS = {
    "runtime-wps": HOME / ".lingxi-ai" / "plugin-wps" / "js" / "wps-addon-adapter.js",
    "runtime-et": HOME / ".lingxi-ai" / "plugin-et" / "js" / "wps-addon-adapter.js",
    "runtime-wpp": HOME / ".lingxi-ai" / "plugin-wpp" / "js" / "wps-addon-adapter.js",
    "runtime-pdf": HOME / ".lingxi-ai" / "plugin-pdf" / "js" / "wps-addon-adapter.js",
    "source": HOME / "Library" / "Application Support" / "LingxiAI" / "plugin" / "js" / "wps-addon-adapter.js",
}
MARKER = "LINGXI_MACOS_ADAPTIVE_DIALOG_SIZE_V1"

OLD = '''  function openTaskPaneAsDialogWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html?pane=dialog`;
    const title = "灵犀AI";
    const width = Math.round(420 * (global.devicePixelRatio || 1));
    const height = Math.round(720 * (global.devicePixelRatio || 1));
'''

NEW = '''  // LINGXI_MACOS_ADAPTIVE_DIALOG_SIZE_V1
  // macOS/Linux 主聊天使用 ShowDialog 以避开 docked TaskPane 的键盘焦点冲突。
  // ShowDialog 不提供可靠的运行时拖拽缩放句柄，因此在打开时按屏幕可用区选择
  // 更适合长对话阅读的尺寸；所有数值先按 CSS 逻辑像素计算，再换算 Retina DPR。
  function pickMainDialogSize() {
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

  function openTaskPaneAsDialogWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html?pane=dialog`;
    const title = "灵犀AI";
    const mainDialogSize = pickMainDialogSize();
    const width = mainDialogSize.width;
    const height = mainDialogSize.height;
'''


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def status() -> tuple[bool, dict]:
    result = {}
    ok = True
    for name, path in TARGETS.items():
        exists = path.exists()
        text = path.read_text("utf-8") if exists else ""
        installed = MARKER in text
        result[name] = {
            "path": str(path),
            "exists": exists,
            "installed": installed,
            "sha256": sha256(path) if exists else None,
        }
        ok = ok and exists and installed
    hashes = {v["sha256"] for v in result.values() if v["sha256"]}
    result["copies_match"] = len(hashes) == 1 and len(hashes) > 0
    ok = ok and result["copies_match"]
    return ok, result


def install() -> int:
    missing = [str(p) for p in TARGETS.values() if not p.exists()]
    if missing:
        print("missing targets: " + ", ".join(missing), file=sys.stderr)
        return 2

    texts = {name: path.read_text("utf-8") for name, path in TARGETS.items()}
    if all(MARKER in text for text in texts.values()):
        ok, info = status()
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0 if ok else 3

    for name, text in texts.items():
        if MARKER not in text and text.count(OLD) != 1:
            print(f"anchor mismatch: {TARGETS[name]}", file=sys.stderr)
            return 4

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    manifest = {"createdAt": stamp, "targets": {}}

    for name, path in TARGETS.items():
        backup = backup_dir / f"{name}-wps-addon-adapter.js"
        shutil.copy2(path, backup)
        manifest["targets"][name] = {"path": str(path), "backup": str(backup)}

    (backup_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8"
    )

    for name, path in TARGETS.items():
        text = texts[name]
        if MARKER not in text:
            path.write_text(text.replace(OLD, NEW, 1), "utf-8")

    ok, info = status()
    info["backup"] = str(backup_dir)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0 if ok else 5


def backup_dirs() -> list[Path]:
    if not BACKUP_ROOT.exists():
        return []
    return sorted(p for p in BACKUP_ROOT.iterdir() if p.is_dir())


def find_original_backup(target: Path) -> Path | None:
    # A later incremental install may have backed up an already-patched copy.
    # Walk every manifest from oldest to newest and choose the first backup for
    # this exact path that does not contain the patch marker.
    for backup_dir in backup_dirs():
        manifest_path = backup_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text("utf-8"))
        except Exception:
            continue
        for item in manifest.get("targets", {}).values():
            if Path(item.get("path", "")) != target:
                continue
            candidate = Path(item.get("backup", ""))
            if candidate.exists() and MARKER not in candidate.read_text("utf-8"):
                return candidate
    return None


def remove() -> int:
    restored = {}
    for name, target in TARGETS.items():
        src = find_original_backup(target)
        if not src:
            print(f"no original backup found for: {target}", file=sys.stderr)
            return 2
        shutil.copy2(src, target)
        restored[name] = str(src)
    print(json.dumps({"restored": restored}, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true")
    group.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.check:
        ok, info = status()
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    if args.remove:
        return remove()
    return install()


if __name__ == "__main__":
    raise SystemExit(main())
