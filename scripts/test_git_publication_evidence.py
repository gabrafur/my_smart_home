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
START='2026-01-01T01:00:00+00:00'
FINISH='2026-01-01T01:00:12+00:00'
LOG=f'''[{START}] backup started
Documentation check failed (4 issue(s)):
- docs/DEPENDENCY_PROVENANCE.en.md:31: referenced path is missing or untracked: homeassistant/custom_components/hacs/
- docs/DEPENDENCY_PROVENANCE.md:33: referenced path is missing or untracked: homeassistant/custom_components/hacs/
- docs/i18n-manifest.json: classified path is outside human documentation scope: homeassistant/custom_components/hacs/validate/README.md
- missing tracked i18n document: homeassistant/custom_components/hacs/validate/README.md
[{FINISH}] backup failed: could not push origin/main reason=validation_failed
'''
class Publication(unittest.TestCase):
 def test_remote_mismatch_and_worktree_drift_refused(self):
  for outputs in [['main','',SHA,'b'*40+'\trefs/heads/main'],['main','',SHA,SHA+'\trefs/heads/main','b'*40],['main',' M private']]:
   with patch.object(m,'command',side_effect=outputs), self.assertRaises(RuntimeError):m.verified_head()
 def test_exact_remote_identity(self):
  with patch.object(m,'command',side_effect=['main','',SHA,SHA+'\trefs/heads/main',SHA,'']):self.assertEqual(m.verified_head(),SHA)
 def test_failure_requires_complete_exact_cycle(self):
  self.assertEqual(m.hacs_failure(LOG),FINISH)
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
class PushFailureSummary(unittest.TestCase):
    def test_streams_output_and_keeps_only_failure_lines(self):
        import io
        lines=['pre-push: running canonical public validation\n','ok 1 - fine\n',
               '    not ok 525 - codex account status route and classifier pass their suite\n',
               'ERROR: test_composer (test_codex_chat_card_browser.CodexChatCardBrowserTest)\n',
               'FAILED (errors=5, skipped=13)\n','make[1]: *** [Makefile:246: validate-scripts] Error 1\n',
               '# fail 0\n','error: failed to push some refs\n']
        class Fake:
            def __init__(self,*a,**k):self.stdout=iter(lines);self.args=a
            def wait(self):return 1
        out=io.StringIO()
        code,kept=m.push_main({}, popen=Fake, out=out)
        self.assertEqual(code,1)
        self.assertEqual(out.getvalue(),''.join(lines))
        self.assertEqual(kept,['not ok 525 - codex account status route and classifier pass their suite',
            'ERROR: test_composer (test_codex_chat_card_browser.CodexChatCardBrowserTest)',
            'FAILED (errors=5, skipped=13)','make[1]: *** [Makefile:246: validate-scripts] Error 1'])
    def test_summary_is_private_and_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            first=m.save_failure_summary(['not ok 1 - a'],root)
            second=m.save_failure_summary(['not ok 2 - b'],root)
            self.assertEqual(first,second)
            self.assertEqual(oct(second.stat().st_mode&0o777),'0o600')
            self.assertEqual(oct(second.parent.stat().st_mode&0o777),'0o700')
            text=second.read_text()
            self.assertIn('not ok 2 - b',text);self.assertNotIn('not ok 1 - a',text)
            self.assertEqual(list(second.parent.iterdir()),[second])
            self.assertEqual(second.relative_to(root).as_posix(),'.git/publication-failures/last-push-failure.txt')
    def test_unwritable_location_never_hides_the_refused_push(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'.git').write_text('gitdir: elsewhere\n')
            self.assertIsNone(m.save_failure_summary(['not ok 1 - a'],root))

if __name__=='__main__':unittest.main()
