#!/usr/bin/env python3
"""Report successful selected cells and explicit unavailable requested cells."""
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent
x=json.loads((HERE/'native-inputs.json').read_text());a=json.loads((HERE/'availability.json').read_text())
config=json.loads((HERE/'work/cohort-config.json').read_text())
cohort=json.loads((HERE/'work/cohort/cohort.json').read_text())
ids=[c['id'] for c in config['cells']]
complete=cohort.get('status')=='passed' and cohort['mainSha']==x['sourceCommit'] and cohort['sweeps']==6
for cell in ids:
 rows=[r for r in cohort['rows'] if r['id']==cell]
 complete=complete and len(rows)==7 and sum(not r['warmup'] for r in rows)==6 and all(r.get('result',{}).get('qualification')=='passed' for r in rows)
unavailable={v:r for v,r in a['variants'].items() if r['status']=='unavailable'}
backupPath=HERE.parent/'backup-results/summary.json'
backup=json.loads(backupPath.read_text()) if backupPath.exists() else {'status':'not-run'}
result={'untimedBackup':backup,'applicationQualified':False,'shipReady':False,'status':('partial-comparison-passed' if unavailable else 'comparison-passed') if complete else 'comparison-incomplete','sourceCommit':x['sourceCommit'],'performanceQualified':complete,'fullRequestedMatrixComplete':complete and not unavailable,'availableCells':ids,'unavailableVariants':unavailable,'sourceAppExport':a['sourceAppExport'],'sourceQualificationSummary':a['sourceQualificationSummary'],'summary':cohort.get('summary') if complete else None,'limits':cohort['limits']}
(HERE/'comparison-summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
raise SystemExit(0 if complete else 1)
