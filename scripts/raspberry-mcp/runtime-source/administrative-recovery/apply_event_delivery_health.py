MANIFEST_SHA256='${REVIEW_MANIFEST_SHA256}'
TARGETS={'event_projection.mjs': '/usr/local/lib/raspberry-repair-control/event_projection.mjs', 'app-event_projection.mjs': '/var/lib/raspberry-mcp/root/app/event_projection.mjs', 'test_events.mjs': '/usr/local/lib/raspberry-repair-control/test_events.mjs', 'repair-policy.json': '/usr/local/lib/raspberry-repair-control/policy.json'}
import hashlib, importlib.util, json, os, sys, time
from pathlib import Path
STAGE=Path('/run/raspberry-event-delivery-health-20261025')
RECEIPT=Path('/var/lib/raspberry-eva-repair-install-20261024/event-delivery-health.json')
def need(ok,reason):
 if not ok:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'apply.py' and not sys.argv[1:],'fixed_stage_required')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA256,'manifest_changed');m=json.loads(raw)
 if RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 need(not Path('/var/lib/raspberry-eva-repair-install-20261024/event-delivery-health-intent.json').exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000) and m['expires_at']==(1792941922 + 2443945 / 10000000),'expired')
 sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
 with tasks.locked():
  base.idle_databases(tasks)
  for name,target in TARGETS.items():
   item=m['files'][name];need(item['target']==target and base.sha(base.read(Path(target)))==item['before_sha256'] and base.sha(base.read(STAGE/name))==item['after_sha256'],'source_changed')
  policy=json.loads(base.read(Path(TARGETS['repair-policy.json'])))
  for n in ['event_projection.mjs','test_events.mjs']:policy['source_hashes'][n]=m['files'][n]['after_sha256']
  need(json.loads(base.read(STAGE/'repair-policy.json'))==policy,'scope_changed')
  for name,target in TARGETS.items():base.atomic(STAGE/('before-'+name),base.read(Path(target)),0o600)
  base.atomic(Path('/var/lib/raspberry-eva-repair-install-20261024/event-delivery-health-intent.json'),(json.dumps({'state':'intent_before_readonly_projection_update','at':time.time(),'manifest_sha256':base.sha(raw),'automatic_retry':False})+'\n').encode(),0o600)
  for name,target in TARGETS.items():base.atomic(Path(target),base.read(STAGE/name),0o644)
  receipt={'state':'event_delivery_health_applied','at':time.time(),'manifest_sha256':base.sha(raw),'scope_and_expiry_unchanged':True,'services_restarted':0,'api_submissions':0,'new_events':0}
  base.atomic(RECEIPT,(json.dumps(receipt,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'automatic_retry':False,'raw_error_withheld':True}));raise SystemExit(1)
