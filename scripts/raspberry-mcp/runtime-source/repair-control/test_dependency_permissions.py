"""Exercise the real configuration verifier with mode-enforcing synthetic IO."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
try:
    spec = importlib.util.spec_from_file_location('_repair_permission_contract', HERE / 'repair_control.py')
    control = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(control)
finally:
    sys.path.pop(0)

BINDING = '/etc/raspberry-nodered-diagnostics/kia-runtime-binding.json'
SOURCES = ('repair_control.py', 'repair_store.py', 'repair_rpc.cjs',
           'health_summary.py', 'repair-broker.py', 'verify_candidate.py',
           'test_health_summary.py', 'test_repair_store.py',
           'test_repair_control.py', 'test_events.mjs', 'event_projection.mjs')


class DependencyPermissionTests(unittest.TestCase):
    def fixture(self, private_path=BINDING, private_mode=0o640, public_mode=0o644):
        body = b'synthetic bytes only'
        digest = hashlib.sha256(body).hexdigest()
        policy = dict(enabled=True, expires_at=control.EXPIRY,
                      thread=control.THREAD, tasks=[control.TASK],
                      maximum_submissions=2,
                      source_hashes={name: digest for name in SOURCES},
                      dependencies={private_path: digest, '/synthetic/public.cjs': digest})
        files = {str(control.ROOT / name): (body, 0o644) for name in SOURCES}
        files[private_path] = (body, private_mode)
        files['/synthetic/public.cjs'] = (body, public_mode)
        files[str(control.POLICY)] = (json.dumps(policy).encode(), 0o644)

        def read(path, uid, mode):
            self.assertEqual(uid, 0)
            raw, actual_mode = files[str(path)]
            if actual_mode != mode:
                raise ValueError('unsafe_task_file')
            return raw
        return types.SimpleNamespace(read=read), files

    def test_private_binding_remains_group_readable_and_hash_pinned(self):
        tasks, _ = self.fixture()
        self.assertIn(BINDING, control.configuration(tasks)['dependencies'])

    def test_private_binding_world_readable_is_rejected(self):
        tasks, _ = self.fixture(private_mode=0o644)
        with self.assertRaisesRegex(ValueError, 'unsafe_task_file'):
            control.configuration(tasks)

    def test_public_dependency_does_not_gain_private_mode_exception(self):
        tasks, _ = self.fixture(public_mode=0o640)
        with self.assertRaisesRegex(ValueError, 'unsafe_task_file'):
            control.configuration(tasks)

    def test_other_private_filename_does_not_gain_exception(self):
        tasks, _ = self.fixture(private_path=BINDING + '.other')
        with self.assertRaisesRegex(ValueError, 'unsafe_task_file'):
            control.configuration(tasks)

    def test_private_binding_changed_bytes_are_rejected(self):
        tasks, files = self.fixture()
        files[BINDING] = (b'changed synthetic binding', 0o640)
        with self.assertRaisesRegex(ValueError, 'repair_dependency_changed'):
            control.configuration(tasks)


if __name__ == '__main__':
    unittest.main()
