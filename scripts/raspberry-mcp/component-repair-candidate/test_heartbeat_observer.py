import copy,datetime,hashlib,unittest
from unittest.mock import patch
import heartbeat_observer as h
class Port:
 def __init__(self,status,manager,boot):self.status,self.manager,self.boot=status,manager,boot
 def collect(self):return copy.deepcopy(self.status),dict(self.manager),self.boot
class Cases(unittest.TestCase):
 def setUp(self):
  self.now=2000.;self.mono=100.;self.boot='00000000-0000-0000-0000-000000000001';invocation='a'*32;stamp=datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat()
  self.proof={'schema_version':1,'source':'native_heartbeat.loaded_code','identity_kind':'python_code_objects_v1','observed_at':stamp,'observed_monotonic':98.,'runtime_cache_tag':'cpython-313','sample_sequence':4,'loaded_code_sha256':'b'*64,'critical_binding_sha256':'c'*64,'critical_bindings_valid':True,'pid':123,'boot_id_sha256':hashlib.sha256(self.boot.encode()).hexdigest(),'invocation_id_sha256':hashlib.sha256(invocation.encode()).hexdigest()}
  self.status={'source':'bounded_local_heartbeat_history','observed_at':stamp,'last_sample_observed_at':stamp,'last_sample_state':'provider_accepted','last_http_status':200,'last_sequence':4,'last_loaded_identity':self.proof}
  self.manager={'InvocationID':invocation,'ExecMainPID':123,'ExecMainStartTimestampMonotonic':97000000,'ExecMainExitTimestampMonotonic':99000000,'ActiveState':'inactive','SubState':'dead','Result':'success'};self.port=Port(self.status,self.manager,self.boot)
 def observer(self):return h.HeartbeatNativeObserver(self.port,'c'*64,'cpython-313',frozenset(['b'*64,'d'*64]),lambda:self.now,lambda:self.mono)
 def test_completed_native_observation_maps_to_worker_contract(self):
  r=self.observer()();self.assertTrue(r['root_verified']);self.assertTrue(r['native_invocation_verified']);self.assertEqual(r['invocation_started_monotonic'],97);self.assertEqual(r['observed_monotonic'],98);self.assertEqual(r['loaded_sha256'],'b'*64);self.assertNotIn('pid',r);self.assertNotIn('InvocationID',r)
 def test_second_reviewed_identity_and_failed_transport_still_prove_code(self):
  self.proof['loaded_code_sha256']='d'*64;self.status.update(last_sample_state='provider_refused',last_http_status=503);self.manager.update(Result='exit-code',ActiveState='failed',SubState='failed');r=self.observer()();self.assertTrue(r['root_verified']);self.assertEqual(r['diagnostics']['last_http_status'],503);self.assertNotIn('functional_recovery_proven',r)
 def test_wrong_code_binding_boot_pid_or_sequence_remain_unknown(self):
  for target,key,value in [(self.proof,'loaded_code_sha256','e'*64),(self.proof,'critical_binding_sha256','e'*64),(self.proof,'critical_bindings_valid',False),(self.proof,'runtime_cache_tag','cpython-999'),(self.proof,'boot_id_sha256','e'*64),(self.proof,'pid',124),(self.proof,'sample_sequence',3)]:
   original=target[key];target[key]=value
   with self.subTest(key=key):r=self.observer()();self.assertEqual(r['state'],'unknown');self.assertFalse(r['root_verified'])
   target[key]=original
 def test_future_stale_and_incomplete_manager_refused(self):
  for value in [float('nan'),True,101,-100]:
   self.proof['observed_monotonic']=value;self.assertFalse(self.observer()()['root_verified'])
  self.proof['observed_monotonic']=98;self.manager['ExecMainExitTimestampMonotonic']=101000000;self.assertFalse(self.observer()()['root_verified']);self.manager.clear();self.assertFalse(self.observer()()['root_verified'])
 def test_collection_failure_withholds_raw_error_and_no_fallback(self):
  with patch.object(self.port,'collect',side_effect=OSError('PRIVATE_SENTINEL')):
   r=self.observer()();self.assertEqual(r['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',str(r));self.assertIsNone(r['loaded_sha256'])
 def test_protected_expected_scope_not_client_booleans(self):
  for expected in [True,set(['b'*64]),frozenset(),frozenset(['b'*64,'d'*64,'e'*64])]:
   with self.assertRaises(ValueError):h.HeartbeatNativeObserver(self.port,'c'*64,'cpython-313',expected)
 def test_manager_parser_requires_complete_unique_bounded_properties(self):
  raw='\n'.join(k+'='+str(v)for k,v in self.manager.items()).encode();self.assertEqual(h.parse_manager(raw),self.manager)
  for bad in [raw+b'\nExecMainPID=123',raw.replace(b'ExecMainPID=123',b'ExecMainPID=true'),b'x'*4097,b'Other=secret']:
   with self.assertRaises(ValueError):h.parse_manager(bad)
 def test_fixed_port_will_not_collect_as_unprivileged_user(self):
  with patch('heartbeat_observer.os.geteuid',return_value=1001),patch.object(h.FixedNativeHeartbeatPort,'manager',side_effect=AssertionError('must not query')):
   with self.assertRaisesRegex(ValueError,'root_native_read_port_required'):h.FixedNativeHeartbeatPort().collect()
if __name__=='__main__':unittest.main()
