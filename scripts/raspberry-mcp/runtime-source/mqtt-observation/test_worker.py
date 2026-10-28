"""Root fixture worker lifecycle, not a service installation."""
from pathlib import Path
import json,os,socket,sys,tempfile,unittest
from unittest.mock import patch
from test_protocol import frame
sys.path.insert(0,str(Path(__file__).parent))
from authorization_gate import SCOPE,GateInvalid
from activated_reader import ActivatedSocketReader
from worker import Paths,Worker,bootstrap_approved
from receiver_ledger import LedgerUnavailable
@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0, "requires isolated Root ownership fixture; ordinary suite never escalates")
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="mqtt-worker-")
  root=Path(self.temp.name);self.paths=Paths(root/"state",root/"runtime",root/"report",root/"consumer")
  for p,mode,gid in [(self.paths.state,0o700,0),(self.paths.runtime,0o755,0),(self.paths.report,0o750,1000),(self.paths.consumer,0o700,1000)]:
   p.mkdir();p.chmod(mode);os.chown(p,1000 if p==self.paths.consumer else 0,gid)
  self.approval="a"*64;self.auth={"version":1,"scope":SCOPE,"enabled":True,"expires_at":None,"approval_id":self.approval}
  self.write(self.paths.authorization,self.auth)
  self.write(self.paths.source_policy,{"schema_version":1,"container_id":"b"*64,"binary_sha256":"c"*64,"plugin_sha256":"d"*64,"approval_id":self.approval})
  self.manager=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);self.manager.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
  self.manager.bind(str(self.paths.source_socket));os.chown(self.paths.source_socket,0,1883);self.paths.source_socket.chmod(0o620)
  self.worker=None
 def write(self,path,value):
  path.write_text(json.dumps(value));path.chmod(0o600)
 def make(self):
  self.worker=Worker(self.paths,reader_factory=lambda path,**kw:ActivatedSocketReader(path,fd=self.manager.fileno(),**kw),notifier=lambda _m:None)
  return self.worker
 def tearDown(self):
  if self.worker:self.worker.close()
  self.manager.close();self.temp.cleanup()
 def test_normal_start_never_creates_missing_ledger(self):
  with self.assertRaises(LedgerUnavailable):self.make()
  self.assertFalse(self.paths.ledger.exists())
 def test_explicit_bootstrap_then_first_session_has_no_restart_fault(self):
  bootstrap_approved(self.paths);w=self.make()
  self.assertEqual(w.ledger.body["reader_sessions"],1);self.assertEqual(w.ledger.body["faults"]["reader_restart"],0)
  self.assertTrue((self.paths.runtime/"authorized").exists())
 def test_second_bootstrap_never_resets_existing_ledger(self):
  bootstrap_approved(self.paths);before=self.paths.ledger.read_bytes()
  with self.assertRaises(LedgerUnavailable):bootstrap_approved(self.paths)
  self.assertEqual(self.paths.ledger.read_bytes(),before)
 def test_restart_preserves_manager_socket_marker_and_history(self):
  bootstrap_approved(self.paths);first=self.make();marker=(self.paths.runtime/"authorized").stat().st_ino;sock=self.paths.source_socket.stat().st_ino
  first.close();second=self.make()
  self.assertEqual(second.ledger.body["reader_sessions"],2);self.assertEqual(second.ledger.body["faults"]["reader_restart"],1)
  self.assertEqual((self.paths.runtime/"authorized").stat().st_ino,marker);self.assertEqual(self.paths.source_socket.stat().st_ino,sock)
 def test_revocation_removes_marker_and_skips_intake(self):
  bootstrap_approved(self.paths);w=self.make();self.write(self.paths.authorization,{**self.auth,"enabled":False});w.refresh_authority();w.step(timeout=0)
  self.assertFalse(w.authorization["source_authorized"]);self.assertFalse((self.paths.runtime/"authorized").exists())
  self.assertEqual(w.ledger.body["accepted_frames"],0)
 def test_changed_approval_id_revokes_before_failing(self):
  bootstrap_approved(self.paths);w=self.make();self.write(self.paths.authorization,{**self.auth,"approval_id":"e"*64})
  with self.assertRaises(GateInvalid):w.refresh_authority()
  self.assertFalse((self.paths.runtime/"authorized").exists())
 def test_invalid_policy_revokes_without_source_intake(self):
  bootstrap_approved(self.paths);w=self.make();self.write(self.paths.authorization,{**self.auth,"extra":"PRIVATE_CANARY"});w.refresh_authority();w.step(timeout=0)
  self.assertEqual(w.authorization["state"],"invalid");self.assertFalse((self.paths.runtime/"authorized").exists())
 def test_corrupt_ledger_preserved_and_refused(self):
  bootstrap_approved(self.paths);self.paths.ledger.write_bytes(b"CORRUPT_PRIVATE_CANARY");before=self.paths.ledger.read_bytes()
  with self.assertRaises(LedgerUnavailable):self.make()
  self.assertEqual(self.paths.ledger.read_bytes(),before)
 def test_status_file_contains_closed_metadata_no_private_policy(self):
  bootstrap_approved(self.paths);w=self.make();w.write_status();path=self.paths.report/"reader-status.json";value=json.loads(path.read_text())
  self.assertEqual((path.stat().st_uid,path.stat().st_gid,path.stat().st_mode&0o777),(0,1000,0o640))
  self.assertTrue(value["source_authorized"]);self.assertEqual(value["last_intake_state"],"waiting")
  self.assertNotIn(self.approval,path.read_text());self.assertFalse(value["full24h_proven"])
 def test_bootstrap_requires_current_enabled_authority(self):
  self.write(self.paths.authorization,{**self.auth,"enabled":False})
  with self.assertRaises(GateInvalid):bootstrap_approved(self.paths)
  self.assertFalse(self.paths.ledger.exists())
 def test_new_status_reports_no_historical_source_horizon_after_reader_restart(self):
  bootstrap_approved(self.paths);w=self.make()
  w.ledger.frame(json.dumps(frame(v=2,final=False)).encode(),300,source_binding_verified=True)
  w.close();w=self.make();w.write_status()
  value=json.loads((self.paths.report/'reader-status.json').read_text())
  self.assertEqual(value['schema_version'],2);self.assertIsNone(value['source_facts'])
 def test_status_exposes_source_horizon_only_after_current_verified_intake(self):
  bootstrap_approved(self.paths);w=self.make()
  w.ledger.frame(json.dumps(frame(v=2,final=True)).encode(),300,source_binding_verified=True)
  from worker import boottime
  w.last_source_completed=boottime();w.last_intake='accepted'
  with patch.object(w.source_verifier,'sender_state',return_value='verified_exited'):
   w.write_status();value=json.loads((self.paths.report/'reader-status.json').read_text())
   self.assertEqual(value['source_facts']['emitted_boottime_ns'],'201')
   self.assertTrue(value['source_facts']['closed']);self.assertEqual(value['source_facts']['identity_state'],'verified_exited')
   w.last_intake='unknown';w.write_status()
   self.assertIsNone(json.loads((self.paths.report/'reader-status.json').read_text())['source_facts'])
if __name__=="__main__":
 assert os.getuid()==os.getgid()==0
 unittest.main()
