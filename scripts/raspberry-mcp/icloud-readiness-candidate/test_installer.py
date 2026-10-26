import contextlib,importlib.util,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('readiness_installer',Path(__file__).with_name('apply.py'));a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
class Cases(unittest.TestCase):
 def test_modified_manifest_refused_before_importing_package_or_spawning(self):
  with patch.object(a,'read',return_value=b'{}'),patch.object(a.subprocess,'run')as run:
   with self.assertRaisesRegex(ValueError,'manifest_changed'):a.load()
   run.assert_not_called()
 def test_scope_expiry_denies_before_locks_or_service_control(self):
  with patch.object(a,'__file__',str(a.STAGE/'apply.py')),patch.object(a.os,'geteuid',return_value=0),patch.object(a.sys,'argv',['apply.py','apply-approved']),patch.object(a,'load',return_value=({}, {},object())),patch.object(a.time,'time',return_value=a.EXPIRY),patch.object(a,'chains')as chain:
   with self.assertRaisesRegex(ValueError,'administrative_authority_expired'):a.main()
   chain.assert_not_called()
 def test_existing_intent_prevents_repetition_of_activation_or_restart(self):
  with tempfile.TemporaryDirectory()as folder:
   state=Path(folder);after={'file':b'candidate'};model=types.SimpleNamespace(proposed=lambda *args:after)
   with patch.object(a,'__file__',str(a.STAGE/'apply.py')),patch.object(a.os,'geteuid',return_value=0),patch.object(a.sys,'argv',['apply.py','apply-approved']),patch.object(a,'STATE',state),patch.object(a.time,'time',return_value=a.EXPIRY-1000),patch.object(a,'load',return_value=({},after,model)),patch.object(a,'chains',return_value=object()),patch.object(a,'locks',return_value=contextlib.nullcontext()),patch.object(a,'unchanged',return_value={}),patch.object(a,'historical_receipts',return_value={}),patch.object(a,'root_backend'),patch.object(a,'active',return_value=True),patch.object(a,'baseline',return_value={}),patch.object(a,'atomic')as atomic,patch.object(a,'activate_service')as restart:
    with self.assertRaisesRegex(ValueError,'existing_intent_requires_reconciliation'):a.main()
    atomic.assert_not_called();restart.assert_not_called()
 def test_restart_has_separate_intent_and_no_retry_after_uncertain_result(self):
  with tempfile.TemporaryDirectory()as folder:
   state=Path(folder)
   with patch.object(a,'STATE',state),patch.object(a.time,'time',return_value=a.EXPIRY-1000),patch.object(a.subprocess,'run',side_effect=TimeoutError('synthetic'))as run:
    with self.assertRaises(TimeoutError):a.activate_service('apply')
    self.assertEqual(run.call_count,1);self.assertTrue((state/'apply-restart-intent.json').exists())
    with self.assertRaisesRegex(ValueError,'restart_intent_requires_reconciliation'):a.activate_service('apply')
    self.assertEqual(run.call_count,1)
 def test_native_HA_observer_is_only_restarted_unit(self):
  with tempfile.TemporaryDirectory()as folder:
   with patch.object(a,'STATE',Path(folder)),patch.object(a.time,'time',return_value=a.EXPIRY-1000),patch.object(a.subprocess,'run')as run,patch.object(a,'active',return_value=True):a.activate_service('rollback')
   argv=[c.args[0]for c in run.call_args_list];self.assertEqual(argv,[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','restart','raspberry-ha-notices.service']]);self.assertNotIn('homeassistant',str(argv))
if __name__=='__main__':unittest.main()
