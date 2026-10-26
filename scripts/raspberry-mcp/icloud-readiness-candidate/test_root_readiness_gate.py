import copy,importlib.util,time,types,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('candidate_executor',Path(__file__).with_name('executor.py'));e=importlib.util.module_from_spec(s);s.loader.exec_module(e)
class Cases(unittest.TestCase):
 def setUp(self):
  self.scope={'enabled':True,'expires_at':2000.,'minimum_poll_seconds':60,'expected_release_revision':'a'*64};self.policy={'enabled':True,'not_before':1.,'expires_at':2000.,'boot_id':'fixture-boot','readiness_scope':self.scope};self.backend=types.SimpleNamespace(policy=self.policy);self.q=copy.deepcopy(e.READINESS_REQUEST)
 def check(self):
  with patch.object(e.time,'time',return_value=1000),patch.object(Path,'exists',return_value=False),patch.object(Path,'read_text',return_value='fixture-boot'),patch('importlib.util.spec_from_file_location',side_effect=AssertionError('collection begins only after authorization')):
   e.readiness(self.q,self.backend)
 def test_unknown_host_component_or_any_extra_argument_refused_before_collection(self):
  for change in [{'host':'other'},{'component_id':'other'},{'path':'PRIVATE'},{'command':'PRIVATE'},{'tool':'admin_action_apply'}]:
   self.q={**e.READINESS_REQUEST,**change}
   with self.assertRaises(ValueError):self.check()
 def test_expiry_budget_and_disabled_scope_cannot_be_overridden_by_caller(self):
  for key,value in [('enabled',False),('expires_at',2001.),('minimum_poll_seconds',1)]:
   self.scope[key]=value
   with self.assertRaises(ValueError):self.check()
   self.setUp()
 def test_future_not_before_or_expired_existing_authority_refused(self):
  for change in [{'enabled':False},{'not_before':1001.},{'expires_at':999.}]:
   self.policy.update(change)
   with self.assertRaises(ValueError):self.check()
   self.setUp()
 def test_revocation_and_boot_change_refused(self):
  with patch.object(e.time,'time',return_value=1000),patch.object(Path,'exists',return_value=True):
   with self.assertRaises(ValueError):e.readiness(self.q,self.backend)
  with patch.object(e.time,'time',return_value=1000),patch.object(Path,'exists',return_value=False),patch.object(Path,'read_text',return_value='different-boot'):
   with self.assertRaises(ValueError):e.readiness(self.q,self.backend)
 def test_valid_gate_reaches_only_sealed_read_collector_and_never_migration(self):
  with self.assertRaisesRegex(AssertionError,'collection begins'):self.check()
 def test_duplicate_request_fields_are_refused(self):
  with self.assertRaises(ValueError):e.unique_request([("tool","icloud_readiness"),("tool","admin_action_apply")])
 def test_legacy_fixed_action_schema_stays_separate(self):
  e.validate({'host':'raspberry','tool':'admin_action_status','action':e.ACTION,'idempotency_key':e.KEY})
  with self.assertRaises(ValueError):e.validate(self.q)
if __name__=='__main__':unittest.main()
