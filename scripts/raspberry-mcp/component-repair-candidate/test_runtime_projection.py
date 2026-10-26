import copy,datetime,unittest
from runtime_projection import project_icloud,project_heartbeat
NOW=1800000000
AT=datetime.datetime.fromtimestamp(NOW,datetime.timezone.utc).isoformat()
OP='1'*32;REV='2'*64;CODE='3'*64
class Cases(unittest.TestCase):
 def fixture(self):
  return {'schema_version':1,'source':'homeassistant.main_process.icloud','observed_at':AT,'operation_id':OP,'release_revision':REV,'loaded_code_sha256':CODE,'ha_running':True,'manual_auth_guard_loaded':True,'phase':'entry_waiting_user','private':'PRIVACY_TEST_FIXTURE'}
 def binding(self):return {'operation_id':OP,'release_revision':REV,'process_identity_verified':True}
 def test_actual_process_proof_stays_distinct_from_remote_and_source_health(self):
  out=project_icloud(self.fixture(),self.binding(),REV,NOW);self.assertEqual(out['state'],'observed');self.assertEqual(out['loaded_sha256'],CODE);self.assertFalse(out['root_verified']);self.assertEqual(out['remote_functional_health'],'unknown');self.assertNotIn('PRIVACY_TEST_FIXTURE',str(out));self.assertNotIn('operation_id',out)
 def test_old_future_missing_and_invalid_observations_are_unknown(self):
  for at in [None,'invalid',datetime.datetime.fromtimestamp(NOW-61,datetime.timezone.utc).isoformat(),datetime.datetime.fromtimestamp(NOW+1,datetime.timezone.utc).isoformat(),'2027-01-15T08:00:00']:
   self.assertEqual(project_icloud({**self.fixture(),'observed_at':at},self.binding(),REV,NOW)['state'],'unknown')
 def test_nonce_release_and_code_identity_are_bound(self):
  for change in [{'operation_id':'4'*32},{'release_revision':'4'*64},{'loaded_code_sha256':None},{'manual_auth_guard_loaded':False},{'ha_running':False}]:self.assertEqual(project_icloud({**self.fixture(),**change},self.binding(),REV,NOW)['state'],'unknown')
 def test_pid_or_birth_mismatch_cannot_attest_loaded_code(self):
  out=project_icloud(self.fixture(),{**self.binding(),'process_identity_verified':False},REV,NOW);self.assertEqual(out['collection_error'],'process_identity_unconfirmed');self.assertIsNone(out['loaded_sha256'])
 def heartbeat(self):return {'source':'bounded_local_heartbeat_history','observed_at':AT,'last_sample_observed_at':AT,'last_sample_state':'provider_accepted','last_http_status':200,'latest_failed_or_uncertain_sample':{'observed_at':AT,'state':'uncertain','failure_category':'timeout_exception','is_latest_attempt':False,'sample_completion_recorded':True,'private':'PRIVACY_TEST_FIXTURE'}}
 def test_current_heartbeat_success_preserves_older_failure_without_inventing_loaded_identity(self):
  out=project_heartbeat(self.heartbeat(),NOW);self.assertEqual(out['state'],'unknown');self.assertIsNone(out['loaded_sha256']);self.assertEqual(out['diagnostics']['last_sample_state'],'provider_accepted');self.assertEqual(out['diagnostics']['latest_failed_or_uncertain_sample']['failure_category'],'timeout_exception');self.assertNotIn('PRIVACY_TEST_FIXTURE',str(out))
 def test_newer_failure_and_unknown_category_remain_visible_and_sanitized(self):
  status=self.heartbeat();status['last_sample_state']='uncertain';status['last_http_status']=None;status['latest_failed_or_uncertain_sample']['is_latest_attempt']=True;status['latest_failed_or_uncertain_sample']['failure_category']='PRIVACY_TEST_FIXTURE'
  out=project_heartbeat(status,NOW);self.assertEqual(out['diagnostics']['last_sample_state'],'uncertain');self.assertEqual(out['diagnostics']['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded')
 def test_failed_or_stale_collection_is_unknown(self):
  for status in [None,{}, {**self.heartbeat(),'observed_at':'invalid'},{**self.heartbeat(),'last_sample_observed_at':'invalid'}]:self.assertEqual(project_heartbeat(status,NOW)['diagnostics']['state'],'unknown')
if __name__=='__main__':unittest.main()
