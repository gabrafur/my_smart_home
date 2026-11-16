import sys,tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
from test_expired_observation import c, Store, fingerprint
class Broad(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=Store(str(Path(self.tmp.name)/'jobs.sqlite3'));self.t='a'*32;self.thread='aaaaaaaa-0000-0000-0000-000000000000'
  self.s.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(self.t,'ordinary','a'*64,self.thread,'created',1,1,1))
  self.g={'schema':'eva_broad_task_profile_v1','enabled':True,'revoked':False,'lease_kind':'persistent_revocable','scope':'registered_tasks_in_eva_project','owner_approval_sha256':c.BROAD_OWNER_SHA256,'profile':{'sandbox':'danger-full-access','approvalPolicy':'on-request','approvalsReviewer':'user','cwd':'/mnt/data/docker'},**{k:True for k in ('mandatory_interface_confirmations','preserve_existing_ids','exclude_legacy_admin','exclude_unregistered_references')}}
  self.p={'schema':'raspberry-task-policy-v2','broad_task_profile':self.g};self.q={'mode':'send','thread_id':self.thread,'operation_id':'b'*32,'text':'work'};self.payload={'operation_id':'b'*32,'task_id':self.t}
 def tearDown(self):self.s.close();self.tmp.cleanup()
 def test_exact_grant(self):self.assertIs(c.broad_grant(self.p,True),self.g)
 def test_scope_tamper_refused(self):
  self.g['profile']['approvalPolicy']='never'
  with self.assertRaises(ValueError):c.broad_grant(self.p)
 def test_revocation_preserves_read_contract(self):
  self.g['revoked']=True;self.assertIs(c.broad_grant(self.p),self.g)
  with self.assertRaisesRegex(ValueError,'revoked'):c.broad_grant(self.p,True)
 def test_ledger_bound_profile(self):self.assertEqual(c.bind_profile(self.q,self.s,self.p,self.payload)['profile'],'eva_broad')
 def test_unknown_thread_does_not_inherit(self):
  q={**self.q,'thread_id':'bbbbbbbb-0000-0000-0000-000000000000'};self.assertNotIn('profile',c.bind_profile(q,self.s,self.p,self.payload))
 def test_old_admin_not_reopened(self):
  self.s.db.execute("UPDATE tasks SET task_key='eva-admin-historical'")
  with self.assertRaisesRegex(ValueError,'separate_review'):c.bind_profile(self.q,self.s,self.p,self.payload)
 def test_workspace_owned_reference_uses_ledger(self):
  q={'mode':'workspace_message_preflight','thread_id':self.thread};bound=c.bind_profile(q,self.s,self.p,self.payload)
  self.assertEqual(bound['profile'],'eva_broad');self.assertIsNone(bound['broad_active_turn'])
 def test_intent_precedes_rpc_and_confirmed_same_id_not_replayed(self):
  def rpc(*args):
   self.assertEqual(self.s.db.execute('SELECT state FROM profile_transitions').fetchone()[0],'intent');return {'broad_profile_verified':True,'turn_id':self.thread}
  with patch.object(c,'rpc',side_effect=rpc)as call:
   one=c.profile_rpc(self.q,self.s,self.p,self.payload,{},{});two=c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
   self.assertEqual(one,two);self.assertEqual(call.call_count,1)
 def test_failure_preserves_unknown_blocks_next_resume(self):
  with patch.object(c,'rpc',side_effect=RuntimeError('uncertain'))as call:
   with self.assertRaises(RuntimeError):c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
   with self.assertRaises(ValueError):c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
   self.assertEqual(call.call_count,1)
 def test_required_readback_missing_is_unknown(self):
  with patch.object(c,'rpc',return_value={'turn_id':self.thread}):
   with self.assertRaisesRegex(ValueError,'readback'):c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
  self.assertEqual(self.s.db.execute('SELECT state FROM profile_transitions').fetchone()[0],'uncertain')
 def test_revoke_blocks_cached_effect_receipt_route(self):
  with patch.object(c,'rpc',return_value={'broad_profile_verified':True}):c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
  self.g['revoked']=True
  with self.assertRaisesRegex(ValueError,'revoked'):c.profile_rpc(self.q,self.s,self.p,self.payload,{},{})
if __name__=='__main__':unittest.main()
