import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import rollback_cloud_daily as daily


class FakeReadBackend:
    def __init__(self, check):
        self.ensure_policy = check

    def resources(self):
        return {'available_memory_bytes': 3 * 1024**3, 'load1': 0}

    def inventory(self):
        return ([{'image_id': 'sha256:'+'a'*64, 'created_at': 0, 'tags': [], 'rollback_in_use': False}], set())

    def __getattr__(self, key):
        raise AssertionError('dry-run attempted effect or PC probe '+key)


class Tests(unittest.TestCase):
    def test_dry_run_uses_validated_policy_without_caller_or_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(daily, 'ROOT', root):
                result = daily.main(['--dry-run'], FakeReadBackend, lambda: ({'enabled': True}, 'digest'))
            self.assertEqual(result['state'], 'dry_run')
            self.assertEqual(result['exports'], 0)
            self.assertEqual(result['uploads'], 0)
            self.assertEqual(result['retired'], 0)
            self.assertEqual(result['candidate_count'], 1)
            self.assertEqual(list(root.iterdir()), [])

    def test_invalid_cli_rejected_before_policy_or_backend(self):
        def forbidden():
            self.fail('invalid arguments must not read policy')
        with self.assertRaisesRegex(ValueError, 'optional_dry_run'):
            daily.main(['--apply'], FakeReadBackend, forbidden)

    def test_revocation_during_snapshot_blocks_dry_run_result(self):
        calls = []
        def policy():
            calls.append(True)
            return {'enabled': True}, 'before' if len(calls) < 3 else 'revoked'
        with self.assertRaisesRegex(ValueError, 'revoked'):
            daily.main(['--dry-run'], FakeReadBackend, policy)


if __name__ == '__main__':
    unittest.main()
