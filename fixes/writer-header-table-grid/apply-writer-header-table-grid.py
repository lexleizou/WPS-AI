#!/usr/bin/env python3
import argparse,shutil
from pathlib import Path
H=Path.home();R=Path(__file__).parent;M='LINGXI_WRITER_HEADER_TABLE_GRID_V1';S={'js/hosts/writer-header-table-grid.js':R/'writer-header-table-grid-host.js','js/tools/writer-header-table-grid.js':R/'writer-header-table-grid-tools.js'};T=[H/'.lingxi-ai/plugin-wps',H/'.lingxi-ai/plugin-et',H/'.lingxi-ai/plugin-wpp',H/'.lingxi-ai/plugin-pdf',H/'Library/Application Support/LingxiAI/plugin'];AH='    "js/hosts/writer-table-dimensions.js", // LINGXI_WRITER_TABLE_DIMENSIONS_V1_HOST';AT='    "js/tools/writer-table-dimensions.js", // LINGXI_WRITER_TABLE_DIMENSIONS_V1_TOOLS';LH='    "js/hosts/writer-header-table-grid.js", // '+M+'_HOST';LT='    "js/tools/writer-header-table-grid.js", // '+M+'_TOOLS'
def run(check=False):
 ok=True
 for root in T:
  m=root/'main.js';x=m.read_text()
  if not check:
   if M+'_HOST' not in x:x=x.replace(AH,AH+'\n'+LH,1)
   if M+'_TOOLS' not in x:x=x.replace(AT,AT+'\n'+LT,1)
   m.write_text(x)
   for k,v in S.items():q=root/k;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(v,q)
  ok&=x.count(M)==2 and all((root/k).exists() for k in S)
 print({'ok':ok});return ok
p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--check',action='store_true');a=p.parse_args();exit(0 if run(a.check) else 1)
