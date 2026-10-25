import fcntl,hashlib,importlib.util,json,os,re,stat,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-procmon-signal-accounting-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
MANIFEST_SHA='APPROVED_OPERATOR_MANIFEST_SHA256'
TARGETS={'observed_collector.py':'/usr/local/lib/raspberry-procmon-observability/observed_collector.py','invocation_audit.py':'/usr/local/lib/raspberry-procmon-observability/invocation_audit.py','observer.py':'/usr/local/lib/raspberry-host-observation/observer.py'}
PINS={'collector_sha256':'/usr/local/lib/raspberry-procmon/collector.py','collector_unit_sha256':'/etc/systemd/system/raspberry-procmon.service','timer_sha256':'/etc/systemd/system/raspberry-procmon.timer','observer_unit_sha256':'/etc/systemd/system/raspberry-host-observation.service'}
def need(value,reason):
 if not value:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'apply-r2.py' and len(sys.argv)==2 and sys.argv[1]in('install','activate','status'),'fixed_action_required')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA,'manifest_changed');m=json.loads(raw)
 for key,path in PINS.items():need(base.sha(base.read(Path(path)))==m[key],'original_source_or_unit_changed')
 for name,target in TARGETS.items():need(m['files'][name]['target']==target and base.sha(base.read(STAGE/name))==m['files'][name]['after_sha256'],'candidate_changed')
 action=sys.argv[1];receipt=STATE/('procmon-signal-accounting-'+action+'.json');intent=STATE/('procmon-signal-accounting-'+action+'-intent.json')
 if action=='status':
  print(json.dumps({'state':'readonly_reconciliation','files':{name:base.sha(base.read(Path(path)))if os.path.lexists(path)else None for name,path in TARGETS.items()},'observer_active':subprocess.check_output(['/usr/bin/systemctl','is-active','raspberry-host-observation.service'],text=True,timeout=5).strip(),'intents':{name:(STATE/('procmon-signal-accounting-'+name+'-intent.json')).exists()for name in('install','activate')},'receipts':{name:(STATE/('procmon-signal-accounting-'+name+'.json')).exists()for name in('install','activate')},'automatic_retry':False}));return
 if receipt.exists():print(base.read(receipt,0o600).decode());return
 need(not intent.exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000) and m['expires_at']==(1792941922 + 2443945 / 10000000),'original_lease_expired')
 need(all(m[k]is False for k in('new_authority','new_inference','collector_called_directly','timer_or_deadlines_changed')) and m['synthetic_events']==0,'scope_changed')
 lock=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(not list(Path('/mnt/data/docker/homeassistant/.daily-update-trigger').glob('*processing')),'native_worker_processing')
  sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
  with tasks.locked():
   base.idle_databases(tasks)
   if action=='install':
    for name,target in TARGETS.items():
     before=m['files'][name]['before_sha256']
     need(not os.path.lexists(target)if before is None else base.sha(base.read(Path(target)))==before,'installed_source_changed')
    archive=STATE/'procmon-signal-accounting-before';need(not os.path.lexists(archive),'archive_exists')
    proc_lock=os.open('/var/lib/raspberry-procmon/lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
     fcntl.flock(proc_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
     base.atomic(intent,(json.dumps({'state':'intent_before_fixed_observability_update','at':time.time(),'manifest_sha256':MANIFEST_SHA,'automatic_retry':False})+'\n').encode(),0o600)
     os.mkdir(archive,0o700)
     for name,target in TARGETS.items():
      if m['files'][name]['before_sha256']is not None:base.atomic(archive/name,base.read(Path(target)),0o600)
     for name,target in TARGETS.items():base.atomic(Path(target),base.read(STAGE/name),0o644)
     need(all(base.sha(base.read(Path(path)))==m['files'][name]['after_sha256']for name,path in TARGETS.items()),'installation_unconfirmed')
     proof={'state':'instrumentation_installed_waiting_observer_activation_and_natural_collector','at':time.time(),'manifest_sha256':MANIFEST_SHA,'original_collector_units_timer_limits_and_lease_unchanged':True,'collector_invoked':False,'services_restarted':0,'automatic_retry':False}
    finally:os.close(proc_lock)
   else:
    need(json.loads(base.read(STATE/'procmon-signal-accounting-install.json',0o600))['state']=='instrumentation_installed_waiting_observer_activation_and_natural_collector','installation_unconfirmed')
    need(all(base.sha(base.read(Path(path)))==m['files'][name]['after_sha256']for name,path in TARGETS.items()),'applied_source_changed')
    unit='raspberry-host-observation.service';before=int(subprocess.check_output(['/usr/bin/systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=5));need(before>1,'observer_not_running')
    health_source=Path('/usr/local/lib/raspberry-repair-control/health_summary.py');need(base.sha(base.read(health_source))=='f715aa51a5b71a3c6fccc8be078038f898d07ea811200dc712ba4dbb73594f35','protected_report_reader_changed')
    spec=importlib.util.spec_from_file_location('protected_report_reader',health_source);health=importlib.util.module_from_spec(spec);spec.loader.exec_module(health)
    report,error=health._observer_json('/mnt/data/docker/nodered/.host-health-observer','report.json',0);need(error is None,'protected_report_unavailable')
    base.atomic(STATE/'procmon-signal-accounting-before'/'report-projection.json',(json.dumps(report,sort_keys=True)+'\n').encode(),0o600)
    base.atomic(intent,(json.dumps({'state':'intent_before_observer_only_activation','at':time.time(),'manifest_sha256':MANIFEST_SHA,'before_main_pid':before,'observer_ring_reset_means_partial_coverage':True,'automatic_retry':False})+'\n').encode(),0o600)
    result=subprocess.run(['/usr/bin/systemctl','restart',unit],capture_output=True,timeout=25);need(result.returncode==0,'activation_result_uncertain')
    after=int(subprocess.check_output(['/usr/bin/systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=5));active=subprocess.check_output(['/usr/bin/systemctl','is-active',unit],text=True,timeout=5).strip()
    need(active=='active'and after>1 and after!=before,'activation_identity_unconfirmed')
    proof={'state':'observer_only_activation_completed_waiting_natural_cycle','at':time.time(),'manifest_sha256':MANIFEST_SHA,'before_main_pid':before,'after_main_pid':after,'observer_running':True,'observer_ring_reset_means_partial_coverage':True,'household_services_restarted':0,'collector_invoked':False,'Codex_daemon_restarted':False,'new_events_generated':0,'new_inference_requested':False,'limits_and_original_lease_unchanged':True,'automatic_retry':False}
   base.atomic(receipt,(json.dumps(proof,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(proof))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception as e:
  message=str(e);print(json.dumps({'state':'unconfirmed','exception_kind':type(e).__name__,'reason':message if re.fullmatch('[a-z_]{1,90}',message)else'withheld','raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
