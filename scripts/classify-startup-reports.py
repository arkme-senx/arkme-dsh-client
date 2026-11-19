import json,re,sys
from pathlib import Path

def classify(rows):
    unique={}; missing=[]
    for r in rows:
        if not r.get('event_id'): missing.append(r); continue
        unique.setdefault(r['event_id'],r)
    groups={}
    for r in unique.values():
        marker=None
        for line in r.get('log','').splitlines()[1:2]:
            if line.startswith('[startup-report] web-recovery '):
                try: marker=json.loads(line[len('[startup-report] web-recovery '):])
                except ValueError: pass
        valid=isinstance(marker,dict) and re.fullmatch('[a-f0-9]{32}',str(marker.get('attemptId',''))) and marker.get('phase') in ('detected','outcome') and marker.get('outcome') in ('pending','recovered','failed','not-applicable','cancelled')
        key=marker['attemptId'] if valid else 'legacy:'+r['event_id']
        groups.setdefault(key,[]).append((r,marker if valid else None))
    result=[]
    for key,events in groups.items():
        finals=[(r,m) for r,m in events if m and m['phase']=='outcome']
        outcomes=set(m['outcome'] for r,m in finals)
        identities=set(tuple(r.get(k) for k in ('platform','version','build','plugin_version')) for r,m in events)
        outcome='unknown'
        if len(outcomes)==1 and len(identities)==1:
            candidate=next(iter(outcomes))
            expected={'recovered':'completed','failed':'failed','not-applicable':'unknown','cancelled':'unknown'}.get(candidate)
            if expected and all(r.get('recovery')==expected for r,m in finals): outcome=candidate
        result.append({'attempt_id':None if key.startswith('legacy:') else key,'outcome':outcome,'event_ids':[r['event_id'] for r,m in events]})
    return {'raw_reports':len(rows),'unique_reports':len(unique),'duplicate_reports':len(rows)-len(unique)-len(missing),'missing_event_ids':len(missing),'attempts':result,'counts':{name:sum(r['outcome']==name for r in result) for name in ('recovered','failed','not-applicable','cancelled','unknown')}}

if __name__=='__main__':
    root=Path(sys.argv[1]); result=classify(json.loads((root/'desktop-startup.json').read_text()))
    (root/'startup-outcomes.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))
