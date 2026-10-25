import fcntl,hashlib,importlib.util,json,os,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-procmon-signal-accounting-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
def need(value,reason):
 if not value:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'apply-audit-r2.py'and not sys.argv[1:],'fixed_entrypoint_required')
 src=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(src.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',src);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 receipt=STATE/'procmon-invocation-audit-r2.json';intent=STATE/'procmon-invocation-audit-r2-intent.json'
 if receipt.exists():print(base.read(receipt,0o600).decode());return
 need(not intent.exists(),'existing_intent_requires_readonly_reconciliation');need(time.time()<(1792941922 + 2443945 / 10000000),'original_lease_expired')
 target=Path('/usr/local/lib/raspberry-procmon-observability/invocation_audit.py');candidate=base.read(STAGE/'invocation_audit-r2.py')
 need(base.sha(base.read(target))=='2038f2ef45e490e3a65a465f104a88763aab8038e2260d36b3ea32ca0b5557ad'and base.sha(candidate)=='40731a78e5d3876113a3124946e09b108604546f0bef87e508b1179e018fc783','source_changed')
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing')),'native_worker_processing')
  base.atomic(intent,(json.dumps({'state':'intent_before_readonly_helper_empty_grep_correction','at':time.time(),'automatic_retry':False})+'\n').encode(),0o600)
  base.atomic(STATE/'procmon-signal-accounting-before'/'invocation_audit.r1.py',base.read(target),0o600)
  base.atomic(target,candidate,0o644);need(base.sha(base.read(target))=='40731a78e5d3876113a3124946e09b108604546f0bef87e508b1179e018fc783','installation_unconfirmed')
  proof={'state':'readonly_audit_empty_grep_correction_installed','at':time.time(),'source_sha256':'40731a78e5d3876113a3124946e09b108604546f0bef87e508b1179e018fc783','services_restarted':0,'collector_invoked':False,'original_lease_unchanged':True,'automatic_retry':False}
  base.atomic(receipt,(json.dumps(proof)+'\n').encode(),0o600);print(json.dumps(proof))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
