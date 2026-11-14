import copy
import unittest
from rollback_cloud_policy import operation_id, select_images, verify_proofs
from rollback_cloud_cycle import run_cycle

IMAGE = 'sha256:' + 'a' * 64


class MemoryLedger:
    def __init__(self):
        self.rows = {}

    def read(self, key):
        return copy.deepcopy(self.rows.get(key))

    def history(self):
        return copy.deepcopy(list(self.rows.values()))

    def write(self, key, row):
        self.rows[key] = copy.deepcopy(row)


class FakeBackend:
    def __init__(self):
        self.present = True
        self.calls = []
        self.offline = False
        self.cloud_failure = False
        self.protected = set()

    def ensure_policy(self):
        return None

    def resources(self):
        return {'available_memory_bytes': 3 * 1024**3, 'load1': 1}

    def staging_available(self):
        return not self.offline

    def inventory(self):
        return ([{'image_id': IMAGE, 'created_at': 0, 'tags': [], 'rollback_in_use': False}], self.protected)

    def export(self, row, limit):
        self.calls.append('export')
        return {'state': 'pc_archive_hash_verified', 'image_id': 'a' * 64, 'bytes': 123, 'sha256': 'b' * 64}

    def verify_archive(self, row):
        return {'state': 'docker_archive_manifest_and_blobs_verified', 'image_id': 'a' * 64}

    def upload_and_verify(self, row):
        self.calls.append('upload')
        if self.cloud_failure:
            raise TimeoutError()
        return {'state': 'cloud_roundtrip_sha256_verified', 'image_id': 'a' * 64, 'bytes': 123, 'sha256': 'b' * 64}

    def still_retirable(self, row):
        return IMAGE not in self.protected

    def retire(self, image):
        self.calls.append('retire')
        self.present = False

    def image_present(self, image):
        return self.present


class Tests(unittest.TestCase):
    def test_success_retires_after_export_and_cloud(self):
        backend = FakeBackend()
        result = run_cycle(backend, MemoryLedger(), now=100000)
        self.assertEqual(result['retired'], 1)
        self.assertEqual(backend.calls, ['export', 'upload', 'retire'])

    def test_pc_offline_has_no_export(self):
        backend = FakeBackend()
        backend.offline = True
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['state'], 'deferred')
        self.assertEqual(backend.calls, [])

    def test_uncertain_cloud_never_replays(self):
        backend = FakeBackend()
        backend.cloud_failure = True
        ledger = MemoryLedger()
        run_cycle(backend, ledger, now=100000)
        run_cycle(backend, ledger, now=100001)
        self.assertEqual(backend.calls, ['export', 'upload'])
        self.assertTrue(backend.present)

    def test_existing_intent_is_observed_only(self):
        backend = FakeBackend()
        ledger = MemoryLedger()
        ledger.write(operation_id(IMAGE), {'state': 'retire_intent'})
        self.assertEqual(run_cycle(backend, ledger, now=100000)['retired'], 0)
        self.assertEqual(backend.calls, [])

    def test_protected_image_is_preserved(self):
        backend = FakeBackend()
        backend.protected.add(IMAGE)
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['retired'], 0)

    def test_resource_pressure_defers(self):
        backend = FakeBackend()
        backend.resources = lambda: {'available_memory_bytes': 1, 'load1': 5}
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['state'], 'deferred')
        self.assertEqual(backend.calls, [])

    def test_quota_excess_preserves_original(self):
        backend = FakeBackend()
        export = backend.export
        backend.export = lambda row, limit: {**export(row, limit), 'bytes': 3 * 1024**3}
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['retired'], 0)
        self.assertTrue(backend.present)
        self.assertNotIn('upload', backend.calls)

    def test_cloud_hash_mismatch_preserves_original(self):
        backend = FakeBackend()
        upload = backend.upload_and_verify
        backend.upload_and_verify = lambda row: {**upload(row), 'sha256': 'c' * 64}
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['retired'], 0)
        self.assertTrue(backend.present)

    def test_current_reference_added_after_upload_prevents_retirement(self):
        backend = FakeBackend()
        backend.still_retirable = lambda row: False
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['retired'], 0)
        self.assertTrue(backend.present)

    def test_tagged_image_preserved(self):
        backend = FakeBackend()
        backend.inventory = lambda: ([{'image_id': IMAGE, 'created_at': 0, 'tags': ['base:stable'], 'rollback_in_use': False}], set())
        self.assertEqual(run_cycle(backend, MemoryLedger(), now=100000)['retired'], 0)
        self.assertEqual(backend.calls, [])

    def test_nonfinite_created_at_preserved(self):
        for stamp in (float('nan'), float('inf'), -1):
            rows = [{'image_id': IMAGE, 'created_at': stamp, 'tags': [], 'rollback_in_use': False}]
            self.assertEqual(select_images(rows, set(), 100000), [])

    def test_two_previous_exports_block_rolling_day(self):
        ledger = MemoryLedger()
        for i in range(2):
            ledger.write(str(i) * 64, {'state': 'retired', 'started_at': 99999, 'archive': {'bytes': 100}})
        backend = FakeBackend()
        self.assertEqual(run_cycle(backend, ledger, now=100000)['reason'], 'rolling_24h_quota')
        self.assertEqual(backend.calls, [])

    def test_previous_bytes_reduce_export_budget(self):
        ledger = MemoryLedger()
        ledger.write('c' * 64, {'state': 'retired', 'started_at': 99999, 'archive': {'bytes': 2 * 1024**3 - 100}})
        backend = FakeBackend()
        self.assertEqual(run_cycle(backend, ledger, now=100000)['retired'], 0)
        self.assertTrue(backend.present)

    def test_uncertain_other_image_blocks_all_new_effects(self):
        ledger = MemoryLedger()
        ledger.write('d' * 64, {'state': 'uncertain'})
        backend = FakeBackend()
        self.assertEqual(run_cycle(backend, ledger, now=100000)['reason'], 'global_unresolved_receipt')
        self.assertEqual(backend.calls, [])

    def test_revocation_during_export_prevents_upload(self):
        backend = FakeBackend()
        checks = []
        def check():
            checks.append(True)
            if len(checks) >= 4:
                raise ValueError('revoked')
        backend.ensure_policy = check
        run_cycle(backend, MemoryLedger(), now=100000)
        self.assertEqual(backend.calls, ['export'])
        self.assertTrue(backend.present)

    def test_revocation_after_upload_prevents_retirement(self):
        backend = FakeBackend()
        checks = []
        def check():
            checks.append(True)
            if len(checks) >= 5:
                raise ValueError('revoked')
        backend.ensure_policy = check
        run_cycle(backend, MemoryLedger(), now=100000)
        self.assertEqual(backend.calls, ['export', 'upload'])
        self.assertTrue(backend.present)


if __name__ == '__main__':
    unittest.main()
