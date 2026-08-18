#!/usr/bin/env python3
"""Install/check/remove Lingxi Writer Inspector phase 1 without touching existing tool code."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BASE_MARKER = "LINGXI_WRITER_INSPECTOR_PHASE1_V1"
HOST_MARKER = BASE_MARKER + "_HOST"
TOOLS_MARKER = BASE_MARKER + "_TOOLS"
HOST_LOAD_AFTER = '    "js/hosts/writer.js",'
TOOLS_LOAD_AFTER = '    "js/tools/writer.js",'
HOST_LOAD_LINE = f'    "js/hosts/writer-inspector.js", // {HOST_MARKER}'
TOOLS_LOAD_LINE = f'    "js/tools/writer-inspector.js", // {TOOLS_MARKER}'

HOME = Path.home()
FIX_DIR = Path(__file__).resolve().parent
SOURCE_HOST = FIX_DIR / "writer-inspector-host.js"
SOURCE_TOOLS = FIX_DIR / "writer-inspector-tools.js"
BACKUP_ROOT = FIX_DIR / "backups"
ROOTS = [
    ("plugin-wps", HOME / ".lingxi-ai/plugin-wps"),
    ("plugin-et", HOME / ".lingxi-ai/plugin-et"),
    ("plugin-wpp", HOME / ".lingxi-ai/plugin-wpp"),
    ("plugin-pdf", HOME / ".lingxi-ai/plugin-pdf"),
    ("install-source", HOME / "Library/Application Support/LingxiAI/plugin"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-writer-inspector")
    temp.write_bytes(content)
    if mode is not None:
        os.chmod(temp, mode)
    os.replace(temp, path)


def require_sources() -> None:
    for source in (SOURCE_HOST, SOURCE_TOOLS):
        if not source.is_file():
            raise RuntimeError(f"缺少安装源：{source}")
        text = source.read_text("utf-8")
        if BASE_MARKER not in text:
            raise RuntimeError(f"安装源缺少版本标记：{source}")


def preflight_roots() -> None:
    for label, root in ROOTS:
        main = root / "main.js"
        if not main.is_file():
            raise RuntimeError(f"目标不存在：{label}: {main}")
        text = main.read_text("utf-8")
        if text.count(HOST_LOAD_AFTER) != 1:
            raise RuntimeError(f"{label} 的宿主加载锚点不是唯一值")
        if text.count(TOOLS_LOAD_AFTER) != 1:
            raise RuntimeError(f"{label} 的工具加载锚点不是唯一值")


def install_text(original: str) -> str:
    text = original
    if HOST_MARKER not in text:
        text = text.replace(HOST_LOAD_AFTER, HOST_LOAD_AFTER + "\n" + HOST_LOAD_LINE, 1)
    if TOOLS_MARKER not in text:
        text = text.replace(TOOLS_LOAD_AFTER, TOOLS_LOAD_AFTER + "\n" + TOOLS_LOAD_LINE, 1)
    if text.count(HOST_MARKER) != 1 or text.count(TOOLS_MARKER) != 1:
        raise RuntimeError("安装标记数量异常，拒绝写入")
    return text


def remove_text(original: str) -> str:
    lines = original.splitlines(keepends=True)
    kept = [line for line in lines if HOST_MARKER not in line and TOOLS_MARKER not in line]
    return "".join(kept)


def make_backup(operation: str) -> tuple[Path, dict]:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    suffix = 1
    while backup_dir.exists():
        backup_dir = BACKUP_ROOT / f"{stamp}-{suffix}"
        suffix += 1
    backup_dir.mkdir(parents=True)
    manifest: dict = {"version": BASE_MARKER, "operation": operation, "createdAt": datetime.now().isoformat(), "roots": {}}
    for label, root in ROOTS:
        target_dir = backup_dir / label
        target_dir.mkdir(parents=True)
        entries = {}
        for rel in ("main.js", "js/hosts/writer-inspector.js", "js/tools/writer-inspector.js"):
            path = root / rel
            item = {"existed": path.exists()}
            if path.is_file():
                dst = target_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dst)
                item["sha256"] = sha256(path)
            entries[rel] = item
        manifest["roots"][label] = {"path": str(root), "files": entries}
    (backup_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return backup_dir, manifest


def apply() -> int:
    require_sources()
    preflight_roots()
    prepared = []
    for label, root in ROOTS:
        main = root / "main.js"
        before = main.read_text("utf-8")
        prepared.append((label, root, before, install_text(before)))
    backup_dir, _ = make_backup("apply")
    host_bytes = SOURCE_HOST.read_bytes()
    tools_bytes = SOURCE_TOOLS.read_bytes()
    for label, root, before, after in prepared:
        mode = (root / "main.js").stat().st_mode & 0o777
        if before != after:
            atomic_write(root / "main.js", after.encode("utf-8"), mode)
        atomic_write(root / "js/hosts/writer-inspector.js", host_bytes, 0o644)
        atomic_write(root / "js/tools/writer-inspector.js", tools_bytes, 0o644)
    print(json.dumps({"ok": True, "operation": "apply", "backup": str(backup_dir), "roots": [label for label, _ in ROOTS]}, ensure_ascii=False, indent=2))
    return 0


def remove() -> int:
    preflight_roots()
    for label, root in ROOTS:
        for rel in ("js/hosts/writer-inspector.js", "js/tools/writer-inspector.js"):
            path = root / rel
            if path.is_file() and BASE_MARKER not in path.read_text("utf-8", errors="ignore"):
                raise RuntimeError(f"{label} 的 {rel} 不属于本补丁，拒绝删除")
    backup_dir, _ = make_backup("remove")
    for label, root in ROOTS:
        main = root / "main.js"
        before = main.read_text("utf-8")
        after = remove_text(before)
        if before != after:
            atomic_write(main, after.encode("utf-8"), main.stat().st_mode & 0o777)
        for rel in ("js/hosts/writer-inspector.js", "js/tools/writer-inspector.js"):
            path = root / rel
            if path.exists():
                path.unlink()
    print(json.dumps({"ok": True, "operation": "remove", "backup": str(backup_dir)}, ensure_ascii=False, indent=2))
    return 0


def node_check(path: Path) -> tuple[bool, str]:
    try:
        proc = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True, timeout=30)
        detail = (proc.stderr or proc.stdout or "ok").strip()
        return proc.returncode == 0, detail
    except Exception as exc:
        return False, str(exc)


def check() -> int:
    require_sources()
    results = []
    host_hashes = set()
    tools_hashes = set()
    all_ok = True
    for label, root in ROOTS:
        main = root / "main.js"
        host = root / "js/hosts/writer-inspector.js"
        tools = root / "js/tools/writer-inspector.js"
        text = main.read_text("utf-8") if main.is_file() else ""
        markers_ok = text.count(HOST_MARKER) == 1 and text.count(TOOLS_MARKER) == 1
        order_ok = bool(text) and text.find(HOST_LOAD_AFTER) < text.find(HOST_MARKER) < text.find(TOOLS_LOAD_AFTER) < text.find(TOOLS_MARKER)
        files_ok = host.is_file() and tools.is_file()
        syntax = {}
        for name, path in (("main", main), ("host", host), ("tools", tools)):
            ok, detail = node_check(path) if path.is_file() else (False, "missing")
            syntax[name] = {"ok": ok, "detail": detail}
        item_ok = markers_ok and order_ok and files_ok and all(value["ok"] for value in syntax.values())
        if host.is_file(): host_hashes.add(sha256(host))
        if tools.is_file(): tools_hashes.add(sha256(tools))
        results.append({
            "root": label,
            "path": str(root),
            "installed": item_ok,
            "markersOk": markers_ok,
            "orderOk": order_ok,
            "filesOk": files_ok,
            "syntax": syntax,
            "mainSha256": sha256(main) if main.is_file() else None,
            "hostSha256": sha256(host) if host.is_file() else None,
            "toolsSha256": sha256(tools) if tools.is_file() else None,
        })
        all_ok = all_ok and item_ok
    copies_ok = len(host_hashes) == 1 and len(tools_hashes) == 1
    all_ok = all_ok and copies_ok
    output = {"ok": all_ok, "version": BASE_MARKER, "copiesIdentical": copies_ok, "results": results}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if all_ok else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--apply", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.apply:
        return apply()
    if args.remove:
        return remove()
    return check()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
