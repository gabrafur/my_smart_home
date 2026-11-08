"""Fictitious filesystem and mountinfo only; never mounts or reads house data."""
import importlib.util,os,tempfile,unittest,subprocess,json
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('candidate',Path(__file__).with_name('root_snapshot.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PendingMount(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.patcher=patch.object(m,'INPUT',self.root);self.patcher.start();self.target=self.root/'audit-requested'
 def tearDown(self):self.patcher.stop();self.temp.cleanup()
 def line(self,root=None,options='ro',target=None):
  device=self.root.stat().st_dev
  return f"42 1 {os.major(device)}:{os.minor(device)} {root or m.PENDING_SOURCES['audit-requested']} {target or self.target} {options} shared:2 - ext4 /dev/fictitious rw\n"
 def test_missing_source_without_mount(self):self.assertIs(m.pending_presence('audit-requested',''),False)
 def test_stale_empty_destination_not_pending(self):
  self.target.touch();self.assertIs(m.pending_presence('audit-requested',''),False)
 def test_actual_mounted_empty_request(self):
  self.target.touch();self.assertIs(m.pending_presence('audit-requested',self.line()),True)
 def test_actual_mounted_request_contents_not_read(self):
  self.target.write_text('fictitious request');self.assertIs(m.pending_presence('audit-requested',self.line()),True)
 def test_unrelated_mount_not_pending(self):
  self.target.touch();self.assertIs(m.pending_presence('audit-requested',self.line(target=self.root/'other')),False)
 def test_wrong_source_unknown(self):
  self.target.touch();self.assertIsNone(m.pending_presence('audit-requested',self.line(root='/unapproved')))
 def test_writable_unknown(self):
  self.target.touch();self.assertIsNone(m.pending_presence('audit-requested',self.line(options='rw')))
 def test_missing_mounted_target_unknown(self):self.assertIsNone(m.pending_presence('audit-requested',self.line()))
 def test_ambiguous_duplicate_unknown(self):
  self.target.touch();self.assertIsNone(m.pending_presence('audit-requested',self.line()*2))
 def test_malformed_or_oversize_unknown(self):
  for value in ('garbage','x'*1048577):self.assertIsNone(m.pending_presence('audit-requested',value))
 def test_final_projection_retains_snapshot_time_and_limitation(self):
  observed='2026-11-08T19:00:00Z'
  program="const m=require('./kia_model.cjs');const v=m.project({now_unix_seconds:1794164430,sources:{pending:{observed_at:'2026-11-08T19:00:00Z',collection_error:null,data:{audit_requested:false,audit_processing:false,audit_followup:false,merge_requested:false,merge_processing:false}}}});console.log(JSON.stringify(v.sources.find(r=>r.source==='pending')))"
  row=json.loads(subprocess.check_output(['node','-e',program],cwd=Path(__file__).parent,text=True,timeout=10))
  self.assertIn('pending_flags_snapshot_at_reader_activation_not_live_queue',row['coverage'])
  self.assertEqual(row['observed_at'],observed);self.assertEqual(row['source_updated_at'],observed)
  self.assertFalse(row['pending']['audit_requested'])
 def test_mount_escapes(self):self.assertEqual(m.mount_unescape(r'/fiction\040space\134name'),'/fiction space\\name')
 def test_symlink_unknown(self):
  (self.root/'other').touch();self.target.symlink_to(self.root/'other');self.assertIsNone(m.pending_presence('audit-requested',self.line()))
if __name__=='__main__':unittest.main()
