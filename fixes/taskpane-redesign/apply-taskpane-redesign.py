#!/usr/bin/env python3
"""Install/check/remove the reversible Lingxi Graphite TaskPane redesign."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
FIX_DIR = HOME / ".lingxi-ai" / "fixes" / "taskpane-redesign"
REFERENCE_FIX_DIR = HOME / ".lingxi-ai" / "fixes" / "agent-references"
SOURCE_CSS = FIX_DIR / "lingxi-graphite-taskpane.css"
SOURCE_JS = FIX_DIR / "lingxi-graphite-taskpane.js"
SOURCE_REFERENCE_JS = REFERENCE_FIX_DIR / "lingxi-agent-references.js"
TARGET_CSS_REL = Path("css/lingxi-graphite-taskpane.css")
TARGET_JS_REL = Path("js/lingxi-graphite-taskpane.js")
TARGET_REFERENCE_JS_REL = Path("js/lingxi-agent-references.js")
TARGETS = [
    HOME / ".lingxi-ai" / "plugin-wps",
    HOME / ".lingxi-ai" / "plugin-et",
    HOME / ".lingxi-ai" / "plugin-wpp",
    HOME / ".lingxi-ai" / "plugin-pdf",
    HOME / "Library" / "Application Support" / "LingxiAI" / "plugin",
]

BASELINE = {
    "taskpane.html": "44d76cda819a618d3a15a9939884d4011d8b164d8968d8b1255da0cc8b556028",
    "css/style.css": "52a125183a1fa701909dfc35db0214eb118018cd246b06b1dbefb3ad0cbc43b8",
    "js/app.js": "d772b74c575b3a53fd5ab112eccd5da1e751db13d67527d53c4e47f7a6ca2389",
}

CSS_START = "<!-- LINGXI_GRAPHITE_TASKPANE_V1_CSS_START -->"
CSS_END = "<!-- LINGXI_GRAPHITE_TASKPANE_V1_CSS_END -->"
JS_START = "<!-- LINGXI_GRAPHITE_TASKPANE_V1_JS_START -->"
JS_END = "<!-- LINGXI_GRAPHITE_TASKPANE_V1_JS_END -->"
CSS_BLOCK = f'''{CSS_START}\n    <link rel="stylesheet" href="./css/lingxi-graphite-taskpane.css" />\n    {CSS_END}'''
JS_BLOCK = f'''{JS_START}\n    <script src="./js/lingxi-agent-references.js"></script>\n    <script src="./js/lingxi-graphite-taskpane.js"></script>\n    {JS_END}'''

REQUIRED_IDS = [
    "modelSelect", "modelSelectBtn", "refreshModelsBtn", "newConversationBtn",
    "conversationsMenuBtn", "forceUnlockBtn", "chatFoldToggle", "dockToggleBtn",
    "openSettingsModalBtn", "chatStream", "chatInput", "chatAttachBtn",
    "chatModelOverrideBtn", "capThinking", "chatSendBtn", "chatStopBtn",
    "reviseModeBar", "reviseModeToggle", "reviseAcceptAllBtn", "reviseRejectAllBtn",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def strip_block(text: str, start: str, end: str) -> str:
    pattern = re.compile(r"\n?[ \t]*" + re.escape(start) + r".*?" + re.escape(end) + r"[ \t]*\n?", re.S)
    return pattern.sub("\n", text)


def strip_managed_blocks(text: str) -> str:
    text = strip_block(text, CSS_START, CSS_END)
    text = strip_block(text, JS_START, JS_END)
    return text


def normalize_clean_text(text: str) -> str:
    text = strip_managed_blocks(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def inject(text: str) -> str:
    clean = normalize_clean_text(text)
    style_anchor = '    <link rel="stylesheet" href="./css/style.css" />'
    if style_anchor not in clean:
        raise RuntimeError("找不到 css/style.css 注入锚点")
    if "</body>" not in clean:
        raise RuntimeError("找不到 </body> 注入锚点")
    clean = clean.replace(style_anchor, style_anchor + "\n    " + CSS_BLOCK, 1)
    clean = clean.replace("  </body>", "    " + JS_BLOCK + "\n  </body>", 1)
    return clean


def target_key(root: Path) -> str:
    if root.parent.name == "LingxiAI":
        return "application-support-plugin"
    return root.name


def atomic_write(path: Path, content: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp-lingxi-graphite")
    tmp.write_text(content, encoding="utf-8")
    os.chmod(tmp, path.stat().st_mode & 0o777)
    tmp.replace(path)


def backup_targets(reason: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = FIX_DIR / "backups" / stamp
    manifest = {"createdAt": datetime.now().isoformat(), "reason": reason, "targets": []}
    for root in TARGETS:
        entry = {"root": str(root), "files": {}}
        out = backup / target_key(root)
        out.mkdir(parents=True, exist_ok=True)
        for rel in [Path("taskpane.html"), TARGET_CSS_REL, TARGET_REFERENCE_JS_REL, TARGET_JS_REL]:
            src = root / rel
            if src.exists():
                dest = out / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                entry["files"][str(rel)] = sha256(src)
        manifest["targets"].append(entry)
    backup.mkdir(parents=True, exist_ok=True)
    (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return backup


def validate_source() -> None:
    for path in [SOURCE_CSS, SOURCE_REFERENCE_JS, SOURCE_JS]:
        if not path.is_file():
            raise RuntimeError(f"缺少补丁源文件: {path}")
    css = SOURCE_CSS.read_text(encoding="utf-8")
    js = SOURCE_JS.read_text(encoding="utf-8")
    if "LINGXI_GRAPHITE_TASKPANE_V1" not in css or "LINGXI_GRAPHITE_TASKPANE_V1" not in js:
        raise RuntimeError("补丁源文件缺少版本标记")
    if "width: 15px" not in css or ".lg-context-ring" not in css:
        raise RuntimeError("上下文圆环不是已确认的 15px")
    if "voice" in js.lower() or "microphone" in js.lower():
        raise RuntimeError("补丁不应添加语音输入")


def validate_baseline(root: Path) -> None:
    taskpane = root / "taskpane.html"
    if not taskpane.is_file():
        raise RuntimeError(f"缺少 taskpane.html: {root}")
    clean = normalize_clean_text(taskpane.read_text(encoding="utf-8"))
    # Exact source check protects against silently patching an unknown upstream release.
    original = taskpane.read_text(encoding="utf-8")
    if CSS_START not in original and JS_START not in original:
        if sha256(taskpane) != BASELINE["taskpane.html"]:
            raise RuntimeError(f"未知 taskpane.html 基线，拒绝安装: {root}")
    else:
        # Managed block stripping can normalize adjacent blank lines; verify required IDs instead.
        for rid in REQUIRED_IDS:
            if f'id="{rid}"' not in clean:
                raise RuntimeError(f"清理补丁后缺少业务 ID {rid}: {root}")
    for rel in [Path("css/style.css"), Path("js/app.js")]:
        path = root / rel
        if not path.is_file() or sha256(path) != BASELINE[str(rel)]:
            raise RuntimeError(f"业务文件基线变化，拒绝安装: {path}")


def apply() -> None:
    validate_source()
    for root in TARGETS:
        validate_baseline(root)
    backup = backup_targets("apply")
    for root in TARGETS:
        taskpane = root / "taskpane.html"
        content = inject(taskpane.read_text(encoding="utf-8"))
        atomic_write(taskpane, content)
        css_target = root / TARGET_CSS_REL
        reference_js_target = root / TARGET_REFERENCE_JS_REL
        js_target = root / TARGET_JS_REL
        css_target.parent.mkdir(parents=True, exist_ok=True)
        reference_js_target.parent.mkdir(parents=True, exist_ok=True)
        js_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE_CSS, css_target)
        shutil.copy2(SOURCE_REFERENCE_JS, reference_js_target)
        shutil.copy2(SOURCE_JS, js_target)
    print(f"APPLIED {len(TARGETS)} targets")
    print(f"BACKUP {backup}")
    check()


def remove() -> None:
    backup = backup_targets("remove")
    changed = 0
    for root in TARGETS:
        taskpane = root / "taskpane.html"
        if taskpane.exists():
            before = taskpane.read_text(encoding="utf-8")
            after = normalize_clean_text(before)
            if after != before:
                atomic_write(taskpane, after)
                changed += 1
        for rel in [TARGET_CSS_REL, TARGET_REFERENCE_JS_REL, TARGET_JS_REL]:
            path = root / rel
            if path.exists():
                path.unlink()
    print(f"REMOVED managed blocks from {changed} targets")
    print(f"BACKUP {backup}")


def check() -> None:
    validate_source()
    source_css_hash = sha256(SOURCE_CSS)
    source_reference_js_hash = sha256(SOURCE_REFERENCE_JS)
    source_js_hash = sha256(SOURCE_JS)
    errors = []
    rows = []
    for root in TARGETS:
        taskpane = root / "taskpane.html"
        css_target = root / TARGET_CSS_REL
        reference_js_target = root / TARGET_REFERENCE_JS_REL
        js_target = root / TARGET_JS_REL
        if not taskpane.exists():
            errors.append(f"missing taskpane: {root}")
            continue
        text = taskpane.read_text(encoding="utf-8")
        counts = {
            "cssStart": text.count(CSS_START), "cssEnd": text.count(CSS_END),
            "jsStart": text.count(JS_START), "jsEnd": text.count(JS_END),
        }
        if any(v != 1 for v in counts.values()):
            errors.append(f"marker count {counts}: {root}")
        for rid in REQUIRED_IDS:
            if f'id="{rid}"' not in text:
                errors.append(f"missing id {rid}: {root}")
        if not css_target.exists() or sha256(css_target) != source_css_hash:
            errors.append(f"css mismatch: {root}")
        if not reference_js_target.exists() or sha256(reference_js_target) != source_reference_js_hash:
            errors.append(f"agent references js mismatch: {root}")
        if not js_target.exists() or sha256(js_target) != source_js_hash:
            errors.append(f"js mismatch: {root}")
        for rel in [Path("css/style.css"), Path("js/app.js")]:
            path = root / rel
            if not path.exists() or sha256(path) != BASELINE[str(rel)]:
                errors.append(f"business hash changed: {path}")
        rows.append({"root": str(root), "counts": counts})
    if errors:
        print("CHECK FAILED")
        for error in errors:
            print("-", error)
        raise SystemExit(1)
    print(json.dumps({"status": "ok", "targets": rows, "cssSha256": source_css_hash, "agentReferencesJsSha256": source_reference_js_hash, "jsSha256": source_js_hash}, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--apply", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.apply:
        apply()
    elif args.check:
        check()
    else:
        remove()


if __name__ == "__main__":
    main()
