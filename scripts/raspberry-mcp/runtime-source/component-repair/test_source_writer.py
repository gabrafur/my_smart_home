"""Synthetic only. Parent runs serially; no Root/native sandbox/service operation."""
import base64,hashlib,importlib.util,json,os,stat,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).parent;sys.path.insert(0,str(HERE))
import source_writer as s,validation_profile as v,preparer as p,preparation_storage as q
class Guard:
 def __init__(self):self.calls=0
 def check(self):self.calls+=1;return True
class WriterTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);self.repo=self.base/'repo';self.repo.mkdir();self.state=self.base/'state';self.state.mkdir(mode=0o700);(self.state/'sealed').mkdir(mode=0o700);self.op='a'*32;self.folder=self.state/'sealed'/self.op;self.folder.mkdir(mode=0o700)
  self.name='nodered/tools/functions/host-observer-facts.js';target=self.repo/self.name;target.parent.mkdir(parents=True);target.write_bytes(b'before');target.chmod(0o600);self.target=target
  self.profile={'component_id':'observacao_host','editable_sources':[self.name],'owner_authorization_expires_at':time.time()+1000}
  self.writer=s.SourceWriter(self.profile,self.state,self.repo);self.before={self.name:b'before'};self.after={self.name:b'after'};info={'uid':os.getuid(),'gid':os.getgid(),'mode':0o600}
  bundle={'operation_id':self.op,'component_id':'observacao_host','profile_sha256':s.sha(s.raw(self.profile)),'before':{self.name:base64.b64encode(b'before').decode()},'after':{self.name:base64.b64encode(b'after').decode()},'before_source_sha256':s.source_set(self.before),'after_source_sha256':s.source_set(self.after),'metadata':{self.name:info}}
  (self.folder/'sources.json').write_bytes(s.raw(bundle));(self.folder/'sources.json').chmod(0o600)
  (self.folder/'review.json').write_bytes(s.raw({'operation_id':self.op,'source_set_sha256':s.source_set(self.after),'expires_at':time.time()+1000}));(self.folder/'review.json').chmod(0o600)
  original=s.read
  self.readpatch=patch.object(s,'read',side_effect=lambda path,owner=None,mode=None,limit=s.LIMIT:original(path,os.getuid()if owner==0 else owner,mode,limit));self.readpatch.start()
  self.rootpatch=patch.object(s.os,'geteuid',return_value=0);self.rootpatch.start()
  self.dirpatch=patch.object(s,'protected_dir',side_effect=lambda path:Path(path));self.dirpatch.start();self.guard=Guard()
 def tearDown(self):self.dirpatch.stop();self.rootpatch.stop();self.readpatch.stop();self.tmp.cleanup()
 def test_before_proof_is_not_a_mutation(self):
  x=self.writer.status(self.op,'apply');self.assertEqual(x['state'],'before');self.assertFalse(x['canonical_source_effect']);self.assertTrue(x['source_consistency_confirmed'])
 def test_apply_checks_guard_and_exact_after(self):
  x=self.writer.commit(self.op,'apply',self.guard);self.assertEqual(self.target.read_bytes(),b'after');self.assertEqual(x['state'],'terminal');self.assertGreaterEqual(self.guard.calls,3)
 def test_duplicate_commit_does_not_replace_inode(self):
  self.writer.commit(self.op,'apply',self.guard);inode=self.target.stat().st_ino;self.writer.commit(self.op,'apply',self.guard);self.assertEqual(self.target.stat().st_ino,inode)
 def test_pending_intent_does_not_grant_native_POST(self):
  (self.folder/'source-apply-intent.json').write_text('{}')
  with self.assertRaisesRegex(ValueError,'requires_reconciliation'):self.writer.commit(self.op,'apply',self.guard)
  self.assertEqual(self.target.read_bytes(),b'before')
 def test_foreign_source_is_preserved(self):
  self.target.write_bytes(b'foreign')
  with self.assertRaises(ValueError):self.writer.commit(self.op,'apply',self.guard)
  self.assertEqual(self.target.read_bytes(),b'foreign')
 def test_foreign_metadata_prevents_consistency_claim(self):
  self.target.chmod(0o644);self.assertFalse(self.writer.status(self.op,'apply')['source_consistency_confirmed'])
 def test_rollback_requires_own_apply(self):
  self.target.write_bytes(b'after')
  with self.assertRaisesRegex(ValueError,'own_apply'):self.writer.commit(self.op,'rollback',self.guard)
 def test_apply_then_rollback_preserves_source(self):
  self.writer.commit(self.op,'apply',self.guard);self.writer.commit(self.op,'rollback',self.guard);self.assertEqual(self.target.read_bytes(),b'before')
 def receipt(self,action='apply'):
  return {'operation_id':self.op,'component_id':'observacao_host','action':action,'executor_terminal':True,'definitive_no_effect':True,'state':'rejected_without_effect','session_revoked':True}
 def test_409_explicit_compensation_restores_owned_source(self):
  self.writer.commit(self.op,'apply',self.guard);x=self.writer.restore_after_rejected_native(self.op,self.guard,self.receipt());self.assertEqual(x['state'],'before');self.assertTrue(x['own_rollback_confirmed']);self.assertFalse(x['canonical_source_effect'])
 def test_unknown_native_refuses_compensation(self):
  self.writer.commit(self.op,'apply',self.guard);r=self.receipt();r['executor_terminal']=False
  with self.assertRaises(ValueError):self.writer.restore_after_rejected_native(self.op,self.guard,r)
  self.assertEqual(self.target.read_bytes(),b'after')
 def test_rollback_rejection_restores_apply_source(self):
  self.writer.commit(self.op,'apply',self.guard);self.writer.commit(self.op,'rollback',self.guard);x=self.writer.restore_after_rejected_native(self.op,self.guard,self.receipt('rollback'));self.assertEqual(self.target.read_bytes(),b'after');self.assertEqual(x['state'],'before');self.assertTrue(x['own_rollback_confirmed'])
 def test_compensation_never_overwrites_foreign_source(self):
  self.writer.commit(self.op,'apply',self.guard);self.target.write_bytes(b'foreign')
  with self.assertRaises(ValueError):self.writer.restore_after_rejected_native(self.op,self.guard,self.receipt())
  self.assertEqual(self.target.read_bytes(),b'foreign')
class DataTests(unittest.TestCase):
 def test_normalized_identity_ignores_order_and_trailing_empty_ports(self):
  a=[{'id':'b','type':'function','wires':[[]]},{'id':'a','type':'tab'}];b=[{'id':'a','type':'tab','wires':[]},{'id':'b','type':'function','wires':[]}];self.assertEqual(p.normalized(a),p.normalized(b))
 def test_candidate_cannot_add_exec_or_change_wires(self):
  before=[{'id':'n','type':'function','func':'return msg;','wires':[]}]
  for after in [[*before,{'id':'x','type':'exec'}],[{**before[0],'wires':[['x']]}]]:
   with self.assertRaises(ValueError):p.candidate_delta(before,after)
 def test_noop_candidate_is_refused(self):
  with self.assertRaises(ValueError):p.candidate_delta([{'id':'a','type':'tab'}],[{'id':'a','type':'tab'}])
 def test_fixed_source_path_rejects_arbitrary(self):
  with self.assertRaises(ValueError):s.SourceWriter({'component_id':'observacao_host','editable_sources':['/etc/shadow']})
 def test_bounded_runner_caps_while_draining(self):
  x=v.bounded([sys.executable,'-I','-S','-B','-c','import os;os.write(1,b"x"*100000);os.write(2,b"y"*100000)'],1024,512,5,{'PATH':'/usr/bin:/bin'})
  self.assertEqual(len(x['stdout']),1024);self.assertEqual(len(x['stderr']),512);self.assertTrue(x['output_limit']);self.assertEqual(x['returncode'],0)
class StorageTests(unittest.TestCase):
 def test_usage_is_metadata_only(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);(root/'sealed').mkdir();op=root/'sealed'/('a'*32);op.mkdir();(op/'value').write_bytes(b'synthetic')
   with patch.object(q,'read',side_effect=AssertionError('must not read content')):
    total,perop,count=q.PreparationStorage(root).usage()
   self.assertGreater(total,0);self.assertIn('a'*32,perop);self.assertEqual(count,3)
 def test_storage_never_follows_unexpected_symlink(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);(root/'escape').symlink_to('/etc')
   with self.assertRaisesRegex(ValueError,'unexpected_storage_symlink'):q.PreparationStorage(root).usage()
 def test_only_owned_fixed_jail_symlinks_are_allowed(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);base=root/'sealed'/('a'*32)/'sandbox/root';base.mkdir(parents=True);(base/'bin').symlink_to('usr/bin');q.PreparationStorage(root).usage()
   (base/'bin').unlink();(base/'bin').symlink_to('/etc')
   with self.assertRaises(ValueError):q.PreparationStorage(root).usage()
 def test_sparse_oversized_file_is_rejected_from_metadata(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d)
   with(root/'large').open('wb')as file:file.truncate(8*1024*1024+1)
   with self.assertRaisesRegex(ValueError,'unexpected_storage_file'):q.PreparationStorage(root).usage()
if __name__=='__main__':unittest.main()
