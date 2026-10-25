"""Exercise the release installer only against temporary synthetic files."""
import contextlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import install as installer


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.source, self.root, self.front = (base / p for p in ('source', 'root', 'front'))
        for directory in (self.source, self.root, self.front):
            directory.mkdir()
        self.policy = self.root / 'policy.json'
        self.patches = patch.multiple(installer, SOURCE=self.source, ROOT=self.root,
            FRONT=self.front, POLICY=self.policy, BACKUPS=base / 'backups')
        self.patches.start()
        self.addCleanup(self.patches.stop)
        for name in (*installer.BACKEND, *installer.FRONTEND):
            (self.source / name).write_text('synthetic new ' + name)
        for name in installer.BACKEND[:-1]:
            (self.root / name).write_text('synthetic old ' + name)
        (self.front / 'task-server.mjs').write_text('synthetic old frontend')
        self.original_policy = {
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'expires_at': time.time() + 3600, 'enabled': True,
            'max_sends_per_24h': 48, 'minimum_spacing_seconds': 60,
            'maximum_database_bytes': 1048576,
            'source_hashes': {n: installer.digest(self.root / n) for n in installer.BACKEND[:-1]},
            'dependencies': {},
        }
        self.policy.write_text(json.dumps(self.original_policy))
        self.manifest = {'files': {n: installer.digest(self.source / n)
            for n in (*installer.BACKEND, *installer.FRONTEND)},
            'base_policy_sha256': installer.digest(self.policy),
            'base_front_sha256': installer.digest(self.front / 'task-server.mjs')}
        self.write_manifest()
        self.files = [self.root / n for n in installer.BACKEND]
        self.files += [self.front / n for n in installer.FRONTEND]
        self.files += [self.policy]

    def write_manifest(self):
        (self.source / 'release.json').write_text(json.dumps(self.manifest))

    def snapshot(self):
        return {p: p.read_bytes() if p.exists() else None for p in self.files}

    @contextlib.contextmanager
    def synthetic_root(self):
        # No ownership or privilege changes occur. Only the fixture's stat
        # results and the installer's identity check are mocked.
        original_stat = Path.stat
        targets = set(self.files)
        def fixture_stat(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path in targets:
                values = list(info)
                values[4] = 0
                return os.stat_result(values)
            return info
        with patch.object(installer.os, 'geteuid', return_value=0), \
             patch.object(Path, 'stat', fixture_stat):
            yield

    def test_preflight_is_read_only(self):
        before = self.snapshot()
        self.assertEqual(installer.check(), self.original_policy)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(installer.BACKUPS.exists())

    def test_changed_source_is_rejected_without_writes(self):
        (self.source / installer.BACKEND[0]).write_text('changed synthetic source')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'release_source_changed'):
            installer.check()
        self.assertEqual(self.snapshot(), before)

    def test_expired_lease_is_rejected_without_extension(self):
        p = {**self.original_policy, 'expires_at': 0}
        self.policy.write_text(json.dumps(p))
        self.manifest['base_policy_sha256'] = installer.digest(self.policy)
        self.write_manifest()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'existing_lease_expired_no_extension'):
            installer.check()
        self.assertEqual(self.snapshot(), before)

    def test_application_preserves_authorization_and_does_not_run_payload(self):
        with self.synthetic_root(), patch.object(installer, 'restart') as restart:
            result = installer.apply()
        restart.assert_called_once_with()
        self.assertTrue(result['installed'])
        updated = json.loads(self.policy.read_text())
        for key, value in self.original_policy.items():
            if key not in ('source_hashes', 'dependencies'):
                self.assertEqual(updated[key], value)
        for path in self.files[:-1]:
            self.assertEqual(path.read_bytes(), (self.source / path.name).read_bytes())

    def test_failed_restart_restores_existing_files_and_removes_new_files(self):
        before = self.snapshot()
        with self.synthetic_root(), patch.object(installer, 'restart',
                side_effect=[RuntimeError('synthetic restart failure'), None]) as restart:
            with self.assertRaisesRegex(RuntimeError, 'synthetic restart failure'):
                installer.apply()
        self.assertEqual(restart.call_count, 2)
        self.assertEqual(self.snapshot(), before)

    def test_failure_after_atomic_replacement_restores_that_file(self):
        before = self.snapshot()
        original_atomic = installer.atomic
        calls = 0
        def fail_after_replace(path, data):
            nonlocal calls
            calls += 1
            original_atomic(path, data)
            if calls == 2:
                raise OSError('synthetic failure after replacement')
        with self.synthetic_root(), patch.object(installer, 'atomic', fail_after_replace), \
             patch.object(installer, 'restart'):
            with self.assertRaisesRegex(OSError, 'synthetic failure after replacement'):
                installer.apply()
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
