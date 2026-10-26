import hashlib,unittest
from native_binding import verified
class Cases(unittest.TestCase):
 def setUp(self):
  self.boot='00000000-0000-0000-0000-000000000001';self.invocation='a'*32;self.proof={'pid':123,'observed_monotonic':11,'invocation_id_sha256':hashlib.sha256(self.invocation.encode()).hexdigest(),'boot_id_sha256':hashlib.sha256(self.boot.encode()).hexdigest()};self.manager={'InvocationID':self.invocation,'ExecMainPID':123,'ExecMainStartTimestampMonotonic':10000000,'ExecMainExitTimestampMonotonic':12000000,'ActiveState':'inactive','SubState':'dead','Result':'success'}
 def test_completed_native_invocation_binds_without_claiming_current_live_process(self):self.assertTrue(verified(self.proof,self.manager,self.boot))
 def test_new_invocation_pid_boot_and_future_or_missing_timestamps_refused(self):
  for change in({'InvocationID':'b'*32},{'ExecMainPID':124},{'ExecMainStartTimestampMonotonic':12000000},{'ExecMainExitTimestampMonotonic':10000000},{'ActiveState':'active'},{'Result':'signal'}):self.assertFalse(verified(self.proof,{**self.manager,**change},self.boot))
  self.assertFalse(verified(self.proof,self.manager,'00000000-0000-0000-0000-000000000002'));self.assertFalse(verified(self.proof,{},self.boot));self.assertFalse(verified({**self.proof,'observed_monotonic':float('nan')},self.manager,self.boot))
 def test_failed_http_attempt_still_proves_loaded_code_not_transport_health(self):self.assertTrue(verified(self.proof,{**self.manager,'Result':'exit-code','ActiveState':'failed','SubState':'failed'},self.boot))
if __name__=='__main__':unittest.main()
