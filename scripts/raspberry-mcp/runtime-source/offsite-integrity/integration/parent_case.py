"""Exercise actual sealed parent's main with synthetic download/key ports only."""
import contextlib,hashlib,importlib.util,io,json,subprocess,tempfile,types
from pathlib import Path
from unittest.mock import patch
STAGE=Path('/run/raspberry-offsite-integrity-reconciliation-binding')
IMAGE='sha256:23f4dfbb69ce76315dbc4de7915504f1c2dcecd7ca2648113a493a385972e133'
base=['--pull=never','--network','none','--user','1001:1001','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','8','--cpus','0.15','--ulimit','core=0:0','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777']
if __name__=='__main__':
 with tempfile.TemporaryDirectory(prefix='offsite-parent-synthetic-')as tmp:
  folder=Path(tmp);script="import io,tarfile;from securetar import SecureTarArchive;\nwith SecureTarArchive(name='/synthetic/fixture.tar',mode='w',password='fixture-only',create_version=3)as outer:\n with outer.create_tar('homeassistant.tar.gz')as inner:\n  raw=b'SYNTHETIC_DATA_ONLY';member=tarfile.TarInfo('fixture.txt');member.size=len(raw);inner.addfile(member,io.BytesIO(raw))"
  r=subprocess.run(['docker','run','--rm',*base,'--mount','type=bind,source='+tmp+',target=/synthetic','--entrypoint','python',IMAGE,'-I','-B','-c',script],capture_output=True,timeout=45);assert r.returncode==0,'fixture_generation_failed';cipher=(folder/'fixture.tar').read_bytes();digest=hashlib.sha256(cipher).hexdigest()
  spec=importlib.util.spec_from_file_location('actual_fixed_parent',STAGE/'verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);real_run=v.run;calls={'synthetic_download':0,'synthetic_key':0,'real_container_create':0};operation=folder/'operation';profile={'operation_id':'f'*32,'artifact_id_sha256':'a'*64,'encrypted_size_bytes':len(cipher),'image':IMAGE};services={'synthetic_service':{'running':True,'health':'none','started_at':'synthetic'}}
  def invoke(args,timeout=15,input=None,parse=False):
   if args[-1:]==[str(STAGE/'download_backup.cjs')]:
    calls['synthetic_download']+=1;p=operation/'backup.tar';p.write_bytes(cipher);p.chmod(0o600);return {'encrypted_bytes':len(cipher),'backup_id_sha256':'a'*64,'downloads':1,'encrypted_sha256':digest}
   if args[-1:]==[str(STAGE/'native_key_reader.py')]:
    assert v.RECEIPT.get('container_stdin_open')is True and v.RECEIPT.get('container_tty')is False,'credential_requested_before_verified_stdin';calls['synthetic_key']+=1;return b'{"password":"fixture-only"}\n'
   assert '/usr/bin/sudo'not in args,'real_key_read_forbidden_in_test'
   if args[:2]==['docker','create']:calls['real_container_create']+=1;assert '--interactive'in args
   return real_run(args,timeout=timeout,input=input,parse=parse)
  stream=io.StringIO()
  with patch.object(v,'ROOT',operation),patch.object(v,'MANIFEST',profile),patch.object(v.sys,'argv',[str(STAGE/'verify.py'),'b'*64]),patch.object(v,'preflight',return_value=services),patch.object(v,'service_state',return_value=services),patch.object(v,'sources'),patch.object(v,'recovery_guard',return_value=types.SimpleNamespace(CIPHER_SHA=digest)),patch.object(v,'run',side_effect=invoke),contextlib.redirect_stdout(stream):
   result=v.main()
  assert result==0 and v.RECEIPT['new_artifact_integrity_proven']is True and v.RECEIPT['phase']=='verified_cleaned'
  assert calls=={'synthetic_download':1,'synthetic_key':1,'real_container_create':1}
  assert v.RECEIPT['private_copy_removed']is True and v.RECEIPT['disposable_container_removed']is True
  assert 'fixture-only'not in stream.getvalue()and 'fixture-only'not in json.dumps(v.RECEIPT)
  assert not(operation/'backup.tar').exists()
  print(json.dumps({'state':'actual_root_owned_parent_main_synthetic_ports_passed','calls':calls,'actual_Docker_create_start_crypto':True,'stdin_verified_before_simulated_key':True,'complete_stream_authenticated':True,'real_credentials_read':False,'real_downloads':0,'production_mounts':False,'service_control':False,'private_copy_and_container_removed':True,'real_backup_verified':False}))
