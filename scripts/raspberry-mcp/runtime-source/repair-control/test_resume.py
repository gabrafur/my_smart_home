import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from repair_store import ResumeStore
class ResumeTests(unittest.TestCase):
 def setUp(self):self.db=sqlite3.connect(':memory:',isolation_level=None);self.s=ResumeStore(self.db)
 def tearDown(self):self.db.close()
 def test_durable_intent_blocks_same_or_new_resume_after_process_loss(self):
  self.assertTrue(self.s.begin('a'*32,'b'*64,10));self.s=ResumeStore(self.db)
  with self.assertRaisesRegex(ValueError,'uncertain'):self.s.begin('a'*32,'b'*64,11)
  with self.assertRaisesRegex(ValueError,'prior_uncertain'):self.s.begin('c'*32,'b'*64,11)
 def test_verified_exact_binding_preserves_receipt_without_replay(self):
  self.s.begin('a'*32,'b'*64,10);r={'profile_readback_verified':True};self.s.verified('a'*32,'b'*64,r)
  self.assertFalse(self.s.begin('a'*32,'b'*64,11));self.assertEqual(self.s.ready('a'*32,'b'*64),r)
  with self.assertRaisesRegex(ValueError,'binding_changed'):self.s.begin('a'*32,'c'*64,11)
 def test_unverified_profile_never_releases_send(self):
  self.s.begin('a'*32,'b'*64,10)
  with self.assertRaises(ValueError):self.s.verified('a'*32,'b'*64,{})
  with self.assertRaises(ValueError):self.s.ready('a'*32,'b'*64)

class EnrollmentTests(unittest.TestCase):
 def test_explicit_broad_owner_addendum_never_means_never_approval(self):
  import repair_control as c
  from repair_store import THREAD,TASK
  from test_standing import policy
  p=policy();e={'schema':'fixed_repair_profile_enrollment_v1','enabled':True,'thread_id':THREAD,'task':TASK,'owner_scope_sha256':'a'*64,'owner_addendum_sha256':'b'*64,'metadata_evidence_sha256':'c'*64,'profile':{'threadId':THREAD,'cwd':'/mnt/data/docker','model':'gpt-6.1-sol','modelProvider':'openai','approvalPolicy':'on-request','approvalsReviewer':'user','sandbox':'danger-full-access','reasoningEffort':'high'},'legacy_administrative_grant':False,'interface_confirmations_required':True,'normalizes_project_cwd':True};p['resume_enrollment']=e
  self.assertEqual(c.resume_enrollment(p),e)
  e['profile']['approvalPolicy']='never'
  with self.assertRaisesRegex(ValueError,'profile_scope'):c.resume_enrollment(p)

if __name__=='__main__':unittest.main()
