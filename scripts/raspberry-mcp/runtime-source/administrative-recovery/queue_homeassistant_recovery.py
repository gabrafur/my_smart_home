MANIFEST_SHA256='${REVIEW_MANIFEST_SHA256}'
import datetime,fcntl,hashlib,importlib.util,json,os,stat,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-ha-stage-recovery-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
INTENT=STATE/'ha-stage-recovery-intent.json'
RECEIPT=STATE/'ha-stage-recovery.json'
TRIGGER=Path('/mnt/data/docker/homeassistant/.daily-update-trigger')
def need(ok,reason):
 if not ok:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'queue.py' and sys.argv[1:] in (['--check'],['--enqueue']),'fixed_stage_required')
 source=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(source.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 raw=base.read(STAGE/'MANIFEST.json');need(base.sha(raw)==MANIFEST_SHA256,'manifest_changed');m=json.loads(raw)
 if RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 need(not INTENT.exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000) and m['expires_at']==(1792941922 + 2443945 / 10000000),'original_admission_expired')
 sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
 with tasks.locked():
  base.idle_databases(tasks)
  for path,expected in m['source_hashes'].items():
   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   try:
    info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_size<=1048576 and base.sha(os.read(fd,1048577))==expected,'source_changed')
   finally:os.close(fd)
  fd=os.open(TRIGGER,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   info=os.fstat(fd);need([info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)]==m['trigger_identity'],'trigger_changed')
   for stage in ['offsite-backup','dietpi','home-assistant-core','containers','codex-cli']:
    for suffix in ['requested','processing','request.lock']:need(not os.path.lexists(TRIGGER/(stage+'-'+suffix)),'existing_daily_intent')
   for name in m['recovery_markers']:need(not os.path.lexists(name),'unresolved_recovery')
   result=TRIGGER/'home-assistant-core-result'
   if result.exists():need(m['request_id'] not in result.read_text()[:8192],'recovery_already_consumed')
   need(int(next(line.split()[1]for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith('MemAvailable:')))*1024>=2147483648,'memory_pressure')
   space=os.statvfs('/');need(1-space.f_bavail/space.f_blocks<=.85,'disk_pressure')
   if sys.argv[1]=='--check':print(json.dumps({'state':'ready_for_once_only_administrative_recovery','production_changes':False,'parent_update_operation_id':m['parent_update_operation_id'],'original_failure_preserved':True,'household_device_commands':0,'services_stopped_by_this_program':0}));return
   maintenance=os.open('/mnt/data/docker/.daily-maintenance.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.flock(maintenance,fcntl.LOCK_EX|fcntl.LOCK_NB)
   try:
    os.mkdir('home-assistant-core-request.lock',mode=0o700,dir_fd=fd)
    try:
     for stage in ['offsite-backup','dietpi','home-assistant-core','containers','codex-cli']:
      for suffix in ['requested','processing']:need(not os.path.lexists(TRIGGER/(stage+'-'+suffix)),'daily_stage_started_concurrently')
     base.atomic(INTENT,(json.dumps({'state':'intent_before_administrative_stage_recovery','at':time.time(),'request_id':m['request_id'],'parent_update_operation_id':m['parent_update_operation_id'],'manifest_sha256':base.sha(raw),'original_failure_preserved':True,'automatic_retry':False})+'\n').encode(),0o600)
     temp='.home-assistant-core-requested.admin-recovery-20261025';out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o660,dir_fd=fd)
     try:
      os.fchown(out,1001,1001);os.fchmod(out,0o660)
      with os.fdopen(os.dup(out),'wb')as stream:stream.write((m['request_id']+'\n').encode());stream.flush();os.fsync(stream.fileno())
     finally:os.close(out)
     os.link(temp,'home-assistant-core-requested',src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);os.unlink(temp,dir_fd=fd);os.fsync(fd)
     receipt={'state':'administrative_stage_recovery_queued','at':time.time(),'request_id':m['request_id'],'operation_id':hashlib.sha256(m['request_id'].encode()).hexdigest()[:32],'parent_update_operation_id':m['parent_update_operation_id'],'manifest_sha256':base.sha(raw),'actual_worker_execution':'not_yet_proven','original_failure_preserved':True,'new_Git_requests':0,'new_residential_events':0,'household_device_commands':0,'expiry_unchanged':(1792941922 + 2443945 / 10000000),'automatic_retry':False}
     base.atomic(RECEIPT,(json.dumps(receipt,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(receipt))
    finally:os.rmdir('home-assistant-core-request.lock',dir_fd=fd)
   finally:os.close(maintenance)
  finally:os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'recovery_unconfirmed','exception_kind':type(e).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
