#!/usr/bin/env python3
"""Reuse the family20 native observer parser. No worker events are synthesized."""
import argparse,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'legacy'))
from native_trace import summarize
p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--controller-pid',required=True,type=int);p.add_argument('--out',required=True);a=p.parse_args()
try:
 report=summarize(a.directory,[a.controller_pid],require_positive=True)
 report['expectedControllerPid']=a.controller_pid
 report['historicalFieldNote']='timeWrapperPid is the inherited parser name; here it identifies the Node harness controller, not GNU time.'
 report['performanceEligible']=False
except Exception as error:
 report={'pass':False,'error':repr(error),'scope':'No missing or ignored worker events are counted as a pass.'}
pathlib.Path(a.out).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
raise SystemExit(0 if report['pass'] else 1)
