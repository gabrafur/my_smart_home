import fcntl,hashlib,importlib.util,json,os,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-procmon-correlation-capture-20261025');STATE=Path('/var/lib/raspberry-procmon-correlation-capture-20261025');MANIFEST_SHA='${APPROVED_OPERATOR_MANIFEST_SHA256}'
TARGETS={'capture.py':'/usr/local/lib/raspberry-procmon-acceptance/capture.py','health_summary.py':'/usr/local/lib/raspberry-repair-control/health_summary.py','raspberry-procmon-acceptance.timer':'/etc/systemd/system/raspberry-procmon-acceptance.timer','repair-policy.json':'/usr/local/lib/raspberry-repair-control/policy.json'}
def need(value,reason):
 if not value:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__)==STAGE/'apply.py'and not sys.argv[1:],'fixed_entrypoint_required');need(time.time()<(1792941922+2443945/10000000),'administrative_lease_expired')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed');spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw);need(set(m['files'])==set(TARGETS)and m['repair_admission_extended']is False and m['collector_invoked']is False,'scope_changed')
 before={};candidate={}
 for name,target in TARGETS.items():
  need(m['files'][name]['target']==target,'target_changed');before[name]=base.read(Path(target));candidate[name]=base.read(STAGE/name);need(base.sha(before[name])==m['files'][name]['before_sha256']and base.sha(candidate[name])==m['files'][name]['after_sha256'],'source_changed')
 expected=json.loads(before['repair-policy.json']);expected['source_hashes']['health_summary.py']=m['files']['health_summary.py']['after_sha256']
 for name in ('capture.py','raspberry-procmon-acceptance.timer'):expected['dependencies'][TARGETS[name]]=m['files'][name]['after_sha256']
 audit=Path('/usr/local/lib/raspberry-procmon-observability/invocation_audit.py');expected['dependencies'][str(audit)]=base.sha(base.read(audit));need(json.loads(candidate['repair-policy.json'])==expected,'policy_authority_or_limits_changed')
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing')),'native_worker_processing');need(not STATE.exists(),'existing_intent_requires_readonly_reconciliation')
  sys.path[:0]=['/usr/local/lib/raspberry-repair-control','/usr/local/lib/raspberry-task-control'];import repair_control,task_control;repair_control.configuration(task_control)
  reports={str(p):base.sha(base.read(p))for p in Path('/var/lib/raspberry-procmon-acceptance').glob('*.json')};os.mkdir(STATE,0o700);os.mkdir(STATE/'before',0o700)
  base.atomic(STATE/'intent.json',(json.dumps({'state':'intent_before_fixed_readonly_correlation_and_fourth_window','manifest_sha256':MANIFEST_SHA,'automatic_retry':False,'existing_report_hashes':reports})+'\n').encode(),0o600)
  for name,target in TARGETS.items():base.atomic(STATE/'before'/name,before[name],0o600);base.atomic(Path(target),candidate[name],0o644)
  repair_control.configuration(task_control)
  subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True,capture_output=True,timeout=20)
  timer=subprocess.check_output(['/usr/bin/systemctl','show','raspberry-procmon-acceptance.timer','-p','ActiveState','-p','NextElapseUSecRealtime','-p','TimersCalendar'],timeout=10,text=True);need('ActiveState=active'in timer and'2026-10-26'in timer,'timer_observation_unconfirmed')
  need(all(base.sha(base.read(Path(p)))==h for p,h in reports.items()),'existing_window_report_changed')
  result={'state':'correlation_capture_and_fourth_readonly_window_installed','manifest_sha256':MANIFEST_SHA,'existing_window_reports_unchanged':True,'collector_invoked':False,'services_restarted':0,'administrative_admission_extended':False,'next_natural_window_acceptance_pending':True,'additional_readonly_window':'2026-10-26T11:00:00Z','automatic_retry':False};base.atomic(STATE/'receipt.json',(json.dumps(result)+'\n').encode(),0o600);print(json.dumps(result))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as exc:print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
