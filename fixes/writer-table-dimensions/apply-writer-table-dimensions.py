#!/usr/bin/env python3
import argparse,shutil,hashlib,json
from pathlib import Path
H=Path.home();R=Path(__file__).parent;M='LINGXI_WRITER_TABLE_DIMENSIONS_V1';S={'js/hosts/writer-table-dimensions.js':R/'writer-table-dimensions-host.js','js/tools/writer-table-dimensions.js':R/'writer-table-dimensions-tools.js'};T=[H/'.lingxi-ai/plugin-wps',H/'.lingxi-ai/plugin-et',H/'.lingxi-ai/plugin-wpp',H/'.lingxi-ai/plugin-pdf',H/'Library/Application Support/LingxiAI/plugin'];AH='    "js/hosts/writer-header-footer-objects.js", // LINGXI_WRITER_HEADER_FOOTER_OBJECTS_V1_HOST';AT='    "js/tools/writer-header-footer-objects.js", // LINGXI_WRITER_HEADER_FOOTER_OBJECTS_V1_TOOLS';LH='    "js/hosts/writer-table-dimensions.js", // '+M+'_HOST';LT='    "js/tools/writer-table-dimensions.js", // '+M+'_TOOLS'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def apply():
 for root in T:
  m=root/'main.js';x=m.read_text();x=x if M+'_HOST' in x else x.replace(AH,AH+'\n'+LH,1);x=x if M+'_TOOLS' in x else x.replace(AT,AT+'\n'+LT,1)
  if x.count(M)!=2:raise RuntimeError('anchor failure '+str(root));m.write_text(x)
  m.write_text(x)
  for rel,s in S.items():q=root/rel;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(s,q)
 print(json.dumps({'ok':True}))
def check():
 ok=all((root/'main.js').read_text().count(M)==2 and all((root/k).exists() and sha(root/k)==sha(v) for k,v in S.items()) for root in T);print(json.dumps({'ok':ok}));return ok
p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--check',action='store_true');a=p.parse_args();apply() if a.apply else exit(0 if check() else 1)
