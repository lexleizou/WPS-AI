#!/usr/bin/env python3
import argparse, hashlib, json, shutil
from pathlib import Path
H=Path.home(); R=Path(__file__).parent; M='LINGXI_WRITER_TABLE_COLUMN_WIDTH_V1'
S={'js/hosts/writer-table-column-width.js':R/'writer-table-column-width-host.js','js/tools/writer-table-column-width.js':R/'writer-table-column-width-tools.js'}
T=[H/'.lingxi-ai/plugin-wps',H/'.lingxi-ai/plugin-et',H/'.lingxi-ai/plugin-wpp',H/'.lingxi-ai/plugin-pdf',H/'Library/Application Support/LingxiAI/plugin']
AH='    "js/hosts/writer-header-table-grid.js", // LINGXI_WRITER_HEADER_TABLE_GRID_V1_HOST'; AT='    "js/tools/writer-header-table-grid.js", // LINGXI_WRITER_HEADER_TABLE_GRID_V1_TOOLS'; LH='    "js/hosts/writer-table-column-width.js", // '+M+'_HOST'; LT='    "js/tools/writer-table-column-width.js", // '+M+'_TOOLS'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def apply():
 for root in T:
  main=root/'main.js'; text=main.read_text()
  if M+'_HOST' not in text:text=text.replace(AH,AH+'\n'+LH,1)
  if M+'_TOOLS' not in text:text=text.replace(AT,AT+'\n'+LT,1)
  if text.count(M)!=2:raise RuntimeError('anchor failure: '+str(root))
  main.write_text(text)
  for rel,src in S.items():out=root/rel;out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,out)
 print(json.dumps({'ok':True,'targets':[x.name for x in T]}))
def check():
 out=[]
 for root in T:
  ok=(root/'main.js').read_text().count(M)==2 and all((root/k).exists() and digest(root/k)==digest(v) for k,v in S.items());out.append({'root':root.name,'ok':ok})
 print(json.dumps({'ok':all(x['ok'] for x in out),'targets':out}));return all(x['ok'] for x in out)
p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--check',action='store_true');a=p.parse_args();apply() if a.apply else exit(0 if check() else 1)
