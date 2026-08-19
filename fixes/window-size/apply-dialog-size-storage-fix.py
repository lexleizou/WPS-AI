#!/usr/bin/env python3
"""Use WPS Application.PluginStorage for cross-WebView dialog size presets."""
from __future__ import annotations
import argparse, hashlib, json, shutil, sys
from datetime import datetime
from pathlib import Path

HOME=Path.home(); HOSTS=("wps","et","wpp","pdf")
BACKUP_ROOT=HOME/".lingxi-ai"/"fixes"/"window-size"/"storage-backups"
APP_TARGETS={**{f"runtime-{h}-app":HOME/".lingxi-ai"/f"plugin-{h}"/"js"/"app.js" for h in HOSTS},"source-app":HOME/"Library"/"Application Support"/"LingxiAI"/"plugin"/"js"/"app.js"}
ADAPTER_TARGETS={**{f"runtime-{h}-adapter":HOME/".lingxi-ai"/f"plugin-{h}"/"js"/"wps-addon-adapter.js" for h in HOSTS},"source-adapter":HOME/"Library"/"Application Support"/"LingxiAI"/"plugin"/"js"/"wps-addon-adapter.js"}
TARGETS={**APP_TARGETS,**ADAPTER_TARGETS}
APP_MARKER="LINGXI_DIALOG_SIZE_PLUGIN_STORAGE_V1"; ADAPTER_MARKER="LINGXI_DIALOG_SIZE_PLUGIN_STORAGE_READER_V1"

APP_OLD_HEADER='''  // LINGXI_DIALOG_SIZE_PRESETS_V1
  // macOS WPS ShowDialog 会忽略 window.resizeTo；用三档尺寸写入同源 localStorage，
  // 由 wps-addon-adapter 在下次打开时读取并创建目标尺寸窗口。
  const DIALOG_SIZE_PRESET_KEY = "lingxi_ai_main_dialog_preset_v1";
  const DIALOG_SIZE_STORAGE_KEY = "lingxi_ai_main_dialog_size_v1";
  const DIALOG_SIZE_PRESET_ORDER = ["compact", "standard", "wide"];
  const DIALOG_SIZE_PRESET_LABELS = { compact: "紧凑", standard: "标准", wide: "宽屏" };
'''
APP_NEW_HEADER='''  // LINGXI_DIALOG_SIZE_PRESETS_V1
  // LINGXI_DIALOG_SIZE_PLUGIN_STORAGE_V1
  // macOS WPS ShowDialog 会忽略 window.resizeTo；尺寸必须跨 Ribbon 入口与独立窗口两个 WebView。
  // Application.PluginStorage 是权威跨窗存储，localStorage 仅作旧版 WPS 兼容回退。
  const DIALOG_SIZE_PRESET_KEY = "lingxi_ai_main_dialog_preset_v1";
  const DIALOG_SIZE_STORAGE_KEY = "lingxi_ai_main_dialog_size_v1";
  const DIALOG_SIZE_PRESET_ORDER = ["compact", "standard", "wide"];
  const DIALOG_SIZE_PRESET_LABELS = { compact: "紧凑", standard: "标准", wide: "宽屏" };

  function readDialogSizePreference(key) {
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.();
      const value = app?.PluginStorage?.getItem?.(key);
      if (value != null && value !== "") return String(value);
    } catch (e) {}
    try { return global.localStorage?.getItem(key) || null; } catch (e) { return null; }
  }

  function writeDialogSizePreference(key, value) {
    const text = String(value == null ? "" : value);
    let wrotePluginStorage = false;
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app?.PluginStorage?.setItem) {
        app.PluginStorage.setItem(key, text);
        wrotePluginStorage = true;
      }
    } catch (e) {}
    try { global.localStorage?.setItem(key, text); } catch (e) {}
    return wrotePluginStorage;
  }
'''
APP_OLD_READ='''    let current = "standard";
    try {
      const saved = global.localStorage?.getItem(DIALOG_SIZE_PRESET_KEY);
      if (DIALOG_SIZE_PRESET_ORDER.includes(saved)) current = saved;
    } catch (e) {}
'''
APP_NEW_READ='''    let current = "standard";
    try {
      const saved = readDialogSizePreference(DIALOG_SIZE_PRESET_KEY);
      if (DIALOG_SIZE_PRESET_ORDER.includes(saved)) current = saved;
    } catch (e) {}
'''
APP_OLD_WRITE='''      try {
        global.localStorage?.setItem(DIALOG_SIZE_PRESET_KEY, current);
        global.localStorage?.setItem(DIALOG_SIZE_STORAGE_KEY, JSON.stringify({
          width: size.width, height: size.height, preset: current, updatedAt: Date.now()
        }));
      } catch (e) {}
      renderDialogSizePreset(current);
      showMessage(`窗口大小已设为${DIALOG_SIZE_PRESET_LABELS[current]}（${size.width}×${size.height}），关闭并重新打开灵犀AI后生效。`, "info");
'''
APP_NEW_WRITE='''      const sizeJson = JSON.stringify({
        width: size.width, height: size.height, preset: current, updatedAt: Date.now()
      });
      const presetStored = writeDialogSizePreference(DIALOG_SIZE_PRESET_KEY, current);
      const sizeStored = writeDialogSizePreference(DIALOG_SIZE_STORAGE_KEY, sizeJson);
      renderDialogSizePreset(current);
      const storageHint = (presetStored && sizeStored) ? "" : "（当前 WPS 未提供跨窗口存储，可能需要完全重启 WPS）";
      showMessage(`窗口大小已设为${DIALOG_SIZE_PRESET_LABELS[current]}（${size.width}×${size.height}），关闭并重新打开灵犀AI后生效。${storageHint}`, "info");
'''

ADAPTER_OLD='''  function pickMainDialogSize() {
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
ADAPTER_NEW='''  // LINGXI_DIALOG_SIZE_PLUGIN_STORAGE_READER_V1
  function pickMainDialogSize(app) {
    const dpr = Number(global.devicePixelRatio) || 1;
    const sw = Number(global.screen?.availWidth || global.screen?.width) || 1440;
    const sh = Number(global.screen?.availHeight || global.screen?.height) || 900;
    const maxW = Math.max(420, sw - 40);
    const maxH = Math.max(520, sh - 40);
    let logicalWidth = Math.max(620, Math.min(760, Math.round(sw * 0.46)));
    let logicalHeight = Math.max(720, Math.min(900, Math.round(sh - 120)));
    let source = "default";
    try {
      const pluginValue = readStorageItem(app, MAIN_DIALOG_SIZE_KEY);
      const localValue = global.localStorage?.getItem(MAIN_DIALOG_SIZE_KEY) || null;
      const saved = JSON.parse(pluginValue || localValue || "null");
      source = pluginValue ? "PluginStorage" : (localValue ? "localStorage" : "default");
      const savedW = Number(saved?.width);
      const savedH = Number(saved?.height);
      if (Number.isFinite(savedW) && savedW >= 420) logicalWidth = Math.min(maxW, Math.max(420, Math.round(savedW)));
      if (Number.isFinite(savedH) && savedH >= 520) logicalHeight = Math.min(maxH, Math.max(520, Math.round(savedH)));
    } catch (e) {}
    debugLog("pickMainDialogSize", { source, logicalWidth, logicalHeight, dpr });
    return {
      width: Math.round(logicalWidth * dpr),
      height: Math.round(logicalHeight * dpr),
      logicalWidth,
      logicalHeight
    };
  }
'''
ADAPTER_OLD_CALL='''    const mainDialogSize = pickMainDialogSize();
'''
ADAPTER_NEW_CALL='''    const mainDialogSize = pickMainDialogSize(app);
'''

def marker(n): return APP_MARKER if n in APP_TARGETS else ADAPTER_MARKER
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def patch_app(t):
    if APP_MARKER in t:return t
    anchors=(APP_OLD_HEADER,APP_OLD_READ,APP_OLD_WRITE)
    if any(t.count(a)!=1 for a in anchors): raise ValueError('app anchor mismatch')
    return t.replace(APP_OLD_HEADER,APP_NEW_HEADER,1).replace(APP_OLD_READ,APP_NEW_READ,1).replace(APP_OLD_WRITE,APP_NEW_WRITE,1)
def patch_adapter(t):
    if ADAPTER_MARKER in t:return t
    if t.count(ADAPTER_OLD)!=1 or t.count(ADAPTER_OLD_CALL)!=1: raise ValueError('adapter anchor mismatch')
    return t.replace(ADAPTER_OLD,ADAPTER_NEW,1).replace(ADAPTER_OLD_CALL,ADAPTER_NEW_CALL,1)
def status():
    info={};ok=True
    for n,p in TARGETS.items():
        ex=p.exists();txt=p.read_text('utf-8') if ex else '';ins=marker(n) in txt
        info[n]={"path":str(p),"exists":ex,"installed":ins,"sha256":sha(p) if ex else None};ok=ok and ex and ins
    ah={info[n]['sha256'] for n in APP_TARGETS if info[n]['sha256']};dh={info[n]['sha256'] for n in ADAPTER_TARGETS if info[n]['sha256']}
    info['app_copies_match']=len(ah)==1;info['adapter_copies_match']=len(dh)==1
    return ok and info['app_copies_match'] and info['adapter_copies_match'],info
def install():
    if any(not p.exists() for p in TARGETS.values()):print('missing target',file=sys.stderr);return 2
    texts={n:p.read_text('utf-8') for n,p in TARGETS.items()}
    if all(marker(n) in t for n,t in texts.items()):
        ok,i=status();print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 3
    try:patched={n:(patch_app(t) if n in APP_TARGETS else patch_adapter(t)) for n,t in texts.items()}
    except ValueError as e:print(str(e),file=sys.stderr);return 4
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S');d=BACKUP_ROOT/stamp;d.mkdir(parents=True)
    manifest={"createdAt":stamp,"targets":{}}
    for n,p in TARGETS.items():
        b=d/f'{n}.js';shutil.copy2(p,b);manifest['targets'][n]={"path":str(p),"backup":str(b),"marker":marker(n)}
    (d/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
    for n,p in TARGETS.items():p.write_text(patched[n],'utf-8')
    ok,i=status();i['backup']=str(d);print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 5
def dirs():return sorted(p for p in BACKUP_ROOT.iterdir() if p.is_dir()) if BACKUP_ROOT.exists() else []
def find_backup(target,m):
    for d in dirs():
        try:data=json.loads((d/'manifest.json').read_text('utf-8'))
        except Exception:continue
        for x in data.get('targets',{}).values():
            b=Path(x.get('backup',''))
            if Path(x.get('path',''))==target and b.exists() and m not in b.read_text('utf-8'):return b
    return None
def remove():
    out={}
    for n,t in TARGETS.items():
        b=find_backup(t,marker(n))
        if not b:print(f'no backup for {t}',file=sys.stderr);return 2
        shutil.copy2(b,t);out[n]=str(b)
    print(json.dumps({"restored":out},ensure_ascii=False,indent=2));return 0
def main():
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group();g.add_argument('--check',action='store_true');g.add_argument('--remove',action='store_true');a=p.parse_args()
    if a.check:
        ok,i=status();print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 1
    return remove() if a.remove else install()
if __name__=='__main__':raise SystemExit(main())
