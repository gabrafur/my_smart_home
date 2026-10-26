"""Deployment lifecycle tests in a disposable directory, with no system calls."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

P = Path(__file__).parent
spec = importlib.util.spec_from_file_location('budget_deployment', P.parent/'runtime-source/administrative-recovery/apply_procmon_runtime_budget.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stage = self.root/'stage'; self.stage.mkdir()
        self.state = self.root/'state'
        self.targets = {name: str(self.root/name) for name in ['observed_collector.py', 'raspberry-procmon.service']}
        self.before = {name: b'before:'+name.encode() for name in self.targets}
        self.after = {name: b'after:'+name.encode() for name in self.targets}
        for name, path in self.targets.items():
            Path(path).write_bytes(self.before[name]); (self.stage/name).write_bytes(self.after[name])
        for name in ['deploy.py', 'sealed_helpers.py']:
            (self.stage/name).write_bytes(b'isolated-fixture')
        self.manifest = {'expires_at': m.EXPIRY, 'operation_id': 'fixture', 'unchanged': {},
            'historical_reports': {}, 'targets': {name: {'path': path,
                'before': m.sha(self.before[name]), 'after': m.sha(self.after[name])}
                for name, path in self.targets.items()}}
        self.write_manifest()
        self.manager_timeout = '7s'
        self.reloads = 0
        self.h = types.SimpleNamespace(read=lambda p, *args: p.read_bytes(),
            atomic=lambda p, b, *args: p.write_bytes(b), directory=lambda p, *args: p.mkdir(),
            chains=lambda: object(), locks=lambda tasks: contextlib.nullcontext())
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        for name, value in [('STAGE', self.stage), ('STATE', self.state), ('BUNDLE', self.state/'bundle'),
                            ('TARGETS', self.targets), ('MANIFEST_SHA', m.sha((self.stage/'MANIFEST.json').read_bytes()))]:
            self.stack.enter_context(patch.object(m, name, value))
        self.stack.enter_context(patch.object(m, 'helper', return_value=self.h))
        self.stack.enter_context(patch.object(m, 'gate'))
        self.stack.enter_context(patch.object(m, 'collector_lock', side_effect=contextlib.nullcontext))
        self.stack.enter_context(patch.object(m, 'reports', return_value={}))
        self.stack.enter_context(patch.object(m, 'manager', side_effect=lambda: {
            'MainPID': '0', 'TimeoutStartUSec': self.manager_timeout}))
        self.stack.enter_context(patch.object(m, 'reload_unit', side_effect=self.reload))

    def write_manifest(self):
        (self.stage/'MANIFEST.json').write_bytes(m.raw(self.manifest))

    def reload(self):
        self.reloads += 1
        self.manager_timeout = '20s' if Path(self.targets['raspberry-procmon.service']).read_bytes() == self.after['raspberry-procmon.service'] else '7s'

    def test_preflight_is_readonly_and_apply_persists_before_intent(self):
        m.main('preflight'); self.assertFalse(self.state.exists())
        m.main('apply')
        self.assertTrue((self.state/'intent.json').exists())
        for name, path in self.targets.items():
            self.assertEqual(Path(path).read_bytes(), self.after[name])
            self.assertEqual((self.state/'before'/name).read_bytes(), self.before[name])
        self.assertEqual(self.reloads, 1)
        self.assertFalse(json.loads((self.state/'applied.json').read_text())['collector_invoked'])

    def test_duplicate_apply_refused_without_second_reload(self):
        m.main('apply')
        self.assertRaisesRegex(ValueError, 'existing_intent', m.main, 'apply')
        self.assertEqual(self.reloads, 1)

    def test_candidate_tamper_refused_before_production_writes(self):
        (self.stage/'observed_collector.py').write_bytes(b'tampered')
        self.assertRaisesRegex(ValueError, 'candidate_changed', m.main, 'apply')
        self.assertFalse(self.state.exists()); self.assertEqual(self.reloads, 0)

    def test_baseline_change_refused_without_intent(self):
        Path(self.targets['raspberry-procmon.service']).write_bytes(b'other-edit')
        self.assertRaisesRegex(ValueError, 'target_baseline_changed', m.main, 'apply')
        self.assertFalse(self.state.exists())

    def test_uncertain_reload_durable_no_automatic_retry(self):
        with patch.object(m, 'reload_unit', side_effect=TimeoutError):
            self.assertRaises(TimeoutError, m.main, 'apply')
        self.assertTrue((self.state/'reload-intent.json').exists())
        self.assertTrue((self.state/'unconfirmed.json').exists())
        self.assertFalse((self.state/'applied.json').exists())
        self.assertRaisesRegex(ValueError, 'existing_intent', m.main, 'apply')
        self.assertEqual(self.reloads, 0)

    def test_partial_write_failure_preserved_for_guarded_rollback(self):
        ordinary = self.h.atomic
        def fail_second(path, data, *args):
            if str(path) == self.targets['raspberry-procmon.service']:
                raise OSError('synthetic-write-failure')
            return ordinary(path, data, *args)
        with patch.object(self.h, 'atomic', side_effect=fail_second):
            self.assertRaises(OSError, m.main, 'apply')
        self.assertTrue((self.state/'unconfirmed.json').exists())
        self.assertEqual(Path(self.targets['observed_collector.py']).read_bytes(), self.after['observed_collector.py'])
        self.assertEqual(Path(self.targets['raspberry-procmon.service']).read_bytes(), self.before['raspberry-procmon.service'])
        m.main('rollback')
        self.assertTrue((self.state/'rolled-back.json').exists())
        for name, path in self.targets.items():
            self.assertEqual(Path(path).read_bytes(), self.before[name])

    def test_successful_rollback_preserves_original_intent_and_is_not_repeated(self):
        m.main('apply'); intent = (self.state/'intent.json').read_bytes()
        m.main('rollback')
        self.assertEqual((self.state/'intent.json').read_bytes(), intent)
        self.assertRaisesRegex(ValueError, 'rollback_requires_reconciliation', m.main, 'rollback')
        self.assertEqual(self.reloads, 2)

    def test_external_edit_refuses_rollback_without_overwriting(self):
        m.main('apply')
        p = Path(self.targets['observed_collector.py']); p.write_bytes(b'external')
        self.assertRaisesRegex(ValueError, 'external_edit', m.main, 'rollback')
        self.assertEqual(p.read_bytes(), b'external')
        self.assertFalse((self.state/'rollback-intent.json').exists())

    def test_unknown_manager_result_is_unconfirmed_and_reconciled_without_retry(self):
        with patch.object(m, 'reload_unit'):
            self.assertRaisesRegex(ValueError, 'unit_reload_unconfirmed', m.main, 'apply')
        self.assertTrue((self.state/'unconfirmed.json').exists())
        self.assertRaisesRegex(ValueError, 'existing_intent', m.main, 'apply')

    def test_expired_gate_prevents_any_production_edit(self):
        with patch.object(m, 'gate', side_effect=ValueError('valid_authority_required')):
            self.assertRaisesRegex(ValueError, 'valid_authority', m.main, 'apply')
        self.assertFalse(self.state.exists()); self.assertEqual(self.reloads, 0)


if __name__ == '__main__':
    unittest.main()
