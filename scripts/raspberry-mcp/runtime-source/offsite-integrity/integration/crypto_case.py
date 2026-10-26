"""Real create/start authentication using only a generated synthetic archive."""
import importlib.util,json,os,subprocess,tempfile
from pathlib import Path
IMAGE='sha256:23f4dfbb69ce76315dbc4de7915504f1c2dcecd7ca2648113a493a385972e133'
LABEL='smart-home.offsite-crypto-transport-synthetic'
NAME='offsite-crypto-transport-synthetic-20261026'
AUTHENTICATE=Path('/run/raspberry-offsite-integrity-original-binding/authenticate.py')
base=['--pull=never','--network','none','--user','1001:1001','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','8','--cpus','0.15','--ulimit','core=0:0','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777']
def call(args,input=None):
 r=subprocess.run(['docker',*args],input=input,capture_output=True,timeout=45)
 if r.returncode:raise RuntimeError('synthetic_crypto_transport_failed')
 if len(r.stdout)>8192 or len(r.stderr)>8192:raise RuntimeError('synthetic_output_limit')
 return r.stdout
if __name__=='__main__':
 with tempfile.TemporaryDirectory(prefix='offsite-crypto-transport-synthetic-')as tmp:
  script="import io,tarfile;from securetar import SecureTarArchive;\nwith SecureTarArchive(name='/synthetic/backup.tar',mode='w',password='fixture-only',create_version=3)as outer:\n with outer.create_tar('homeassistant.tar.gz')as inner:\n  raw=b'SYNTHETIC_DATA_ONLY';member=tarfile.TarInfo('fixture.txt');member.size=len(raw);inner.addfile(member,io.BytesIO(raw))"
  call(['run','--rm',*base,'--mount','type=bind,source='+tmp+',target=/synthetic','--entrypoint','python',IMAGE,'-I','-B','-c',script]);created=False
  try:
   cid=call(['create','--interactive',*base,'--name',NAME,'--label',LABEL+'=fixed-test','--mount','type=bind,source='+str(AUTHENTICATE)+',target=/review/authenticate.py,readonly','--mount','type=bind,source='+str(Path(tmp)/'backup.tar')+',target=/input/backup.tar,readonly','--entrypoint','python',IMAGE,'-I','-B','/review/authenticate.py']).decode().strip();created=True
   spec=importlib.util.spec_from_file_location('fixed_parent_transport',Path('/run/raspberry-offsite-integrity-reconciliation-binding/verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);assert v.verify_container_input(cid)is True
   proof=json.loads(call(['start','--attach','--interactive',cid],input=b'{"password":"fixture-only"}\n'))
   assert proof['authenticated']is True and proof['securetar_version']==3 and proof['archive_extracted']is False and proof['payloads_executed']is False
   print(json.dumps({'state':'actual_synthetic_crypto_create_start_passed','stdin_config_checked_before_input':True,'securetar_version':3,'complete_plaintext_stream_bytes':proof['complete_plaintext_stream_bytes'],'real_backup_verified':False,'real_credentials_read':False,'production_mounts':False,'network':'none'}))
  finally:
   if created:
    raw=call(['inspect','--format','{{json .Config.Labels}} {{.Image}}',NAME]).decode().strip();labels,image=raw.rsplit(' ',1);assert json.loads(labels).get(LABEL)=='fixed-test'and image==IMAGE;call(['rm','--force',NAME])
