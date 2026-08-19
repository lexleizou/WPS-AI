#!/usr/bin/env python3
import argparse,shutil,hashlib,json
from pathlib import Path
from datetime import datetime
H=Path.home();R=Path(__file__).parent;M='LINGXI_WRITER_HEADER_FOOTER_OBJECTS_V1';S={'js/hosts/writer-header-footer-objects.js':R/'writer-header-footer-objects-host.js','js/tools/writer-header-footer-objects.js':R/'writer-header-footer-objects-tools.js'};T=[H/'.lingxi-ai/plugin-wps',H/'.lingxi-ai/plugin-et',H/'.lingxi-ai/plugin-wpp',H/'.lingxi-ai/plugin-pdf',H/'Library/Application Support/LingxiAI/plugin'];AH='    "js/hosts/writer-header-table-width.js", // LINGXI_WRITER_HEADER_TABLE_WIDTH_V1_HOST';AT='    "js/tools/writer-header-table-width.js", // LINGXI_WRITER_HEADER_TABLE_WIDTH_V1_TOOLS';LH='    "js/hosts/writer-header-footer-objects.js", // '+M+'_HOST';LT='    "js/tools/writer-header-footer-objects.js", // '+M+'_TOOLS'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def apply():
 d=R/'backups'/datetime.now().strftime('%Y%m%d-%H%M%S-%f');d.mkdir(parents=True)
 for root in T:
  m=root/'main.js';txt=m.read_text();b=d/root.name;b.mkdir(parents=True,exist_ok=True);shutil.copy2(m,b/'main.js')
  if M+'_HOST' not in txt:txt=txt.replace(AH,AH+'\n'+LH,1)
  if M+'_TOOLS' not in txt:txt=txt.replace(AT,AT+'\n'+LT,1)
  if txt.count(M)!=2:raise RuntimeError('anchor/marker failure '+str(root))
  m.write_text(txt)
  for rel,src in S.items():out=root/rel;out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,out)
 print(json.dumps({'ok':True,'backup':str(d),'targets':[str(x) for x in T]}))
def check():
 ok=True;out=[]
 for root in T:
  x=(root/'main.js').read_text().count(M)==2 and all((root/k).exists() and sha(root/k)==sha(v) for k,v in S.items());ok&=x;out.append({'root':str(root),'ok':x})
 print(json.dumps({'ok':ok,'targets':out}));return ok
p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--check',action='store_true');a=p.parse_args();apply() if a.apply else exit(0 if check() else 1)
