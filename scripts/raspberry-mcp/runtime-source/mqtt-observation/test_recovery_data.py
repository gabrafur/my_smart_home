"""Recovery file-safety fixtures; native consumer validation is a separate proof."""
from pathlib import Path
import fcntl,json,os,tempfile,unittest
from worker import Paths
from recovery_data import snapshot_data,restore_data,RecoveryUnavailable
from handoff_ledger import HandoffLedger
from authorization_gate import SCOPE
from test_protocol import frame
@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0, "requires isolated Root ownership fixture; ordinary suite never escalates")
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="mqtt-recovery-safety-");self.base=Path(self.temp.name)
  self.source=self.paths("source");self.dest=self.paths("dest")
  self.ledger=HandoffLedger(self.source.ledger,create=True,clock_domain_id="d"*64,started_ns=100)
  self.ledger.frame(json.dumps(frame()).encode(),300,source_binding_verified=True)
  for name,raw in [("state.json",b'{"synthetic":1}'),("ack.json",b'{"synthetic_ack":1}'),("lock",b"")]:
   path=self.source.consumer/name;path.write_bytes(raw);path.chmod(0o600);os.chown(path,1000,1000)
  self.snap=self.base/"snapshot"
 def paths(self,name):
  root=self.base/name;root.mkdir(mode=0o700);p=Paths(root/"state",root/"runtime",root/"report",root/"consumer")
  for path,uid,gid,mode in [(p.state,0,0,0o700),(p.runtime,0,0,0o755),(p.report,0,1000,0o750),(p.consumer,1000,1000,0o700)]:
   path.mkdir();path.chmod(mode);os.chown(path,uid,gid)
  p.authorization.write_text(json.dumps({"version":1,"scope":SCOPE,"enabled":False,"expires_at":None,"approval_id":"a"*64}));p.authorization.chmod(0o600)
  return p
 def tearDown(self):
  self.ledger.close();self.temp.cleanup()
 def test_snapshot_excludes_grants_source_policy_and_proposals(self):
  manifest=snapshot_data(self.source,self.snap)
  self.assertFalse(manifest["authorization_included"]);self.assertFalse(manifest["source_policy_included"])
  self.assertEqual(set(manifest["files"]),{"state.sqlite3","consumer-state.json","consumer-ack.json"})
  self.assertEqual({p.name for p in self.snap.iterdir()},set(manifest['files'])|{'manifest.json'})
 def test_busy_consumer_refused_without_wait_or_state_change(self):
  fd=os.open(self.source.consumer/"lock",os.O_RDONLY)
  try:
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   with self.assertRaisesRegex(RecoveryUnavailable,"consumer_busy"):snapshot_data(self.source,self.snap)
   self.assertEqual((self.source.consumer/"state.json").read_bytes(),b'{"synthetic":1}')
  finally:os.close(fd)
 def test_unlisted_file_is_not_silently_omitted_from_restore(self):
  snapshot_data(self.source,self.snap);p=self.snap/'authorization.json';p.write_bytes(b'{}');p.chmod(0o600)
  with self.assertRaisesRegex(RecoveryUnavailable,'inventory_changed'):restore_data(self.dest,self.snap)
  self.assertFalse(self.dest.ledger.exists())
 def test_tampered_copy_refused_before_writing_destination(self):
  snapshot_data(self.source,self.snap);(self.snap/"consumer-state.json").write_bytes(b"altered")
  with self.assertRaisesRegex(RecoveryUnavailable,"digest_mismatch"):restore_data(self.dest,self.snap)
  self.assertFalse(self.dest.ledger.exists())
 def test_restore_requires_current_authorization_disabled(self):
  snapshot_data(self.source,self.snap);value=json.loads(self.dest.authorization.read_text());value["enabled"]=True
  self.dest.authorization.write_text(json.dumps(value))
  with self.assertRaisesRegex(RecoveryUnavailable,"requires_disabled_authorization"):restore_data(self.dest,self.snap)
  self.assertFalse(self.dest.ledger.exists())
 def test_extra_grant_in_manifest_refused(self):
  snapshot_data(self.source,self.snap);path=self.snap/"manifest.json";value=json.loads(path.read_text());value["files"]["authorization.json"]={"sha256":"a"*64,"bytes":0}
  path.write_text(json.dumps(value))
  with self.assertRaisesRegex(RecoveryUnavailable,"manifest_invalid"):restore_data(self.dest,self.snap)
  self.assertFalse(self.dest.ledger.exists())
 def test_data_roundtrip_preserves_nonzero_source_history_and_current_grant(self):
  snapshot_data(self.source,self.snap);before=self.dest.authorization.read_bytes();restore_data(self.dest,self.snap)
  restored=HandoffLedger(self.dest.ledger,create=False,clock_domain_id="d"*64,started_ns=400)
  try:self.assertEqual(restored.body["accepted_frames"],1);self.assertEqual(restored.body["faults"]["reader_restart"],1)
  finally:restored.close()
  self.assertEqual(self.dest.authorization.read_bytes(),before)
  with self.assertRaisesRegex(RecoveryUnavailable,"existing_state_refused"):restore_data(self.dest,self.snap)
if __name__=="__main__":unittest.main()
