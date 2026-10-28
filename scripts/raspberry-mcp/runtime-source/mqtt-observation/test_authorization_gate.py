"""Root-only fixtures inside a disposable network-none container."""
from pathlib import Path
import json,os,stat,sys,tempfile,unittest
sys.path.insert(0,str(Path(__file__).parent))
from authorization_gate import AuthorizationGate,GateInvalid,SCOPE,parse_policy

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0, "requires isolated Root ownership fixture; ordinary suite never escalates")
class GateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="mqtt-gate-fixture-")
  self.base=Path(self.temp.name);self.runtime=self.base/"runtime";self.private=self.base/"private"
  self.runtime.mkdir(mode=0o755);self.runtime.chmod(0o755)
  self.private.mkdir(mode=0o700);self.private.chmod(0o700)
  self.policy=self.private/"authorization.json";self.gate=AuthorizationGate(self.runtime,self.policy)
  self.valid={"version":1,"scope":SCOPE,"enabled":True,"expires_at":200,"approval_id":"a"*64}
 def tearDown(self):
  self.gate.close();self.temp.cleanup()
 def write(self,p=None):
  self.policy.write_text(json.dumps(self.valid if p is None else p));self.policy.chmod(0o600)
 def active(self):
  self.write();self.assertTrue(self.gate.refresh(100)["source_authorized"])
 def test_missing_policy_default_deny(self):
  self.assertFalse(self.gate.refresh(100)["source_authorized"]);self.assertFalse((self.runtime/"authorized").exists())
 def test_disabled_policy(self):
  self.write({**self.valid,"enabled":False});self.assertEqual(self.gate.refresh(100)["state"],"disabled")
 def test_valid_finite_policy_marker_is_exact(self):
  self.active();s=(self.runtime/"authorized").lstat()
  self.assertEqual((s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink,s.st_size),(0,0,0o444,1,0))
 def test_permanent_policy_is_only_explicit_null(self):
  self.write({**self.valid,"expires_at":None});self.assertTrue(self.gate.refresh(10**12)["source_authorized"])
 def test_expiry_removes_active_marker(self):
  self.active();self.assertEqual(self.gate.refresh(200)["state"],"expired");self.assertFalse((self.runtime/"authorized").exists())
 def test_restart_preserves_existing_approved_marker(self):
  self.active();before=(self.runtime/"authorized").stat().st_ino;self.gate.close()
  self.gate=AuthorizationGate(self.runtime,self.policy);s=self.gate.refresh(101)
  self.assertTrue(s["source_authorized"]);self.assertFalse(s["runtime_marker_changed"]);self.assertEqual((self.runtime/"authorized").stat().st_ino,before)
 def test_disable_removes_active_marker(self):
  self.active();self.write({**self.valid,"enabled":False});self.assertFalse(self.gate.refresh(100)["source_authorized"]);self.assertFalse((self.runtime/"authorized").exists())
 def test_invalid_policy_removes_active_marker(self):
  self.active();self.write({**self.valid,"extra":"PRIVATE_CANARY"})
  s=self.gate.refresh(100);self.assertFalse(s["source_authorized"]);self.assertNotIn("PRIVATE",json.dumps(s));self.assertFalse((self.runtime/"authorized").exists())
 def test_duplicate_json_keys_refused(self):
  self.policy.write_text('{"version":1,"version":1}');self.policy.chmod(0o600)
  self.assertEqual(self.gate.refresh(100)["state"],"invalid")
 def test_policy_symlink_refused(self):
  self.write();self.policy.rename(self.private/"other.json");self.policy.symlink_to("other.json")
  self.assertFalse(self.gate.refresh(100)["source_authorized"])
 def test_policy_permissions_refused(self):
  self.write();self.policy.chmod(0o644);self.assertFalse(self.gate.refresh(100)["source_authorized"])
 def test_policy_hardlink_refused(self):
  self.write();os.link(self.policy,self.private/"link");self.assertFalse(self.gate.refresh(100)["source_authorized"])
 def test_policy_owner_refused(self):
  self.write();os.chown(self.policy,1000,1000);self.assertFalse(self.gate.refresh(100)["source_authorized"])
 def test_invalid_runtime_marker_preserved_and_denied(self):
  self.write();marker=self.runtime/"authorized";marker.write_text("unrelated");marker.chmod(0o444)
  self.assertEqual(self.gate.refresh(100)["state"],"invalid");self.assertEqual(marker.read_text(),"unrelated")
 def test_revoked_marker_never_cleared_or_rearmed(self):
  self.active();(self.runtime/"revoked").touch()
  self.assertEqual(self.gate.refresh(100)["state"],"revoked");self.assertFalse((self.runtime/"authorized").exists())
  self.assertEqual(self.gate.refresh(101)["state"],"revoked")
 def test_runtime_directory_replacement_refused(self):
  self.active();self.runtime.rename(self.base/"old");self.runtime.mkdir(mode=0o755);self.runtime.chmod(0o755)
  self.assertEqual(self.gate.refresh(100)["state"],"invalid");self.assertFalse((self.runtime/"authorized").exists())
 def test_policy_directory_replacement_revokes_runtime(self):
  self.active();self.private.rename(self.base/"old");self.private.mkdir(mode=0o700)
  self.assertEqual(self.gate.refresh(100)["state"],"invalid");self.assertFalse((self.runtime/"authorized").exists())
 def test_closed_schema_types_and_values(self):
  for delta in [{"enabled":1},{"expires_at":True},{"expires_at":-1},{"scope":"other"},{"version":True},{"approval_id":"bad"}]:
   with self.subTest(delta=delta):
    with self.assertRaises(GateInvalid):parse_policy(json.dumps({**self.valid,**delta}).encode())
 def test_bad_clock_revokes_marker(self):
  self.active();self.assertFalse(self.gate.refresh(float("nan"))["source_authorized"]);self.assertFalse((self.runtime/"authorized").exists())
if __name__=="__main__":
 assert os.getuid()==os.getgid()==0
 unittest.main()
