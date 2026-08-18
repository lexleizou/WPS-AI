#!/usr/bin/env python3
"""Install/check/remove Writer Format Guard without changing original Writer business assets."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

MARKER = "LINGXI_WRITER_FORMAT_GUARD_V1"
HOST_MARKER = MARKER + "_HOST"
TOOLS_MARKER = MARKER + "_TOOLS"
HOST_AFTER = '    "js/hosts/writer-inspector.js", // LINGXI_WRITER_INSPECTOR_PHASE1_V1_HOST'
TOOLS_AFTER = '    "js/tools/writer-inspector.js", // LINGXI_WRITER_INSPECTOR_PHASE1_V1_TOOLS'
HOST_LINE = f'    "js/hosts/writer-format-guard.js", // {HOST_MARKER}'
TOOLS_LINE = f'    "js/tools/writer-format-guard.js", // {TOOLS_MARKER}'
HOME = Path.home()
ROOT = Path(__file__).resolve().parent
SOURCES = {"js/hosts/writer-format-guard.js": ROOT / "writer-format-guard-host.js", "js/tools/writer-format-guard.js": ROOT / "writer-format-guard-tools.js"}
BACKUPS = ROOT / "backups"
TARGETS = [
    ("plugin-wps", HOME / ".lingxi-ai/plugin-wps"),
    ("plugin-et", HOME / ".lingxi-ai/plugin-et"),
    ("plugin-wpp", HOME / ".lingxi-ai/plugin-wpp"),
    ("plugin-pdf", HOME / ".lingxi-ai/plugin-pdf"),
    ("install-source", HOME / "Library/Application Support/LingxiAI/plugin"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-format-guard")
    temp.write_bytes(content)
    if mode is not None:
        os.chmod(temp, mode)
    os.replace(temp, path)


def verify_sources() -> None:
    for path in SOURCES.values():
        if not path.is_file() or MARKER not in path.read_text("utf-8"):
            raise RuntimeError(f"安装源缺失或无标记：{path}")


def preflight() -> None:
    verify_sources()
    for label, root in TARGETS:
        main = root / "main.js"
        if not main.is_file():
            raise RuntimeError(f"目标不存在：{label}: {main}")
        content = main.read_text("utf-8")
        if content.count(HOST_AFTER) != 1 or content.count(TOOLS_AFTER) != 1:
            raise RuntimeError(f"{label} 缺少唯一的 Phase 1 加载锚点")


def inject(content: str) -> str:
    if HOST_MARKER not in content:
        content = content.replace(HOST_AFTER, HOST_AFTER + "\n" + HOST_LINE, 1)
    if TOOLS_MARKER not in content:
        content = content.replace(TOOLS_AFTER, TOOLS_AFTER + "\n" + TOOLS_LINE, 1)
    if content.count(HOST_MARKER) != 1 or content.count(TOOLS_MARKER) != 1:
        raise RuntimeError("安装标记数量异常")
    return content


def strip(content: str) -> str:
    return "".join(line for line in content.splitlines(keepends=True) if HOST_MARKER not in line and TOOLS_MARKER not in line)


def backup(operation: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dest = BACKUPS / stamp
    dest.mkdir(parents=True)
    manifest = {"version": MARKER, "operation": operation, "createdAt": datetime.now().isoformat(), "targets": {}}
    for label, root in TARGETS:
        files = {}
        for rel in ("main.js", *SOURCES):
            src = root / rel
            files[rel] = {"exists": src.is_file()}
            if src.is_file():
                target = dest / label / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
                files[rel]["sha256"] = sha256(src)
        manifest["targets"][label] = {"path": str(root), "files": files}
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return dest


def node_ok(path: Path) -> bool:
    return path.is_file() and subprocess.run(["node", "--check", str(path)], capture_output=True, text=True, timeout=30).returncode == 0


def apply() -> int:
    preflight()
    prepared = []
    for label, root in TARGETS:
        main = root / "main.js"
        before = main.read_text("utf-8")
        prepared.append((label, root, before, inject(before)))
    dest = backup("apply")
    for _, root, before, after in prepared:
        main = root / "main.js"
        if before != after:
            atomic_write(main, after.encode("utf-8"), main.stat().st_mode & 0o777)
        for rel, source in SOURCES.items():
            atomic_write(root / rel, source.read_bytes(), 0o644)
    print(json.dumps({"ok": True, "operation": "apply", "backup": str(dest), "cssOrBusinessFilesModified": False, "targets": [label for label, _ in TARGETS]}, ensure_ascii=False, indent=2))
    return 0


def remove() -> int:
    preflight()
    for label, root in TARGETS:
        for rel in SOURCES:
            target = root / rel
            if target.is_file() and MARKER not in target.read_text("utf-8", errors="ignore"):
                raise RuntimeError(f"拒绝删除非本补丁文件：{label}/{rel}")
    dest = backup("remove")
    for _, root in TARGETS:
        main = root / "main.js"
        after = strip(main.read_text("utf-8"))
        atomic_write(main, after.encode("utf-8"), main.stat().st_mode & 0o777)
        for rel in SOURCES:
            (root / rel).unlink(missing_ok=True)
    print(json.dumps({"ok": True, "operation": "remove", "backup": str(dest)}, ensure_ascii=False, indent=2))
    return 0


def check() -> int:
    preflight()
    source_hashes = {rel: sha256(source) for rel, source in SOURCES.items()}
    hashes = {rel: set() for rel in SOURCES}
    results = []
    ok = True
    for label, root in TARGETS:
        main = root / "main.js"
        content = main.read_text("utf-8")
        markers = content.count(HOST_MARKER) == 1 and content.count(TOOLS_MARKER) == 1
        order = content.find(HOST_AFTER) < content.find(HOST_MARKER) < content.find(TOOLS_AFTER) < content.find(TOOLS_MARKER)
        files = {}
        for rel in SOURCES:
            path = root / rel
            files[rel] = {"exists": path.is_file(), "syntax": node_ok(path), "sha256": sha256(path) if path.is_file() else None, "matchesSource": path.is_file() and sha256(path) == source_hashes[rel]}
            if path.is_file(): hashes[rel].add(files[rel]["sha256"])
        item_ok = markers and order and all(item["exists"] and item["syntax"] and item["matchesSource"] for item in files.values())
        ok = ok and item_ok
        results.append({"root": label, "markers": markers, "order": order, "files": files, "ok": item_ok})
    copies_identical = all(len(values) == 1 for values in hashes.values())
    ok = ok and copies_identical
    print(json.dumps({"ok": ok, "version": MARKER, "sourceHashes": source_hashes, "copiesIdentical": copies_identical, "results": results}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.apply: return apply()
    if args.remove: return remove()
    return check()

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=os.sys.stderr)
        raise SystemExit(1)
