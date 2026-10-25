import fcntl,hashlib,importlib.util,json,os,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-host-MCP-health-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
INTENT=STATE/'host-MCP-health-install-intent.json'
RECEIPT=STATE/'host-MCP-health-install.json'
MANIFEST_SHA='${APPROVED_HOST_MCP_METADATA_MANIFEST_SHA256}'
TARGETS={'health_summary.py':'/usr/local/lib/raspberry-repair-control/health_summary.py','test_health_summary.py':'/usr/local/lib/raspberry-repair-control/test_health_summary.py','repair-broker.py':'/usr/local/lib/raspberry-repair-control/repair-broker.py','event_projection.mjs':'/usr/local/lib/raspberry-repair-control/event_projection.mjs','app-event_projection.mjs':'/var/lib/raspberry-mcp/root/app/event_projection.mjs','test_events.mjs':'/usr/local/lib/raspberry-repair-control/test_events.mjs','registry.py':'/usr/local/lib/raspberry-mcp-events/registry.py','repair-policy.json':'/usr/local/lib/raspberry-repair-control/policy.json'}
def need(value,reason):
 if not value:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'install.py' and not sys.argv[1:],'fixed_stage_required')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw)
 if RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 need(not INTENT.exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000) and m['expires_at']==(1792941922 + 2443945 / 10000000),'original_lease_expired')
 need(m['new_authority']==m['new_events']==m['new_inference_requested']==False,'scope_changed')
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing')),'native_worker_processing')
  sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
  with tasks.locked():
   base.idle_databases(tasks)
   for name,target in TARGETS.items():
    item=m['files'][name];need(item['target']==target and base.sha(base.read(Path(target)))==item['before_sha256'] and base.sha(base.read(STAGE/name))==item['after_sha256'],'source_changed')
   policy=json.loads(base.read(Path(TARGETS['repair-policy.json'])))
   for name in ['health_summary.py','test_health_summary.py','repair-broker.py','event_projection.mjs','test_events.mjs']:policy['source_hashes'][name]=m['files'][name]['after_sha256']
   need(json.loads(base.read(STAGE/'repair-policy.json'))==policy,'policy_scope_changed')
   archive=STATE/'host-MCP-health-before';need(not os.path.lexists(archive),'archive_exists')
   base.atomic(INTENT,(json.dumps({'state':'intent_before_fixed_readonly_host_and_event_metadata_code_update','at':time.time(),'manifest_sha256':MANIFEST_SHA,'automatic_retry':False})+'\n').encode(),0o600)
   os.mkdir(archive,0o700)
   for name,target in TARGETS.items():base.atomic(archive/name,base.read(Path(target)),0o600)
   for name,target in TARGETS.items():base.atomic(Path(target),base.read(STAGE/name),0o644)
   need(all(base.sha(base.read(Path(target)))==m['files'][name]['after_sha256']for name,target in TARGETS.items()),'source_installation_unconfirmed')
   receipt={'state':'host_and_event_metadata_code_installed_activation_pending','at':time.time(),'manifest_sha256':MANIFEST_SHA,'original_authority_expiry_and_limits_unchanged':True,'services_restarted':0,'new_events':0,'new_inference_requested':False,'dispatch_subscribe_enqueue_prune_unchanged':True,'automatic_retry':False}
   base.atomic(RECEIPT,(json.dumps(receipt,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(receipt))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
