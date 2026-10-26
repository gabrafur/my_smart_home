import copy,datetime,unittest
from runtime_projection import project_icloud,project_heartbeat
NOW=1800000000
AT=datetime.datetime.fromtimestamp(NOW,datetime.timezone.utc).isoformat()
OP='1'*32;REV='2'*64;CODE='3'*64
class Cases(unittest.TestCase):
 def fixture(self):
  return {'schema_version':1,'source':'homeassistant.main_process.icloud','observed_at':AT,'operation_id':OP,'release_revision':REV,'loaded_code_sha256':CODE,'ha_running':True,'manual_auth_guard_loaded':True,'phase':'entry_waiting_user','private':'PRIVATE_SENTINEL'}
 def binding(self):return {'operation_id':OP,'release_revision':REV,'process_identity_verified':True}
 def test_actual_process_proof_stays_distinct_from_remote_and_source_health(self):
  out=project_icloud(self.fixture(),self.binding(),REV,NOW);self.assertEqual(out['state'],'observed');self.assertEqual(out['loaded_sha256'],CODE);self.assertFalse(out['root_verified']);self.assertEqual(out['remote_functional_health'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',str(out));self.assertNotIn('operation_id',out)
 def test_old_future_missing_and_invalid_observations_are_unknown(self):
  for at in [None,'invalid',datetime.datetime.fromtimestamp(NOW-61,datetime.timezone.utc).isoformat(),datetime.datetime.fromtimestamp(NOW+1,datetime.timezone.utc).isoformat(),'2027-01-15T08:00:00']:
   self.assertEqual(project_icloud({**self.fixture(),'observed_at':at},self.binding(),REV,NOW)['state'],'unknown')
 def test_nonce_release_and_code_identity_are_bound(self):
  for change in [{'operation_id':'4'*32},{'release_revision':'4'*64},{'loaded_code_sha256':None},{'manual_auth_guard_loaded':False},{'ha_running':False}]:self.assertEqual(project_icloud({**self.fixture(),**change},self.binding(),REV,NOW)['state'],'unknown')
 def test_pid_or_birth_mismatch_cannot_attest_loaded_code(self):
  out=project_icloud(self.fixture(),{**self.binding(),'process_identity_verified':False},REV,NOW);self.assertEqual(out['collection_error'],'process_identity_unconfirmed');self.assertIsNone(out['loaded_sha256'])
 def heartbeat(self):return {'source':'bounded_local_heartbeat_history','observed_at':AT,'last_sample_observed_at':AT,'last_sample_state':'provider_accepted','last_http_status':200,'latest_failed_or_uncertain_sample':{'observed_at':AT,'state':'uncertain','failure_category':'timeout_exception','is_latest_attempt':False,'sample_completion_recorded':True,'private':'PRIVATE_SENTINEL'}}
 def test_current_heartbeat_success_preserves_older_failure_without_inventing_loaded_identity(self):
  out=project_heartbeat(self.heartbeat(),NOW);self.assertEqual(out['state'],'unknown');self.assertIsNone(out['loaded_sha256']);self.assertEqual(out['diagnostics']['last_sample_state'],'provider_accepted');self.assertEqual(out['diagnostics']['latest_failed_or_uncertain_sample']['failure_category'],'timeout_exception');self.assertNotIn('PRIVATE_SENTINEL',str(out))
 def test_newer_failure_and_unknown_category_remain_visible_and_sanitized(self):
  status=self.heartbeat();status['last_sample_state']='uncertain';status['last_http_status']=None;status['latest_failed_or_uncertain_sample']['is_latest_attempt']=True;status['latest_failed_or_uncertain_sample']['failure_category']='PRIVATE_SENTINEL'
  out=project_heartbeat(status,NOW);self.assertEqual(out['diagnostics']['last_sample_state'],'uncertain');self.assertEqual(out['diagnostics']['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded')
 def test_failed_or_stale_collection_is_unknown(self):
  for status in [None,{}, {**self.heartbeat(),'observed_at':'invalid'},{**self.heartbeat(),'last_sample_observed_at':'invalid'}]:self.assertEqual(project_heartbeat(status,NOW)['diagnostics']['state'],'unknown')
 def native_fixture(self):
  proof={'schema_version':1,'source':'native_heartbeat.loaded_code','observed_at':AT,'identity_kind':'python_code_objects_v1','loaded_code_sha256':CODE,'critical_binding_sha256':'4'*64,'critical_bindings_valid':True,'runtime_cache_tag':'cpython-313','sample_sequence':2,'pid':123,'invocation_id_sha256':'5'*64}
  status={**self.heartbeat(),'last_sequence':2,'last_loaded_identity':proof};binding={'native_invocation_verified':True,'expected_loaded_sha256':CODE,'expected_critical_binding_sha256':'4'*64,'expected_runtime_cache_tag':'cpython-313'};return status,binding
 def test_native_heartbeat_identity_is_sanitized_and_bound_without_promoting_health(self):
  status,binding=self.native_fixture();out=project_heartbeat(status,NOW,binding);self.assertEqual(out['state'],'observed');self.assertEqual(out['loaded_sha256'],CODE);self.assertNotIn('pid',out);self.assertNotIn('invocation_id_sha256',str(out));self.assertEqual(out['diagnostics']['latest_failed_or_uncertain_sample']['failure_category'],'timeout_exception');self.assertFalse(out['root_verified'])
 def test_native_identity_without_same_invocation_or_expected_code_remains_unknown(self):
  status,binding=self.native_fixture()
  for changes in({'native_invocation_verified':False},{'expected_loaded_sha256':'6'*64},{'expected_critical_binding_sha256':None},{'expected_runtime_cache_tag':None}):self.assertEqual(project_heartbeat(status,NOW,{**binding,**changes})['state'],'unknown')
  self.assertEqual(project_heartbeat(status,NOW)['state'],'unknown')
 def test_native_identity_missing_future_or_wrong_sequence_is_not_reused(self):
  status,binding=self.native_fixture()
  for changes in({'sample_sequence':1},{'sample_sequence':True},{'observed_at':'invalid'},{'critical_bindings_valid':False},{'runtime_cache_tag':None},{'observed_at':datetime.datetime.fromtimestamp(NOW+1,datetime.timezone.utc).isoformat()}):
   value={**status,'last_loaded_identity':{**status['last_loaded_identity'],**changes}};out=project_heartbeat(value,NOW,binding);self.assertEqual(out['state'],'unknown');self.assertIsNone(out['loaded_sha256'])
if __name__=='__main__':unittest.main()
