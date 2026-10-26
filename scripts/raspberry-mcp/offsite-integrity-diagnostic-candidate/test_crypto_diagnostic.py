import json,unittest
from crypto_diagnostic import project
class Cases(unittest.TestCase):
 def row(self,**changes):return json.dumps({'authenticated':False,'error':'plaintext_size_limit','exception_kind':'ValueError','raw_error_withheld':True,'automatic_retry':False,**changes}).encode()
 def test_safe_reason_survives_without_inferring_integrity(self):
  r=project(self.row(),1);self.assertEqual(r['reason'],'plaintext_size_limit');self.assertFalse(r['authentication_proven']);self.assertEqual(r['exception_kind'],'ValueError');self.assertIsNone(r['collection_error'])
 def test_unknown_text_is_redacted_without_copying_private_content(self):
  r=project(self.row(error='PRIVACY_TEST_FIXTURE',exception_kind='PRIVACY_TEST_FIXTURE'),1);self.assertNotIn('PRIVACY_TEST_FIXTURE',json.dumps(r));self.assertEqual(len(r['redacted_fields']),2)
 def test_oversized_malformed_duplicate_and_extra_content_are_not_exported(self):
  for value in (b'PRIVACY_TEST_FIXTURE',b'x'*2049,self.row(extra='PRIVACY_TEST_FIXTURE'),self.row()[:-1]+b',"error":"PRIVACY_TEST_FIXTURE"}'):
   r=project(value,1);self.assertIsNotNone(r['collection_error']);self.assertNotIn('PRIVACY_TEST_FIXTURE',json.dumps(r))
 def test_success_boolean_or_missing_failure_status_never_proves_authentication(self):
  for value,code in ((self.row(authenticated=True),1),(self.row(),0),(self.row(),True),(self.row(),None)):
   r=project(value,code);self.assertFalse(r['authentication_proven']);self.assertIsNotNone(r['collection_error'])
 def test_signal_is_not_invented_as_timeout_or_bad_key(self):
  r=project(b'',-9);self.assertEqual(r['child_signal'],'SIGKILL');self.assertEqual(r['reason'],'authentication_reason_unavailable');self.assertNotIn('timeout',json.dumps(r))
 def test_bad_encoding_and_incomplete_envelope_remain_unknown(self):
  for value in (b'\xff',b'{}',b'[]',b'{"authenticated":false}'):
   r=project(value,1);self.assertFalse(r['authentication_proven']);self.assertIsNotNone(r['collection_error'])
if __name__=='__main__':unittest.main()
