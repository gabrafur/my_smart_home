import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('native_key',Path(__file__).with_name('native_key_reader.py'));k=importlib.util.module_from_spec(spec);spec.loader.exec_module(k)
class NativeKeyReader(unittest.TestCase):
 def test_secret_shape_and_output_are_bounded(self):
  raw=json.dumps({'data':{'config':{'create_backup':{'password':'fixture-only'}}}}).encode();self.assertEqual(json.loads(k.secret_from(raw)),{'password':'fixture-only'})
  for password in [None,'',1,'x'*4097,'é'*4096]:
   raw=json.dumps({'data':{'config':{'create_backup':{'password':password}}}}).encode()
   with self.assertRaises(ValueError):k.secret_from(raw)
 def test_metadata_mode_never_reads_bytes(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=Path(tmp)/'fixture';p.write_bytes(b'PRIVATE_TEST_SENTINEL');p.chmod(0o600)
   with patch.object(k.os,'read')as read:self.assertEqual(k.safe_read(p,os.geteuid(),0o600,metadata=True)['size_bytes'],len(b'PRIVATE_TEST_SENTINEL'));read.assert_not_called()
 def test_symlink_source_refused(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=Path(tmp)/'source';p.write_text('fixture');p.chmod(0o600);link=Path(tmp)/'link';link.symlink_to(p)
   with self.assertRaises(OSError):k.safe_read(link,os.geteuid(),0o600)
 def test_root_intent_is_exclusive_and_preserved(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=Path(tmp)/'intent.json';k.persist(p,{'state':'intent'})
   with self.assertRaises(FileExistsError):k.persist(p,{'state':'replacement'})
   self.assertEqual(json.loads(p.read_text()),{'state':'intent'})
 def patches(self,folder,argv):
  from contextlib import ExitStack
  stack=ExitStack()
  for target,name,value in [(k,'STATE',folder),(k,'__file__',str(k.BASE/'native_key_reader.py')),(k.sys,'argv',['native_key_reader.py',*argv])]:stack.enter_context(patch.object(target,name,value))
  stack.enter_context(patch.object(k.os,'geteuid',return_value=0));stack.enter_context(patch.object(k.resource,'setrlimit'));stack.enter_context(patch.object(k.signal,'alarm'));stack.enter_context(patch.object(k,'manifest',return_value=({},'a'*64)));stack.enter_context(patch.object(k,'authority'))
  return stack
 def test_preflight_does_not_read_key_or_create_state(self):
  with tempfile.TemporaryDirectory()as tmp:
   state=Path(tmp)/'operation'
   with self.patches(state,['preflight']),patch.object(k,'safe_read',return_value={'size_bytes':40})as read,patch.object(k,'operation_binding')as bound,patch.object(k,'persist')as persist:
    out=k.main();self.assertFalse(out['key_read']);self.assertTrue(read.call_args.kwargs['metadata']);bound.assert_not_called();persist.assert_not_called();self.assertFalse(state.exists())
 def test_existing_intent_blocks_even_a_preflight_read(self):
  with tempfile.TemporaryDirectory()as tmp:
   with self.patches(Path(tmp),['preflight']),patch.object(k,'safe_read')as read:
    with self.assertRaisesRegex(ValueError,'existing_key_intent_requires_reconciliation'):k.main()
    read.assert_not_called()
 def test_private_pipe_delivery_never_stores_key(self):
  raw=json.dumps({'data':{'config':{'create_backup':{'password':'fixture-only'}}}}).encode()
  with tempfile.TemporaryDirectory()as tmp:
   with self.patches(Path(tmp)/'state',[]),patch.object(k,'operation_binding'),patch.object(k,'safe_read',side_effect=lambda *a,**kw:{'size_bytes':len(raw)}if kw.get('metadata')else raw),patch.object(k.os,'write',side_effect=lambda fd,data:len(data))as pipe,patch.object(k,'persist')as persist:
    self.assertIsNone(k.main());self.assertEqual(json.loads(pipe.call_args.args[1])['password'],'fixture-only');self.assertNotIn('fixture-only',str(persist.call_args_list));self.assertEqual(persist.call_args.args[1]['state'],'delivered_to_private_parent_pipe')
 def test_recovery_key_read_requires_input_ready_and_matching_cipher(self):
  row={'operation_id':k.OP,'manifest_sha256':'a'*64,'phase':'existing_key_read_intent','download':{'backup_id_sha256':k.ARTIFACT,'encrypted_bytes':k.SIZE,'downloads':1,'encrypted_sha256':'CIPHER_SHA256_BINDING'},'container_stdin_open':True,'container_tty':False}
  with tempfile.TemporaryDirectory()as tmp:
   folder=Path(tmp);folder.chmod(0o700);cipher=folder/'backup.tar'
   with cipher.open('wb')as f:f.truncate(k.SIZE)
   cipher.chmod(0o600)
   with patch.object(k,'OPERATION',folder),patch.object(k,'safe_read',return_value=json.dumps(row).encode()):k.operation_binding('a'*64)
   for key,value in [('container_stdin_open',False),('container_stdin_open',None),('container_tty',True)]:
    changed={**row,key:value}
    with patch.object(k,'OPERATION',folder),patch.object(k,'safe_read',return_value=json.dumps(changed).encode()):
     with self.assertRaisesRegex(ValueError,'download_and_input_transport_unconfirmed'):k.operation_binding('a'*64)
if __name__=='__main__':unittest.main()
