import datetime,hashlib,importlib.util,json,os,subprocess,sys,urllib.request
from pathlib import Path
BASE=Path('/run/raspberry-icloud-core-compatibility-20261025')
def main():
 if os.geteuid()!=0 or Path(__file__)!=BASE/'observe.py' or sys.argv[1:]:raise ValueError('fixed_readonly_entrypoint_required')
 source=BASE/'apply.py'
 if hashlib.sha256(source.read_bytes()).hexdigest()!='${APPROVED_INSTALLER_SHA256}':raise ValueError('sealed_reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',source);a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
 receipt=json.loads(a.raw(a.STATE/'receipt.json'));proof=json.loads(a.raw(a.HA/'.mcp-icloud-proof.json'));m=json.loads(a.raw(BASE/'MANIFEST.json'));now=datetime.datetime.now(datetime.timezone.utc)
 observed=datetime.datetime.fromisoformat(proof['observed_at']);fresh=proof.get('operation_id')==receipt['operation_id']and proof.get('release_revision')==m['release_revision']and 0<=(now-observed).total_seconds()<=60
 registries={n:a.sha(a.HA/'.storage'/n)==h for n,h in receipt['storage_before'].items()if n!='recorder'};db=(a.HA/'home-assistant_v2.db').stat();before=receipt['storage_before']['recorder'];recorder=db.st_ino==before['inode']and db.st_dev==before['device']
 try:
  with urllib.request.urlopen('http://127.0.0.1:8123/',timeout=8)as response:http=response.status
 except Exception:http=None
 state=a.container();logs=subprocess.run(['/usr/bin/docker','logs','--since',state['State']['StartedAt'],'--tail','2048','homeassistant'],capture_output=True,timeout=10)
 bounded=len(logs.stdout)+len(logs.stderr)<=2097152;markers=None
 if bounded:markers=(logs.stdout+logs.stderr).count(b'unsupported_icloud_core_version')
 values={'source':'fixed_readonly_icloud_core_compatibility_reconciliation','observed_at':now.isoformat(timespec='seconds'),'operation_id':receipt['operation_id'],'phase':receipt['phase'],'fresh_release_nonce':fresh,'HA_running_proof':fresh and proof.get('ha_running')is True,'manual_auth_guard_loaded':fresh and proof.get('manual_auth_guard_loaded')is True,'entry_phase':proof.get('phase')if fresh else'unknown','loaded_code_sha256':proof.get('loaded_code_sha256')if fresh else None,'release_revision':m['release_revision'],'registry_hashes_unchanged':registries,'recorder_identity_preserved':recorder,'HTTP_status':http,'same_image':state['Image']==m['expected_image'],'current_boot_unsupported_version_markers':markers,'log_observation_bounded':bounded,'log_tail_coverage_partial':True,'raw_log_exported':False,'authentication_called':False,'collector_or_location_refresh_called':False,'new_mutations':False}
 print(json.dumps(values))
if __name__=='__main__':
 try:main()
 except Exception as exc:print(json.dumps({'state':'unknown','exception_kind':type(exc).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
