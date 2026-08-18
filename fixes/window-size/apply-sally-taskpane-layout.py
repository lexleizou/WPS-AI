#!/usr/bin/env python3
"""Install/check/remove Sally-style native WPS TaskPane layout for LingxiAI."""
from __future__ import annotations
import argparse, hashlib, json, shutil, sys
from datetime import datetime
from pathlib import Path

HOME=Path.home(); HOSTS=("wps","et","wpp","pdf")
BACKUP_ROOT=HOME/".lingxi-ai"/"fixes"/"window-size"/"sally-taskpane-backups"
TARGETS={**{f"runtime-{h}":HOME/".lingxi-ai"/f"plugin-{h}"/"js"/"wps-addon-adapter.js" for h in HOSTS},"source":HOME/"Library"/"Application Support"/"LingxiAI"/"plugin"/"js"/"wps-addon-adapter.js"}
MARKER="LINGXI_SALLY_NATIVE_TASKPANE_V1"

OLD_PREFER='''  // 主面板入口是否改用独立 ShowDialog 浮窗（而非 docked taskpane）：只在能确认是 mac/linux 时才改；
  // Windows 或识别不出时保持 docked（现状）——避免回归 Windows 上工作正常的停靠面板。
  function preferDialogPaneForHost() {
    try {
      const nav = global.navigator || (typeof navigator !== "undefined" ? navigator : null);
      const s = String((nav && nav.userAgent) || "") + " " + String((nav && nav.platform) || "");
      if (/Windows|Win32|Win64|WOW64/i.test(s)) return false;
      return /Mac|Macintosh|Mac OS X|Darwin|Linux|X11|CrOS/i.test(s);
    } catch (e) { return false; }
  }
'''
NEW_PREFER='''  // LINGXI_SALLY_NATIVE_TASKPANE_V1
  // 主聊天与 Sally 一致：所有桌面宿主优先使用 WPS 原生 CreateTaskPane。
  // ShowDialog 仅保留为 CreateTaskPane 真失败时的安全回退，不再作为 macOS 主布局。
'''

OLD_ACTION='''    if (id === "openWpsAiPane") {
      // Mac/Linux 上 docked taskpane 与文档共享 OS 键盘焦点，Cmd+V 会同时进文档造成双份插入，而 jsapi
      // 没有 ReleaseFocus 可补救（Windows 特有）。这两端改用独立 ShowDialog 浮窗（配合输入框「粘贴」按钮/
      // 右键粘贴走程序化剪贴板绕开 Cmd+V）。Windows 上 docked taskpane 工作正常、可停靠右侧，保持不变。
      if (preferDialogPaneForHost()) return openTaskPaneAsDialog();
      return toggleTaskPane();
    }
'''
NEW_ACTION='''    if (id === "openWpsAiPane") {
      // Sally 同款：原生右侧 TaskPane 的分隔条负责用户缩放；不再走固定尺寸 ShowDialog。
      debugLog("openWpsAiPane.native-taskpane", { layout: "sally" });
      return toggleTaskPane();
    }
'''

OLD_ENSURE_DIALOG='''    if (preferDialogPaneForHost()) {
      traceStatic("adapter.ensureTaskPaneVisible.prefer-dialog", url);
      debugLog("ensureTaskPaneVisible.prefer-dialog", { url });
      return openTaskPaneAsDialogWithApp(app);
    }
'''
NEW_ENSURE_DIALOG='''    // Sally 同款：ribbon 辅助动作同样优先确保原生 TaskPane 可见。
'''

OLD_RESHOW='''          // 每次"显示"时把默认宽度重新写一遍 —— dev 改 pickDefaultTaskPaneWidth 后立刻
          // 生效；生产用户手动 resize 后下次开会被重置，但开发体验优先。
          if (wantShow) {
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "toggle-reshow"); } catch (e) {}
          }
'''
NEW_RESHOW='''          // 不重写 Width：保留用户通过 WPS 原生分隔条调整后的宽度。
'''

OLD_CREATE='''        // 设置一次初始宽度即可，去掉延迟覆盖等花式操作，避免干扰原生渲染
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "creation");

'''
NEW_CREATE='''        // 与 Sally 一致，不设置 Width；让 WPS 决定初始宽度并管理原生分隔条。

'''

OLD_ENSURE_RESHOW='''            // ribbon 触发的 ensureTaskPaneVisible 也重新写默认宽度（同 toggleTaskPane 的考量）
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-reshow"); } catch (e) {}
'''
NEW_ENSURE_RESHOW='''            // 不重写 Width：保留用户拖动后的原生侧栏宽度。
'''

OLD_ENSURE_CREATE='''        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-creation");
'''
NEW_ENSURE_CREATE='''        // 与 Sally 一致，首次创建也不强制 Width。
'''

REPLACEMENTS=[
 (OLD_PREFER,NEW_PREFER),(OLD_ACTION,NEW_ACTION),(OLD_ENSURE_DIALOG,NEW_ENSURE_DIALOG),
 (OLD_RESHOW,NEW_RESHOW),(OLD_CREATE,NEW_CREATE),(OLD_ENSURE_RESHOW,NEW_ENSURE_RESHOW),
 (OLD_ENSURE_CREATE,NEW_ENSURE_CREATE)
]

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def patch(t):
    if MARKER in t:return t
    bad=[i for i,(a,_) in enumerate(REPLACEMENTS,1) if t.count(a)!=1]
    if bad:raise ValueError('anchor mismatch: '+','.join(map(str,bad)))
    for a,b in REPLACEMENTS:t=t.replace(a,b,1)
    return t
def status():
    info={};ok=True
    for n,p in TARGETS.items():
        ex=p.exists();txt=p.read_text('utf-8') if ex else '';ins=MARKER in txt
        calls=txt.count('applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth()') if ex else -1
        info[n]={"path":str(p),"exists":ex,"installed":ins,"forced_width_calls":calls,"sha256":sha(p) if ex else None}
        ok=ok and ex and ins and calls==0
    hs={v['sha256'] for v in info.values() if v['sha256']};info['copies_match']=len(hs)==1
    return ok and info['copies_match'],info
def install():
    if any(not p.exists() for p in TARGETS.values()):print('missing target',file=sys.stderr);return 2
    texts={n:p.read_text('utf-8') for n,p in TARGETS.items()}
    if all(MARKER in t for t in texts.values()):
        ok,i=status();print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 3
    try:patched={n:patch(t) for n,t in texts.items()}
    except ValueError as e:print(str(e),file=sys.stderr);return 4
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S');d=BACKUP_ROOT/stamp;d.mkdir(parents=True)
    manifest={"createdAt":stamp,"targets":{}}
    for n,p in TARGETS.items():
        b=d/f'{n}.js';shutil.copy2(p,b);manifest['targets'][n]={"path":str(p),"backup":str(b)}
    (d/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
    for n,p in TARGETS.items():p.write_text(patched[n],'utf-8')
    ok,i=status();i['backup']=str(d);print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 5
def backups():return sorted(p for p in BACKUP_ROOT.iterdir() if p.is_dir()) if BACKUP_ROOT.exists() else []
def find_backup(target):
    for d in backups():
        try:data=json.loads((d/'manifest.json').read_text('utf-8'))
        except Exception:continue
        for x in data.get('targets',{}).values():
            b=Path(x.get('backup',''))
            if Path(x.get('path',''))==target and b.exists() and MARKER not in b.read_text('utf-8'):return b
    return None
def remove():
    out={}
    for n,t in TARGETS.items():
        b=find_backup(t)
        if not b:print(f'no backup for {t}',file=sys.stderr);return 2
        shutil.copy2(b,t);out[n]=str(b)
    print(json.dumps({"restored":out},ensure_ascii=False,indent=2));return 0
def main():
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group();g.add_argument('--check',action='store_true');g.add_argument('--remove',action='store_true');a=p.parse_args()
    if a.check:
        ok,i=status();print(json.dumps(i,ensure_ascii=False,indent=2));return 0 if ok else 1
    return remove() if a.remove else install()
if __name__=='__main__':raise SystemExit(main())
