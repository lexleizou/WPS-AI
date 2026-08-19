#!/usr/bin/env python3
"""Install/check/remove the managed Writer empty-paragraph and header-cell tools on all Lingxi plugin copies."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, subprocess
from datetime import datetime
from pathlib import Path

MARKER = "LINGXI_WRITER_PARAGRAPH_CELL_TOOLS_V1"
HOST_MARKER, TOOLS_MARKER = MARKER + "_HOST", MARKER + "_TOOLS"
HOST_AFTER, TOOLS_AFTER = '    "js/hosts/writer.js",', '    "js/tools/writer.js",'
HOST_LINE = f'    "js/hosts/writer-paragraph-cell.js", // {HOST_MARKER}'
TOOLS_LINE = f'    "js/tools/writer-paragraph-cell.js", // {TOOLS_MARKER}'
HOME, ROOT = Path.home(), Path(__file__).resolve().parent
HOST_SOURCE, TOOLS_SOURCE = ROOT / "writer-paragraph-cell-host.js", ROOT / "writer-paragraph-cell-tools.js"
ROOTS = [("plugin-wps", HOME / ".lingxi-ai/plugin-wps"), ("plugin-et", HOME / ".lingxi-ai/plugin-et"), ("plugin-wpp", HOME / ".lingxi-ai/plugin-wpp"), ("plugin-pdf", HOME / ".lingxi-ai/plugin-pdf"), ("install-source", HOME / "Library/Application Support/LingxiAI/plugin")]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def atomic(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-paragraph-cell")
    temp.write_bytes(data)
    if mode is not None: os.chmod(temp, mode)
    os.replace(temp, path)

def require_sources() -> None:
    for source in (HOST_SOURCE, TOOLS_SOURCE):
        if not source.is_file() or MARKER not in source.read_text("utf-8"):
            raise RuntimeError(f"安装源缺失或版本标记错误：{source}")

def preflight() -> None:
    for label, root in ROOTS:
        main = root / "main.js"
        text = main.read_text("utf-8") if main.is_file() else ""
        if text.count(HOST_AFTER) != 1 or text.count(TOOLS_AFTER) != 1:
            raise RuntimeError(f"{label} 的加载锚点不存在或不唯一")

def install_text(text: str) -> str:
    if HOST_MARKER not in text: text = text.replace(HOST_AFTER, HOST_AFTER + "\n" + HOST_LINE, 1)
    if TOOLS_MARKER not in text: text = text.replace(TOOLS_AFTER, TOOLS_AFTER + "\n" + TOOLS_LINE, 1)
    if text.count(HOST_MARKER) != 1 or text.count(TOOLS_MARKER) != 1: raise RuntimeError("受管标记数量异常")
    return text

def backup(operation: str) -> Path:
    path = ROOT / "backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path.mkdir(parents=True)
    manifest = {"version": MARKER, "operation": operation, "createdAt": datetime.now().isoformat(), "roots": {}}
    for label, root in ROOTS:
        entries = {}
        for rel in ("main.js", "js/hosts/writer-paragraph-cell.js", "js/tools/writer-paragraph-cell.js"):
            src = root / rel; entries[rel] = {"existed": src.is_file()}
            if src.is_file():
                dst = path / label / rel; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst); entries[rel]["sha256"] = digest(src)
        manifest["roots"][label] = {"path": str(root), "files": entries}
    (path / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return path

def apply() -> int:
    require_sources(); preflight(); prepared = []
    for label, root in ROOTS:
        main = root / "main.js"; before = main.read_text("utf-8"); prepared.append((label, root, before, install_text(before)))
    saved = backup("apply")
    for _, root, before, after in prepared:
        main = root / "main.js"
        if before != after: atomic(main, after.encode(), main.stat().st_mode & 0o777)
        atomic(root / "js/hosts/writer-paragraph-cell.js", HOST_SOURCE.read_bytes(), 0o644)
        atomic(root / "js/tools/writer-paragraph-cell.js", TOOLS_SOURCE.read_bytes(), 0o644)
    print(json.dumps({"ok": True, "operation": "apply", "backup": str(saved)}, ensure_ascii=False)); return 0

def check() -> int:
    require_sources(); results = []; hashes = {"host": set(), "tools": set()}; ok = True
    for label, root in ROOTS:
        main, host, tools = root / "main.js", root / "js/hosts/writer-paragraph-cell.js", root / "js/tools/writer-paragraph-cell.js"
        text = main.read_text("utf-8") if main.is_file() else ""
        markers = text.count(HOST_MARKER) == 1 and text.count(TOOLS_MARKER) == 1
        order = text.find(HOST_AFTER) < text.find(HOST_MARKER) < text.find(TOOLS_AFTER) < text.find(TOOLS_MARKER)
        syntax = all(path.is_file() and subprocess.run(["node", "--check", str(path)], capture_output=True, timeout=30).returncode == 0 for path in (main, host, tools))
        item = markers and order and syntax; ok = ok and item
        if host.is_file(): hashes["host"].add(digest(host))
        if tools.is_file(): hashes["tools"].add(digest(tools))
        results.append({"root": label, "ok": item, "markers": markers, "order": order, "syntax": syntax})
    copies = len(hashes["host"]) == 1 and len(hashes["tools"]) == 1; ok = ok and copies
    print(json.dumps({"ok": ok, "version": MARKER, "copiesIdentical": copies, "results": results}, ensure_ascii=False, indent=2)); return 0 if ok else 1

def remove() -> int:
    preflight(); saved = backup("remove")
    for _, root in ROOTS:
        main = root / "main.js"; text = main.read_text("utf-8")
        for marker in (HOST_MARKER, TOOLS_MARKER): text = "\n".join(line for line in text.split("\n") if marker not in line)
        atomic(main, text.encode(), main.stat().st_mode & 0o777)
        for rel in ("js/hosts/writer-paragraph-cell.js", "js/tools/writer-paragraph-cell.js"):
            path = root / rel
            if path.is_file():
                if MARKER not in path.read_text("utf-8", errors="ignore"): raise RuntimeError(f"拒绝删除非本补丁文件：{path}")
                path.unlink()
    print(json.dumps({"ok": True, "operation": "remove", "backup": str(saved)}, ensure_ascii=False)); return 0

parser = argparse.ArgumentParser(); group = parser.add_mutually_exclusive_group(required=True); group.add_argument("--apply", action="store_true"); group.add_argument("--check", action="store_true"); group.add_argument("--remove", action="store_true"); args = parser.parse_args()
try: raise SystemExit(apply() if args.apply else check() if args.check else remove())
except Exception as error: print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)); raise SystemExit(1)
