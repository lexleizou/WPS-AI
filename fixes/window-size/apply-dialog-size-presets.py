#!/usr/bin/env python3
"""Install/check/remove LingxiAI macOS dialog size presets."""
from __future__ import annotations

import argparse, hashlib, json, shutil, sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
BACKUP_ROOT = HOME / ".lingxi-ai" / "fixes" / "window-size" / "preset-backups"
HOSTS = ("wps", "et", "wpp", "pdf")
HTML_TARGETS = {
    **{f"runtime-{h}-html": HOME / ".lingxi-ai" / f"plugin-{h}" / "taskpane.html" for h in HOSTS},
    "source-html": HOME / "Library" / "Application Support" / "LingxiAI" / "plugin" / "taskpane.html",
}
APP_TARGETS = {
    **{f"runtime-{h}-app": HOME / ".lingxi-ai" / f"plugin-{h}" / "js" / "app.js" for h in HOSTS},
    "source-app": HOME / "Library" / "Application Support" / "LingxiAI" / "plugin" / "js" / "app.js",
}
TARGETS = {**HTML_TARGETS, **APP_TARGETS}
HTML_MARKER = "LINGXI_DIALOG_SIZE_PRESET_BUTTON_V1"
APP_MARKER = "LINGXI_DIALOG_SIZE_PRESETS_V1"

HTML_OLD = '''          <span id="dockToggleLabel">脱离</span>
        </button>
        <button type="button" id="openSettingsModalBtn" class="tab-bar-action" title="服务配置" aria-label="服务配置">
'''
HTML_NEW = '''          <span id="dockToggleLabel">脱离</span>
        </button>
        <!-- LINGXI_DIALOG_SIZE_PRESET_BUTTON_V1: macOS ShowDialog 不支持运行时 resize，改用下次打开尺寸预设 -->
        <button type="button" id="dialogSizeBtn" class="tab-bar-action hidden" title="窗口大小：标准" aria-label="切换窗口大小">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>
          </svg>
          <span id="dialogSizeLabel">标准</span>
        </button>
        <button type="button" id="openSettingsModalBtn" class="tab-bar-action" title="服务配置" aria-label="服务配置">
'''

APP_OLD_ELS = '''      // TaskPane 停靠/浮动切换
      "dockToggleBtn", "dockToggleIcon", "dockToggleLabel",
'''
APP_NEW_ELS = '''      // TaskPane 停靠/浮动切换 + macOS 独立窗口尺寸预设
      "dockToggleBtn", "dockToggleIcon", "dockToggleLabel", "dialogSizeBtn", "dialogSizeLabel",
'''

APP_OLD_FLOATING = '''    // Mac/Linux 主面板是独立 ShowDialog：隐藏停靠按钮，但启用页面内拖拽抓手。
    if (preferFloatingPanel()) {
      els.dockToggleBtn.classList.add("hidden");
      document.body?.classList.toggle("is-floating", isMainDialogWindow());
      return;
    }
'''
APP_NEW_FLOATING = '''    // Mac/Linux 主面板是固定边框的独立 ShowDialog：隐藏停靠按钮和无效拖拽抓手。
    if (preferFloatingPanel()) {
      els.dockToggleBtn.classList.add("hidden");
      document.body?.classList.remove("is-floating");
      return;
    }
'''

APP_FUNCTION_ANCHOR = '''
  function openSettingsModal(panel, subtab) {
'''
APP_FUNCTIONS = '''
  // LINGXI_DIALOG_SIZE_PRESETS_V1
  // macOS WPS ShowDialog 会忽略 window.resizeTo；用三档尺寸写入同源 localStorage，
  // 由 wps-addon-adapter 在下次打开时读取并创建目标尺寸窗口。
  const DIALOG_SIZE_PRESET_KEY = "lingxi_ai_main_dialog_preset_v1";
  const DIALOG_SIZE_STORAGE_KEY = "lingxi_ai_main_dialog_size_v1";
  const DIALOG_SIZE_PRESET_ORDER = ["compact", "standard", "wide"];
  const DIALOG_SIZE_PRESET_LABELS = { compact: "紧凑", standard: "标准", wide: "宽屏" };

  function computeDialogPresetSize(preset) {
    const sw = Number(global.screen?.availWidth || global.screen?.width) || 1440;
    const sh = Number(global.screen?.availHeight || global.screen?.height) || 900;
    const maxW = Math.max(420, sw - 40);
    const maxH = Math.max(520, sh - 40);
    if (preset === "compact") {
      return { width: Math.min(maxW, 520), height: Math.min(maxH, 720) };
    }
    if (preset === "wide") {
      return {
        width: Math.min(maxW, Math.min(960, Math.max(820, Math.round(sw * 0.62)))),
        height: Math.min(maxH, 900)
      };
    }
    return {
      width: Math.min(maxW, Math.max(620, Math.min(760, Math.round(sw * 0.46)))),
      height: Math.min(maxH, Math.max(720, Math.min(900, Math.round(sh - 120))))
    };
  }

  function renderDialogSizePreset(preset) {
    const label = DIALOG_SIZE_PRESET_LABELS[preset] || DIALOG_SIZE_PRESET_LABELS.standard;
    if (els.dialogSizeLabel) els.dialogSizeLabel.textContent = label;
    if (els.dialogSizeBtn) els.dialogSizeBtn.title = `窗口大小：${label}（点击切换；重新打开后生效）`;
  }

  function initDialogSizePresetButton() {
    if (!els.dialogSizeBtn) return;
    if (!isMainDialogWindow()) {
      els.dialogSizeBtn.classList.add("hidden");
      return;
    }
    els.dialogSizeBtn.classList.remove("hidden");
    let current = "standard";
    try {
      const saved = global.localStorage?.getItem(DIALOG_SIZE_PRESET_KEY);
      if (DIALOG_SIZE_PRESET_ORDER.includes(saved)) current = saved;
    } catch (e) {}
    renderDialogSizePreset(current);
    els.dialogSizeBtn.addEventListener("click", () => {
      const idx = DIALOG_SIZE_PRESET_ORDER.indexOf(current);
      current = DIALOG_SIZE_PRESET_ORDER[(idx + 1 + DIALOG_SIZE_PRESET_ORDER.length) % DIALOG_SIZE_PRESET_ORDER.length];
      const size = computeDialogPresetSize(current);
      try {
        global.localStorage?.setItem(DIALOG_SIZE_PRESET_KEY, current);
        global.localStorage?.setItem(DIALOG_SIZE_STORAGE_KEY, JSON.stringify({
          width: size.width, height: size.height, preset: current, updatedAt: Date.now()
        }));
      } catch (e) {}
      renderDialogSizePreset(current);
      showMessage(`窗口大小已设为${DIALOG_SIZE_PRESET_LABELS[current]}（${size.width}×${size.height}），关闭并重新打开灵犀AI后生效。`, "info");
    });
  }
'''

APP_OLD_INIT = '''    refreshDockToggleUI();
    bindFloatingResizeHandles();
'''
APP_NEW_INIT = '''    refreshDockToggleUI();
    bindFloatingResizeHandles();
    initDialogSizePresetButton();
'''


def marker(name): return HTML_MARKER if name in HTML_TARGETS else APP_MARKER

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def patch_html(text):
    if HTML_MARKER in text: return text
    if text.count(HTML_OLD) != 1: raise ValueError("html anchor mismatch")
    return text.replace(HTML_OLD, HTML_NEW, 1)

def patch_app(text):
    if APP_MARKER in text: return text
    anchors = (APP_OLD_ELS, APP_OLD_FLOATING, APP_FUNCTION_ANCHOR, APP_OLD_INIT)
    if any(text.count(a) != 1 for a in anchors): raise ValueError("app anchor mismatch")
    text = text.replace(APP_OLD_ELS, APP_NEW_ELS, 1)
    text = text.replace(APP_OLD_FLOATING, APP_NEW_FLOATING, 1)
    text = text.replace(APP_FUNCTION_ANCHOR, APP_FUNCTIONS + APP_FUNCTION_ANCHOR, 1)
    return text.replace(APP_OLD_INIT, APP_NEW_INIT, 1)

def status():
    info={}; ok=True
    for name,path in TARGETS.items():
        exists=path.exists(); text=path.read_text('utf-8') if exists else ''
        installed=marker(name) in text
        info[name]={"path":str(path),"exists":exists,"installed":installed,"sha256":sha(path) if exists else None}
        ok=ok and exists and installed
    hh={info[n]['sha256'] for n in HTML_TARGETS if info[n]['sha256']}
    ah={info[n]['sha256'] for n in APP_TARGETS if info[n]['sha256']}
    info['html_copies_match']=len(hh)==1; info['app_copies_match']=len(ah)==1
    return ok and info['html_copies_match'] and info['app_copies_match'],info

def install():
    if any(not p.exists() for p in TARGETS.values()): print('missing target',file=sys.stderr); return 2
    texts={n:p.read_text('utf-8') for n,p in TARGETS.items()}
    if all(marker(n) in t for n,t in texts.items()):
        ok,info=status(); print(json.dumps(info,ensure_ascii=False,indent=2)); return 0 if ok else 3
    try: patched={n:(patch_html(t) if n in HTML_TARGETS else patch_app(t)) for n,t in texts.items()}
    except ValueError as e: print(str(e),file=sys.stderr); return 4
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S'); d=BACKUP_ROOT/stamp; d.mkdir(parents=True)
    manifest={"createdAt":stamp,"targets":{}}
    for n,p in TARGETS.items():
        b=d/f'{n}{p.suffix}'; shutil.copy2(p,b); manifest['targets'][n]={"path":str(p),"backup":str(b),"marker":marker(n)}
    (d/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
    for n,p in TARGETS.items(): p.write_text(patched[n],'utf-8')
    ok,info=status(); info['backup']=str(d); print(json.dumps(info,ensure_ascii=False,indent=2)); return 0 if ok else 5

def backups(): return sorted(p for p in BACKUP_ROOT.iterdir() if p.is_dir()) if BACKUP_ROOT.exists() else []
def find_backup(target,m):
    for d in backups():
        try: data=json.loads((d/'manifest.json').read_text('utf-8'))
        except Exception: continue
        for item in data.get('targets',{}).values():
            p=Path(item.get('backup',''))
            if Path(item.get('path',''))==target and p.exists() and m not in p.read_text('utf-8'): return p
    return None
def remove():
    restored={}
    for n,t in TARGETS.items():
        b=find_backup(t,marker(n))
        if not b: print(f'no backup for {t}',file=sys.stderr); return 2
        shutil.copy2(b,t); restored[n]=str(b)
    print(json.dumps({"restored":restored},ensure_ascii=False,indent=2)); return 0

def main():
    p=argparse.ArgumentParser(); g=p.add_mutually_exclusive_group(); g.add_argument('--check',action='store_true'); g.add_argument('--remove',action='store_true'); a=p.parse_args()
    if a.check:
        ok,info=status(); print(json.dumps(info,ensure_ascii=False,indent=2)); return 0 if ok else 1
    return remove() if a.remove else install()
if __name__=='__main__': raise SystemExit(main())
