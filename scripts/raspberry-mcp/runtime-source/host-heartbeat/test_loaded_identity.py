import copy,datetime,hashlib,json,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import heartbeat,history,loaded_identity
class CodeIdentity(unittest.TestCase):
 def test_fingerprint_uses_loaded_functions_and_has_no_file_or_network_effect(self):
  with patch('os.open',side_effect=AssertionError('no files')),patch('socket.socket',side_effect=AssertionError('no network')):
   before=loaded_identity.code_identity(heartbeat);after=loaded_identity.code_identity(heartbeat)
  self.assertEqual(before,after);self.assertTrue(before['critical_bindings_valid']);self.assertEqual(len(before['loaded_code_sha256']),64)
 def test_loaded_code_mutation_and_critical_global_mutation_are_distinct(self):
  before=loaded_identity.code_identity(heartbeat);original=heartbeat.send_once.__code__
  def changed(identifier,sender=None,clock=None):return None
  try:
   heartbeat.send_once.__code__=changed.__code__;after=loaded_identity.code_identity(heartbeat);self.assertNotEqual(before['loaded_code_sha256'],after['loaded_code_sha256'])
  finally:heartbeat.send_once.__code__=original
  with patch.object(history,'LIMIT',history.LIMIT-1):after=loaded_identity.code_identity(heartbeat)
  self.assertEqual(before['loaded_code_sha256'],after['loaded_code_sha256']);self.assertNotEqual(before['critical_binding_sha256'],after['critical_binding_sha256'])
 def test_capture_requires_native_invocation_and_exports_no_raw_invocation_or_boot_id(self):
  with patch.dict(os.environ,{'INVOCATION_ID':'a'*32}):proof=loaded_identity.capture(heartbeat)
  self.assertEqual(proof['source'],'native_heartbeat.loaded_code');self.assertNotIn('a'*32,json.dumps(proof));self.assertEqual(len(proof['boot_id_sha256']),64);self.assertIsNotNone(history.validated_identity(proof))
  with patch.dict(os.environ,{'INVOCATION_ID':'PRIVACY_TEST_FIXTURE'}):
   with self.assertRaisesRegex(ValueError,'native_invocation_identity_unavailable'):loaded_identity.capture(heartbeat)
class HistoryIdentity(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();os.chmod(self.tmp.name,0o700);self.now=time.time();self.h=history.History(self.tmp.name,lambda:self.now)
  with patch.dict(os.environ,{'INVOCATION_ID':'a'*32}):self.proof=loaded_identity.capture(heartbeat)
 def tearDown(self):self.h.close();self.tmp.cleanup()
 def finish(self,proof=None,state='provider_accepted'):
  identifier=self.h.begin();self.h.finish(identifier,{'state':state,'http_status':200 if state=='provider_accepted'else None,'duration_ms':3},proof);return identifier
 def test_same_sample_identity_is_bound_and_old_failures_are_preserved(self):
  first=self.finish(state='uncertain');self.now+=60;self.finish(self.proof);summary=self.h.summary();self.assertEqual(summary['last_loaded_identity']['sample_sequence'],2);self.assertEqual(summary['last_loaded_identity']['loaded_code_sha256'],self.proof['loaded_code_sha256']);self.assertEqual(summary['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded');self.assertFalse(summary['latest_failed_or_uncertain_sample']['is_latest_attempt']);self.assertNotIn(first,json.dumps(summary))
 def test_unfinished_new_sample_does_not_borrow_old_identity(self):
  self.finish(self.proof);self.now+=60;self.h.begin();self.assertIsNone(self.h.summary()['last_loaded_identity'])
 def test_legacy_sender_and_invalid_proof_keep_unknown_without_losing_result(self):
  self.finish(self.proof);self.now+=60;self.finish({'private':'PRIVACY_TEST_FIXTURE'});s=self.h.summary();self.assertIsNone(s['last_loaded_identity']);self.assertEqual(s['last_sample_state'],'provider_accepted');self.assertNotIn('PRIVACY_TEST_FIXTURE',json.dumps(s))
 def test_optional_identity_storage_failure_does_not_erase_network_outcome(self):
  self.h.db.execute("CREATE TRIGGER injected BEFORE INSERT ON loaded_identity BEGIN SELECT RAISE(ABORT,'synthetic'); END")
  self.finish(self.proof);self.assertEqual(self.h.summary()['last_sample_state'],'provider_accepted');self.assertIsNone(self.h.summary()['last_loaded_identity'])
 def test_singleton_storage_and_original_limits_remain_bounded(self):
  for _ in range(40):self.finish(self.proof);self.now+=60
  self.assertEqual(self.h.db.execute('SELECT count(*) FROM loaded_identity').fetchone()[0],1);self.assertEqual(history.LIMIT,4096);self.assertEqual(history.RETENTION,7*86400);self.assertEqual(self.h.db.execute('PRAGMA max_page_count').fetchone()[0],512)
  self.h.publish_status();self.assertLess((Path(self.tmp.name)/'status.json').stat().st_size,4096)
 def test_restart_and_double_finish_do_not_rebind_or_replay(self):
  identifier=self.finish(self.proof);self.h.close();self.h=history.History(self.tmp.name,lambda:self.now)
  with self.assertRaisesRegex(ValueError,'sample_already_finished'):self.h.finish(identifier,{'state':'uncertain','duration_ms':5},self.proof)
  self.assertEqual(self.h.summary()['last_sample_state'],'provider_accepted');self.assertEqual(self.h.summary()['last_loaded_identity']['sample_sequence'],1)
 def test_closed_metadata_refuses_extra_fields_and_bad_times(self):
  for changes in({'observed_at':'PRIVACY_TEST_FIXTURE'},{'observed_monotonic':float('nan')},{'pid':True},{'loaded_code_sha256':None},{'private':'PRIVACY_TEST_FIXTURE'}):self.assertIsNone(history.validated_identity({**self.proof,**changes}))
if __name__=='__main__':unittest.main()
