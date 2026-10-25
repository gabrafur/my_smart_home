import datetime,fcntl,importlib.util,json,os,sys
from pathlib import Path
BASE=Path('/run/raspberry-icloud-core-compatibility-20261025')
spec=importlib.util.spec_from_file_location('sealed',BASE/'apply.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
def main():
 a.need(a.sha(BASE/'apply.py')=='${APPROVED_INSTALLER_SHA256}','installer_changed');m=a.sealed();fd=os.open(a.REPO/'.daily-maintenance.lock',os.O_WRONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);a.need(not list((a.HA/'.daily-update-trigger').glob('*processing')),'native_worker_processing');row=json.loads(a.raw(a.STATE/'receipt.json'))
  a.need(row['phase']=='source_installed_activation_not_attempted'and row['activation_attempted']is False,'existing_activation_requires_readonly_reconciliation')
  a.need(all(a.sha(a.REPO/i['target'])==i['after_sha256']for i in m['files'].values()),'installed_source_changed');state=a.container();a.need(state['State']['Running']and state['Image']==m['expected_image'],'container_identity_changed')
  row.update(phase='activation_intent_outcome_unknown',activation_attempted=True,updated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'));a.save(row)
  a.run(['/usr/bin/docker','restart','--time','30','homeassistant'])
  state=a.container();a.need(state['State']['Running']and state['State']['StartedAt']!=row['before_started_at'],'activation_unconfirmed');row.update(phase='restarted_fresh_loaded_proof_and_natural_poll_pending',after_started_at=state['State']['StartedAt'],services_restarted=1);a.save(row);print(json.dumps({k:row[k]for k in ('operation_id','phase','services_restarted','automatic_retry')}))
 finally:os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as exc:print(json.dumps({'state':'unconfirmed','exception_kind':type(exc).__name__,'reason':str(exc)if type(exc)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
