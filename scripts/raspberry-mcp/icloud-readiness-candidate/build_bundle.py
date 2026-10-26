from pathlib import Path
import difflib,json,hashlib,os
from package_model import *
from operator_workspace import require_private_workspace
P=Path(__file__).parent
require_private_workspace(P)
before={}
for name,path in TARGETS.items():
 p=Path(path);before[name]=p.read_bytes()if p.exists()else None
 if name in ['notification_collector.cjs','executor.py','recovery.py','repair-broker.py']:need(before[name]==(P/('before-'+name)).read_bytes(),'current_baseline_changed')
 if before[name]is not None:(P/('before-'+name)).write_bytes(before[name])
payload={name:(P/name).read_bytes()if name not in ['admin-policy.json','repair-policy.json']else before[name]for name in TARGETS};unchanged={p:Path(p).read_bytes()for p in UNCHANGED};payload['icloud-readiness.conf']=UNIT_CONF.encode();(P/'icloud-readiness.conf').write_bytes(payload['icloud-readiness.conf']);after=proposed(before,payload,unchanged)
for n,b in after.items():(P/n).write_bytes(b)
m={'revision':'r2','expiry':EXPIRY,'new_MCP_tools':0,'access_expansion':'readonly_icloud_process_and_fixed_service_registration','limits_changed':False,'targets':{n:{'path':path,'before':sha(before[n])if before[n]is not None else None,'after':sha(after[n])}for n,path in TARGETS.items()},'unchanged':{p:sha(b)for p,b in unchanged.items()},'package_model_sha256':sha((P/'package_model.py').read_bytes())}
(P/'MANIFEST.json').write_bytes(raw(m));diff=''.join(''.join(difflib.unified_diff((before[n]or b'').decode().splitlines(True),after[n].decode().splitlines(True),fromfile=TARGETS[n]+(' (absent)'if before[n]is None else''),tofile=TARGETS[n]))for n in TARGETS);(P/'DIFF.patch').write_text(diff);(P/'before-hashes.json').write_bytes(raw({n:sha(b)if b is not None else None for n,b in before.items()}))
print(json.dumps({'manifest_sha256':sha(raw(m)),'targets':len(TARGETS),'new_files':sum(b is None for b in before.values()),'new_MCP_tools':0,'access_activated':False}))
