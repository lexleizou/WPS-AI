#!/usr/bin/env python3
"""Deploy the additive WPS header-table-width host/tools patch."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil
from datetime import datetime
from pathlib import Path
HOME=Path.home(); ROOT=Path(__file__).resolve().parent; MARKER="LINGXI_WRITER_HEADER_TABLE_WIDTH_V1"; BACKUPS=ROOT/"backups"
SOURCES={"js/hosts/writer-header-table-width.js":ROOT/"writer-header-table-width-host.js","js/tools/writer-header-table-width.js":ROOT/"writer-header-table-width-tools.js"}
HOST_AFTER='    "js/hosts/writer-format-guard.js", // LINGXI_WRITER_FORMAT_GUARD_V1_HOST'; TOOLS_AFTER='    "js/tools/writer-format-guard.js", // LINGXI_WRITER_FORMAT_GUARD_V1_TOOLS'
HOST_LINE=f'    "js/hosts/writer-header-table-width.js", // {MARKER}_HOST'; TOOLS_LINE=f'    "js/tools/writer-header-table-width.js", // {MARKER}_TOOLS'
TARGETS=[("plugin-wps",HOME/".lingxi-ai/plugin-wps"),("plugin-et",HOME/".lingxi-ai/plugin-et"),("plugin-wpp",HOME/".lingxi-ai/plugin-wpp"),("plugin-pdf",HOME/".lingxi-ai/plugin-pdf"),("install-source",HOME/"Library/Application Support/LingxiAI/plugin")]
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def check_sources():
 for p in SOURCES.values():
  if not p.exists() or MARKER not in p.read_text(): raise RuntimeError(f"bad source {p}")
def preflight():
 check_sources()
 for label,root in TARGETS:
  t=(root/"main.js").read_text()
  if HOST_AFTER not in t or TOOLS_AFTER not in t: raise RuntimeError(f"missing anchor {label}")
def backup():
 d=BACKUPS/datetime.now().strftime("%Y%m%d-%H%M%S-%f"); d.mkdir(parents=True); m={"marker":MARKER,"targets":{}}
 for label,root in TARGETS:
  files={}
  for rel in ("main.js",*SOURCES):
   p=root/rel; files[rel]=sha(p) if p.exists() else None
   if p.exists(): q=d/label/rel; q.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,q)
  m["targets"][label]={"root":str(root),"files":files}
 (d/"manifest.json").write_text(json.dumps(m,indent=2)+"\n"); return d
def apply():
 preflight(); d=backup()
 for _,root in TARGETS:
  main=root/"main.js"; t=main.read_text()
  if f"{MARKER}_HOST" not in t: t=t.replace(HOST_AFTER,HOST_AFTER+"\n"+HOST_LINE,1)
  if f"{MARKER}_TOOLS" not in t: t=t.replace(TOOLS_AFTER,TOOLS_AFTER+"\n"+TOOLS_LINE,1)
  if t.count(MARKER)!=2: raise RuntimeError(f"bad marker count {main}")
  tmp=main.with_suffix(".tmp-header-table"); tmp.write_text(t); os.replace(tmp,main)
  for rel,src in SOURCES.items():
   out=root/rel; out.parent.mkdir(parents=True,exist_ok=True); tmp=out.with_suffix(".tmp-header-table"); tmp.write_bytes(src.read_bytes()); os.replace(tmp,out)
 return {"ok":True,"backup":str(d),"targets":[x for x,_ in TARGETS]}
def status():
 check_sources(); results=[]; ok=True
 for label,root in TARGETS:
  main=root/"main.js"; item={"root":label,"markers":main.read_text().count(MARKER)==2,"files":{}}
  for rel,src in SOURCES.items():
   out=root/rel; item["files"][rel]=out.exists() and sha(out)==sha(src)
  item["ok"]=item["markers"] and all(item["files"].values()); ok &= item["ok"]; results.append(item)
 return ok,{"ok":ok,"results":results}
def remove():
 d=backup()
 for _,root in TARGETS:
  main=root/"main.js"; main.write_text("\n".join(x for x in main.read_text().splitlines() if MARKER not in x)+"\n")
  for rel in SOURCES: (root/rel).unlink(missing_ok=True)
 return {"ok":True,"removed":True,"backup":str(d)}
if __name__=="__main__":
 p=argparse.ArgumentParser(); g=p.add_mutually_exclusive_group(required=True); g.add_argument("--apply",action="store_true");g.add_argument("--check",action="store_true");g.add_argument("--remove",action="store_true");a=p.parse_args()
 if a.apply: print(json.dumps(apply(),indent=2))
 elif a.remove: print(json.dumps(remove(),indent=2))
 else:
  ok,out=status();print(json.dumps(out,indent=2));raise SystemExit(0 if ok else 1)
