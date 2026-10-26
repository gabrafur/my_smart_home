import copy,json,unittest
from unittest.mock import patch
import icloud_readiness as model,readiness_client as c
import test_icloud_readiness as fixtures
class Cases(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.Cases();self.f.setUp();self.reply=self.f.result()
 def test_closed_reply_preserves_only_reviewed_facts(self):
  r=c.project(self.reply,self.f.now);self.assertEqual(r['state'],'observed');self.assertEqual(r['loaded']['entry_phase'],'entry_ready');self.assertNotIn('PRIVATE',json.dumps(r))
 def test_unknown_or_failed_source_is_valid_and_not_functional_success(self):
  r=model.project(None,None,False,None,self.f.now,self.f.release);out=c.project(r,self.f.now);self.assertEqual(out['collection_error'],'partial_collection_failure');self.assertEqual(out['functional_health'],'unknown')
 def test_extra_sensitive_fields_wrong_contract_and_claimed_recovery_refused(self):
  for edit in [lambda r:r.update(private='PRIVATE_SENTINEL'),lambda r:r.update(functional_recovery_proven=True),lambda r:r['expected_node_contract'].update(service='private.action'),lambda r:r['loaded'].update(pid=123),lambda r:r['service_registration'].update(private='PRIVATE_SENTINEL'),lambda r:r.update(coverage=['PRIVATE_SENTINEL'])]:
   r=copy.deepcopy(self.reply);edit(r);out=c.project(r,self.f.now);self.assertEqual(out['collection_error'],'root_readiness_unavailable');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(out))
 def test_old_source_dates_cannot_be_relabelled_by_root_reply_timestamp(self):
  self.reply['loaded']['observed_at']='1970-01-01T00:01:00Z';self.assertEqual(c.project(self.reply,self.f.now)['state'],'unknown')
 def test_collect_has_only_fixed_request_and_bounded_peer_response(self):
  reply=(json.dumps(self.reply)+'\n').encode();calls=[]
  class Socket:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def settimeout(self,v):calls.append(('timeout',v))
   def connect(self,p):calls.append(('path',p))
   def sendall(self,p):calls.append(('request',json.loads(p)))
   def recv(self,n):return reply
  with patch.object(c.socket,'socket',return_value=Socket()):result=c.collect(lambda:self.f.now)
  self.assertEqual(result['state'],'observed');self.assertIn(('request',c.REQUEST),calls);self.assertIn(('timeout',6),calls);self.assertIn(('path','/run/raspberry-admin-executor.sock'),calls)
 def test_socket_failure_and_malformed_reply_do_not_export_errors_or_retry(self):
  with patch.object(c.socket,'socket',side_effect=OSError('PRIVATE_SENTINEL'))as sock:
   r=c.collect(lambda:self.f.now);self.assertEqual(sock.call_count,1);self.assertEqual(r['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r))
if __name__=='__main__':unittest.main()
