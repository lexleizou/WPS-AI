#!/usr/bin/env python3
"""Install/check/remove the managed Writer safe table-row/range overrides on all Lingxi plugin copies."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, subprocess
from datetime import datetime
from pathlib import Path

MARKER = "LINGXI_WRITER_TABLE_SAFE_TOOLS_V1"
LOAD_MARKER = MARKER + "_LOAD"
AFTER = '    "js/tools/writer.js",'
LINE = f'    "js/tools/writer-table-safe.js", // {LOAD_MARKER}'
HOME, ROOT = Path.home(), Path(__file__).resolve().parent
SOURCE = ROOT / "writer-table-safe.js"
ROOTS = [("plugin-wps", HOME / ".lingxi-ai/plugin-wps"), ("plugin-et", HOME / ".lingxi-ai/plugin-et"), ("plugin-wpp", HOME / ".lingxi-ai/plugin-wpp"), ("plugin-pdf", HOME / ".lingxi-ai/plugin-pdf"), ("install-source", HOME / "Library/Application Support/LingxiAI/plugin")]

def digest(path: Path) -> str: return hashlib.sha256(path.read_bytes()).hexdigest()
def atomic(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-table-safe")
    temp.write_bytes(data)
    if mode is not None: os.chmod(temp, mode)
    os.replace(temp, path)
def preflight() -> None:
    if not SOURCE.is_file() or MARKER not in SOURCE.read_text("utf-8"): raise RuntimeError("安装源缺失或版本标记错误")
    for label, root in ROOTS:
        main = root / "main.js"; text = main.read_text("utf-8") if main.is_file() else ""
        if text.count(AFTER) != 1: raise RuntimeError(f"{label} 的 writer.js 加载锚点不存在或不唯一")
def install_text(text: str) -> str:
    if LOAD_MARKER not in text: text = text.replace(AFTER, AFTER + "\n" + LINE, 1)
    if text.count(LOAD_MARKER) != 1: raise RuntimeError("受管加载标记数量异常")
    return text
def backup(operation: str) -> Path:
    path = ROOT / "backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f"); path.mkdir(parents=True)
    manifest = {"version": MARKER, "operation": operation, "createdAt": datetime.now().isoformat(), "roots": {}}
    for label, root in ROOTS:
        entries = {}
        for rel in ("main.js", "js/tools/writer-table-safe.js"):
            src = root / rel; entries[rel] = {"existed": src.is_file()}
            if src.is_file():
                dst = path / label / rel; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst); entries[rel]["sha256"] = digest(src)
        manifest["roots"][label] = {"path": str(root), "files": entries}
    (path / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return path
def apply() -> int:
    preflight(); prepared = []
    for label, root in ROOTS:
        main = root / "main.js"; before = main.read_text("utf-8"); prepared.append((label, root, before, install_text(before)))
    saved = backup("apply")
    for _, root, before, after in prepared:
        main = root / "main.js"
        if before != after: atomic(main, after.encode(), main.stat().st_mode & 0o777)
        atomic(root / "js/tools/writer-table-safe.js", SOURCE.read_bytes(), 0o644)
    print(json.dumps({"ok": True, "operation": "apply", "backup": str(saved)}, ensure_ascii=False)); return 0
def check() -> int:
    preflight(); results, hashes, ok = [], set(), True
    for label, root in ROOTS:
        main, tool = root / "main.js", root / "js/tools/writer-table-safe.js"
        text = main.read_text("utf-8") if main.is_file() else ""
        marker = text.count(LOAD_MARKER) == 1
        order = text.find(AFTER) < text.find(LOAD_MARKER)
        syntax = tool.is_file() and subprocess.run(["node", "--check", str(tool)], capture_output=True, timeout=30).returncode == 0
        source_marker = tool.is_file() and MARKER in tool.read_text("utf-8")
        item = marker and order and syntax and source_marker; ok = ok and item
        if tool.is_file(): hashes.add(digest(tool))
        results.append({"root": label, "ok": item, "marker": marker, "order": order, "syntax": syntax})
    copies = len(hashes) == 1; ok = ok and copies
    print(json.dumps({"ok": ok, "version": MARKER, "copiesIdentical": copies, "results": results}, ensure_ascii=False, indent=2)); return 0 if ok else 1
def remove() -> int:
    preflight(); saved = backup("remove")
    for _, root in ROOTS:
        main = root / "main.js"; text = "\n".join(line for line in main.read_text("utf-8").split("\n") if LOAD_MARKER not in line)
        atomic(main, text.encode(), main.stat().st_mode & 0o777)
        tool = root / "js/tools/writer-table-safe.js"
        if tool.is_file():
            if MARKER not in tool.read_text("utf-8", errors="ignore"): raise RuntimeError(f"拒绝删除非本补丁文件：{tool}")
            tool.unlink()
    print(json.dumps({"ok": True, "operation": "remove", "backup": str(saved)}, ensure_ascii=False)); return 0

parser = argparse.ArgumentParser(); group = parser.add_mutually_exclusive_group(required=True); group.add_argument("--apply", action="store_true"); group.add_argument("--check", action="store_true"); group.add_argument("--remove", action="store_true"); args = parser.parse_args()
try: raise SystemExit(apply() if args.apply else check() if args.check else remove())
except Exception as error: print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)); raise SystemExit(1)
