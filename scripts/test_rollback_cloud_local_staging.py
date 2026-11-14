import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import rollback_cloud_local as local
from rollback_cloud_policy import operation_id, verify_proofs
from rollback_cloud_cycle import run_cycle
from test_rollback_cloud_policy import FakeBackend, MemoryLedger, IMAGE


class FakeSave:
    def __init__(self):
        self.stdout = io.BytesIO(b'fictitious docker save stream')
    def wait(self, timeout=None):
        return 0
    def poll(self):
        return 0


class Tests(unittest.TestCase):
    def load_backend(self):
        transport = types.ModuleType('rollback_cloud_transport')
        transport.POLICY = {'allow_existing_pc_fallback': True}
        upload = types.ModuleType('rollback_cloud_upload')
        upload.upload = lambda *args, **kwargs: self.fail('unexpected upload')
        file = Path(__file__).with_name('rollback_cloud_backend.py')
        spec = importlib.util.spec_from_file_location('backend_local_test', file)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'rollback_cloud_transport': transport, 'rollback_cloud_upload': upload}):
            spec.loader.exec_module(module)
        return module.Backend(lambda: None)

    def test_local_capacity_does_not_probe_offline_pc(self):
        backend = self.load_backend()
        backend.pc_available = lambda: self.fail('PC must not be required with local space')
        with patch.object(local, 'free_bytes', return_value=6 * 1024**3):
            self.assertTrue(backend.staging_available())

    def test_pressure_can_use_existing_pc(self):
        backend = self.load_backend()
        backend.pc_available = lambda: True
        with patch.object(local, 'free_bytes', return_value=5 * 1024**3):
            self.assertTrue(backend.staging_available())

    def test_pressure_and_offline_pc_defer(self):
        backend = self.load_backend()
        backend.pc_available = lambda: False
        with patch.object(local, 'free_bytes', return_value=5 * 1024**3):
            self.assertFalse(backend.staging_available())

    def test_local_export_identity_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)/'local'
            with patch.object(local, 'DIRECTORY', folder), patch.object(local, 'free_bytes', return_value=10 * 1024**3), patch.object(local.subprocess, 'Popen', return_value=FakeSave()):
                result = local.export_local(IMAGE, 1024)
                self.assertEqual(result['state'], 'local_archive_hash_verified')
                self.assertNotIn('pc_file', result)
                self.assertEqual(result['sha256'], hashlib.sha256(Path(result['local_file']).read_bytes()).hexdigest())

    def test_writer_stops_at_free_space_floor(self):
        with tempfile.TemporaryFile() as file:
            writer = local.Writer(file.fileno(), 1024)
            with patch.object(local, 'free_bytes', return_value=local.FLOOR_FREE_BYTES):
                with self.assertRaisesRegex(ValueError, 'floor'):
                    writer.write(b'x')
            self.assertEqual(file.tell(), 0)

    def test_cleanup_requires_retirement_and_cloud_proof(self):
        with self.assertRaisesRegex(ValueError, 'retirement_required'):
            local.cleanup_local({'image_id': 'a' * 64}, {'state': 'cloud_verified'})

    def test_cleanup_own_archive_only_after_durable_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root/'local'
            folder.mkdir(mode=0o700)
            archive = folder/('a'*64+'.docker.tar.gz')
            archive.write_bytes(b'fictitious archive')
            os.chmod(archive, 0o600)
            row = {'state': 'local_archive_hash_verified', 'image_id': 'a'*64, 'local_file': str(archive),
                   'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                   'local_identity': local.identity(archive.stat())}
            cloud = {'state': 'cloud_roundtrip_sha256_verified', 'image_id': 'a'*64, 'bytes': row['bytes'], 'sha256': row['sha256']}
            fmt = {'state': 'docker_archive_manifest_and_blobs_verified', 'image_id': 'a'*64}
            receipt = {'state': 'retired', 'archive': row, 'cloud': cloud, 'format_proof': fmt,
                       'proof_sha256': verify_proofs(IMAGE, row, cloud, fmt)}
            ledger = root/(operation_id(IMAGE)+'.json')
            with patch.object(local, 'DIRECTORY', folder):
                with self.assertRaisesRegex(ValueError, 'not_durable'):
                    local.cleanup_local(row, receipt)
                self.assertTrue(archive.exists())
                ledger.write_text(json.dumps(receipt))
                local.cleanup_local(row, receipt)
            self.assertFalse(archive.exists())
            self.assertTrue(ledger.exists())

    def test_cleanup_changed_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)/'local'
            folder.mkdir(mode=0o700)
            archive = folder/('a'*64+'.docker.tar.gz')
            archive.write_bytes(b'changed')
            row = {'image_id': 'a'*64, 'local_file': str(archive), 'local_identity': {}, 'bytes': 1, 'sha256': 'b'*64}
            with patch.object(local, 'DIRECTORY', folder):
                with self.assertRaisesRegex(ValueError, 'identity_changed'):
                    local.open_verified_archive(row)
            self.assertTrue(archive.exists())


if __name__ == '__main__':
    unittest.main()
