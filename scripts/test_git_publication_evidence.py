import contextlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('publication',Path(__file__).with_name('git-publication-evidence.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SHA='a'*40
LOG='''[2026-01-01T01:00:00+00:00] backup started
Documentation check failed (4 issue(s)):
- docs/DEPENDENCY_PROVENANCE.en.md:31: referenced path is missing or untracked: homeassistant/custom_components/hacs/
- docs/DEPENDENCY_PROVENANCE.md:33: referenced path is missing or untracked: homeassistant/custom_components/hacs/
- docs/i18n-manifest.json: classified path is outside human documentation scope: homeassistant/custom_components/hacs/validate/README.md
- missing tracked i18n document: homeassistant/custom_components/hacs/validate/README.md
[2026-01-01T01:00:12+00:00] backup failed: could not push origin/main reason=validation_failed
'''
class Publication(unittest.TestCase):
 def test_remote_mismatch_and_worktree_drift_refused(self):
  for outputs in [['main','',SHA,'b'*40+'\trefs/heads/main'],['main','',SHA,SHA+'\trefs/heads/main','b'*40],['main',' M private']]:
   with patch.object(m,'command',side_effect=outputs), self.assertRaises(RuntimeError):m.verified_head()
 def test_exact_remote_identity(self):
  with patch.object(m,'command',side_effect=['main','',SHA,SHA+'\trefs/heads/main',SHA,'']):self.assertEqual(m.verified_head(),SHA)
 def test_failure_requires_complete_exact_cycle(self):
  self.assertEqual(m.hacs_failure(LOG),'2026-01-01T01:00:12+00:00')
  for text in [LOG.replace('backup started','other'),LOG.replace('missing tracked i18n','untrusted'),LOG.replace('backup failed:','unknown:')]:
   with self.assertRaises(RuntimeError):m.hacs_failure(text)
 def test_receipt_is_separate_idempotent_and_preserves_history(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);p=root/'.git-backup.log';p.write_text(LOG);p.chmod(0o600)
   with patch.object(m,'verified_head',return_value=SHA),patch.object(m,'command',return_value='ok'):
    a=m.record('interactive',True,root);b=m.record('interactive',True,root)
   self.assertEqual(a['state'],'remote_main_verified_receipt_recorded');self.assertEqual(b['state'],'existing_receipt_preserved')
   text=p.read_text();self.assertTrue(text.startswith(LOG));self.assertEqual(text.count('git publication verified:'),1);self.assertNotIn('backup finished: pushed',text)
 def test_failed_docs_does_not_publish_correction(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);p=root/'.git-backup.log';p.write_text(LOG);p.chmod(0o600)
   with patch.object(m,'verified_head',return_value=SHA),patch.object(m,'command',side_effect=RuntimeError('fixed_read_failed')),self.assertRaises(RuntimeError):m.record('interactive',True,root)
   self.assertEqual(p.read_text(),LOG)
 def test_symlink_or_shared_log_refused(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);p=root/'.git-backup.log';target=root/'target';target.write_text(LOG);p.symlink_to(target)
   with patch.object(m,'verified_head',return_value=SHA),self.assertRaises(OSError):m.record('interactive',root=root)
   p.unlink();p.write_text(LOG);p.chmod(0o666)
   with patch.object(m,'verified_head',return_value=SHA),self.assertRaises(RuntimeError):m.record('interactive',root=root)
if __name__=='__main__':unittest.main()
