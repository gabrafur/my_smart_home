import copy,datetime,json,unittest,types
from unittest.mock import patch
import icloud_readiness as d
class Cases(unittest.TestCase):
 def setUp(self):
  self.now=2000;self.at=datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat();self.release='a'*64;self.proof={'schema_version':1,'source':'homeassistant.main_process.icloud','operation_id':'b'*32,'release_revision':self.release,'loaded_code_sha256':'c'*64,'ha_running':True,'manual_auth_guard_loaded':True,'observed_at':self.at,'phase':'entry_ready','private':'PRIVATE_SENTINEL'};self.activation={'schema_version':1,'operation_id':'b'*32,'release_revision':self.release};self.service={'schema_version':1,'source':'HA_fixed_readonly_service_registry','observed_at':self.at,'state':'observed','collection_error':None,'service':'public_bindings.call','registered':True,'last_success':{'observed_at':self.at,'registered':True},'lookup':'fixed_service_registry_membership','not_service_execution':True,'not_handler_or_provider_health':True}
 def result(self,process=True):return d.project(self.proof,self.activation,process,self.service,self.now,self.release)
 def test_native_identity_and_registration_not_handler_or_provider_health(self):
  r=self.result();self.assertEqual(r['state'],'observed');self.assertEqual(r['loaded']['entry_phase'],'entry_ready');self.assertTrue(r['service_registration']['registered']);self.assertEqual(r['functional_health'],'unknown');self.assertFalse(r['expected_node_contract']['current_NodeRED_configuration_observed']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r));self.assertNotIn('b'*32,json.dumps(r))
 def test_explicit_service_absence_is_observed_not_failed_collection(self):
  self.service['registered']=False;r=self.result();self.assertEqual(r['state'],'observed');self.assertFalse(r['service_registration']['registered']);self.assertFalse(r['functional_recovery_proven'])
 def test_old_success_after_collection_failure_does_not_turn_current_green(self):
  self.service.update(state='unknown',collection_error='transport_unconfirmed',registered=None);r=self.result()['service_registration'];self.assertEqual(r['state'],'unknown');self.assertIsNone(r['registered']);self.assertTrue(r['last_success']['historical_not_current'])
 def test_stale_future_and_missing_dates_cannot_confirm_current(self):
  for value in [None,'bad',datetime.datetime.fromtimestamp(self.now+1,datetime.timezone.utc).isoformat(),datetime.datetime.fromtimestamp(self.now-91,datetime.timezone.utc).isoformat()]:
   self.proof['observed_at']=value;self.service['observed_at']=value;r=self.result();self.assertEqual(r['state'],'unknown');self.assertIsNone(r['loaded']['code_sha256']);self.assertIsNone(r['service_registration']['registered'])
 def test_nonce_release_phase_process_guard_and_boolean_types_are_bound(self):
  for key,value in [('operation_id','d'*32),('release_revision','d'*64),('manual_auth_guard_loaded',1),('ha_running',1),('phase','PRIVATE_PHASE'),('schema_version',True),('loaded_code_sha256','bad')]:
   old=self.proof[key];self.proof[key]=value
   with self.subTest(key=key):self.assertEqual(self.result()['loaded']['state'],'unknown')
   self.proof[key]=old
  self.assertEqual(self.result(process=1)['loaded']['state'],'unknown')
 def test_service_untrusted_fields_and_sensitive_error_are_not_exported(self):
  for change in [{'extra':'PRIVATE_SENTINEL'},{'registered':1},{'collection_error':'PRIVATE_SENTINEL','state':'unknown','registered':None},{'not_service_execution':1}]:
   self.service.update(change);r=self.result();self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r));self.assertIsNone(r['service_registration']['registered'])
 def test_collection_fails_closed_when_not_root(self):
  with patch.object(d.os,'geteuid',return_value=1001),patch.object(d,'read')as read:
   with self.assertRaises(ValueError):d.collect(self.release)
   read.assert_not_called()
 def test_kernel_process_collection_failure_is_unknown_without_raw_error(self):
  self.assertFalse(d.process_identity({'pid':1,'process_start_ticks':'42'},pids=lambda:(_ for _ in ()).throw(OSError('PRIVATE_SENTINEL'))))
 def test_live_fixed_container_membership_and_kernel_ticks_must_match(self):
  proof={'pid':4,'process_start_ticks':'42'};kernel=lambda pid:(4,'42')if pid==22 else(5,'44');self.assertTrue(d.process_identity(proof,pids=lambda:[22,23],kernel=kernel));replies=iter([[22,23],[23]]);self.assertFalse(d.process_identity(proof,pids=lambda:next(replies),kernel=kernel));self.assertFalse(d.process_identity({**proof,'process_start_ticks':'43'},pids=lambda:[22,23],kernel=kernel));self.assertFalse(d.process_identity(proof,pids=lambda:[22,23],kernel=lambda pid:(4,'42')))
 def test_only_fixed_numeric_process_metadata_endpoint_is_used(self):
  calls=[]
  class Connection:
   def request(self,*argv):calls.append(argv)
   def getresponse(self):return types.SimpleNamespace(status=200,read=lambda limit:b'{"Titles":["PID"],"Processes":[["22"],["23"]]}')
   def close(self):calls.append(('closed',))
  self.assertEqual(d.process_ids(Connection),[22,23]);self.assertEqual(calls,[('GET','/containers/homeassistant/top?ps_args=-eo%20pid'),('closed',)])
 def test_process_metadata_invalid_extra_or_oversized_response_is_refused(self):
  for raw in [b'{"Titles":["COMMAND"],"Processes":[["PRIVATE"]]}',b'{"Titles":["PID"],"Processes":[["22"]],"Env":"PRIVATE"}',b'x'*8193,b'{"Titles":["PID"],"Processes":[["22"],["22"]]}']:
   class Connection:
    def request(self,*args):pass
    def getresponse(self):return types.SimpleNamespace(status=200,read=lambda limit:raw)
    def close(self):pass
   with self.assertRaises(ValueError):d.process_ids(Connection)
if __name__=='__main__':unittest.main()
