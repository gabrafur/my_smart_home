import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from rollback_cloud_locks import docker_marker, require_daily_caller


class LockTests(unittest.TestCase):
    def test_existing_marker_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root/'.docker-auto-update.lock'
            marker.write_text('third-party\n')
            with self.assertRaises(FileExistsError):
                with docker_marker(root):
                    self.fail('must not acquire existing marker')
            self.assertEqual(marker.read_text(), 'third-party\n')

    def test_own_marker_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with docker_marker(root):
                self.assertTrue((root/'.docker-auto-update.lock').exists())
            self.assertFalse((root/'.docker-auto-update.lock').exists())

    def test_replaced_marker_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root/'.docker-auto-update.lock'
            with self.assertRaisesRegex(ValueError, 'changed'):
                with docker_marker(root):
                    marker.unlink()
                    marker.write_text('other-owner\n')
            self.assertEqual(marker.read_text(), 'other-owner\n')

    def test_daily_lock_requires_matching_ancestor_and_kernel_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'.daily-maintenance.lock').write_text('')
            proc = root/'proc'
            parent = proc/'123'
            parent.mkdir(parents=True)
            (parent/'cmdline').write_bytes(str(root/'scripts/process-update-stage-request.sh').encode()+b'\0offsite-backup\0')
            (parent/'stat').write_text('123 (flock) S 1 0 0')
            info = (root/'.daily-maintenance.lock').stat()
            (proc/'locks').write_text(f'1: FLOCK ADVISORY WRITE 123 {os.major(info.st_dev):x}:{os.minor(info.st_dev):x}:{info.st_ino} 0 EOF\n')
            with patch('rollback_cloud_locks.os.getppid', return_value=123):
                require_daily_caller(root, proc)
            (proc/'locks').write_text('')
            with patch('rollback_cloud_locks.os.getppid', return_value=123):
                with self.assertRaisesRegex(ValueError, 'not_held'):
                    require_daily_caller(root, proc)


class BackendTests(unittest.TestCase):
    def load_backend(self, running):
        transport = types.ModuleType('rollback_cloud_transport')
        transport.POLICY = {'existing_running_wsl_distribution': 'ExistingDistro'}
        calls = []
        def remote(script):
            calls.append(script)
            return {'state': 'running_distributions', 'names': running}
        transport.remote = remote
        upload = types.ModuleType('rollback_cloud_upload')
        upload.upload = lambda row: self.fail('unexpected upload')
        file = Path(__file__).with_name('rollback_cloud_backend.py')
        spec = importlib.util.spec_from_file_location('backend_under_test', file)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'rollback_cloud_transport': transport, 'rollback_cloud_upload': upload}):
            spec.loader.exec_module(module)
        return module.Backend(lambda: None), calls

    def test_stopped_wsl_never_runs_archive_verifier(self):
        backend, calls = self.load_backend([])
        with self.assertRaisesRegex(ValueError, 'not_running'):
            backend.verify_archive({'image_id': 'a' * 64})
        self.assertEqual(len(calls), 1)
        self.assertIn('--list --running', calls[0])
        self.assertNotIn('--exec', calls[0])

    def test_other_running_distribution_does_not_match(self):
        backend, calls = self.load_backend(['UnrelatedDistro'])
        self.assertFalse(backend.wsl_running())

    def test_exact_running_distribution_matches(self):
        backend, calls = self.load_backend(['ExistingDistro'])
        self.assertTrue(backend.wsl_running())


    def test_repository_protection_does_not_promote_unreviewed_alternatives(self):
        backend, calls = self.load_backend([])
        values = ['sha256:'+letter*64 for letter in 'abc']
        rows = {identity: {'image_id': identity, 'created_at': 0, 'tags': [], 'rollback_in_use': False} for identity in values}
        def docker(*args):
            if args[:2] == ('image', 'ls'):
                return ('\n'.join(values)).encode()
            return b''
        glob = backend.inventory.__globals__
        transport = glob['transport']
        transport.docker = docker
        transport.POLICY['protected_image_ids'] = []
        backend.repository_reference = lambda identity: identity in values[:2]
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(glob, {'ROOT': Path(directory), 'snapshot': lambda identity: rows[identity]}):
                observed, protected = backend.inventory()
        self.assertEqual([r['image_id'] for r in observed], values[:2])
        self.assertTrue(set(values[:2]).issubset(protected))
        self.assertNotIn(values[2], [r['image_id'] for r in observed])


if __name__ == '__main__':
    unittest.main()
