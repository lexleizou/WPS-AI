#!/usr/bin/env python3
"""Deploy Writer follow feedback as a managed additive asset."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil
from datetime import datetime
from pathlib import Path

HOME = Path.home()
ROOT = Path(__file__).resolve().parent
MARKER = "LINGXI_WRITER_FOLLOW_FEEDBACK_V1"
REL = "js/writer-follow-feedback.js"
SOURCE = ROOT / "writer-follow-feedback.js"
ANCHOR = '    "js/follow-highlight.js", // AI 操作跟随提示：修改型工具成功后滚动/选中改动位置（registry.execute 调用）'
LINE = f'    "{REL}", // {MARKER}'
TARGETS = [("plugin-wps", HOME / ".lingxi-ai/plugin-wps"), ("plugin-et", HOME / ".lingxi-ai/plugin-et"), ("plugin-wpp", HOME / ".lingxi-ai/plugin-wpp"), ("plugin-pdf", HOME / ".lingxi-ai/plugin-pdf"), ("install-source", HOME / "Library/Application Support/LingxiAI/plugin")]
BACKUPS = ROOT / "backups"

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def preflight():
    if not SOURCE.is_file() or MARKER not in SOURCE.read_text(): raise RuntimeError("missing marked source")
    for label, root in TARGETS:
        text = (root / "main.js").read_text()
        if ANCHOR not in text: raise RuntimeError(f"missing load anchor: {label}")
def backup():
    dest = BACKUPS / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dest.mkdir(parents=True)
    manifest = {"marker": MARKER, "targets": {}}
    for label, root in TARGETS:
        files = {}
        for rel in ("main.js", REL):
            src = root / rel
            if src.exists():
                out = dest / label / rel; out.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, out)
                files[rel] = sha(src)
            else: files[rel] = None
        manifest["targets"][label] = {"root": str(root), "files": files}
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return dest
def apply():
    preflight(); dest = backup(); payload = SOURCE.read_bytes()
    for _, root in TARGETS:
        main = root / "main.js"; text = main.read_text()
        if MARKER not in text: text = text.replace(ANCHOR, ANCHOR + "\n" + LINE, 1)
        if text.count(MARKER) != 1: raise RuntimeError(f"duplicate marker: {main}")
        temp = main.with_suffix(".tmp-follow"); temp.write_text(text); os.replace(temp, main)
        out = root / REL; out.parent.mkdir(parents=True, exist_ok=True); temp = out.with_suffix(".tmp-follow"); temp.write_bytes(payload); os.replace(temp, out)
    return {"status": "ok", "backup": str(dest), "source_sha256": sha(SOURCE), "targets": [label for label, _ in TARGETS]}
def check():
    preflight(); result=[]; ok=True
    for label, root in TARGETS:
        main=root/"main.js"; asset=root/REL
        item={"label":label,"mainMarkers":main.read_text().count(MARKER),"asset":asset.exists(),"assetSha256":sha(asset) if asset.exists() else None}
        item["ok"] = item["mainMarkers"] == 1 and item["asset"] and item["assetSha256"] == sha(SOURCE); ok &= item["ok"]; result.append(item)
    return ok, {"status":"ok" if ok else "error", "targets":result}
def remove():
    dest=backup()
    for _, root in TARGETS:
        main=root/"main.js"; main.write_text("\n".join(line for line in main.read_text().splitlines() if MARKER not in line)+"\n")
        (root/REL).unlink(missing_ok=True)
    return {"status":"removed","backup":str(dest)}
if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--check",action="store_true"); parser.add_argument("--remove",action="store_true"); args=parser.parse_args()
    if args.check:
        ok, out=check(); print(json.dumps(out,indent=2)); raise SystemExit(0 if ok else 1)
    print(json.dumps(remove() if args.remove else apply(),indent=2))
