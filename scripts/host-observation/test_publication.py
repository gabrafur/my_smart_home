"""Local temporary files only; never run the native producer or become Root."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observer_publication', Path(__file__).with_name('observer.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.real_fstat = os.fstat
        self.real_rename = os.rename
        # Exercise real opens, writes, permissions and rename without Root.
        # Only the fixture's owner assertion is substituted, never the checks
        # on file type or link count, and no production path is opened.
        def fixture_owner(fd):
            info = list(self.real_fstat(fd)); info[4] = 0
            return os.stat_result(info)
        self.owner = patch.object(observer.os, 'fstat', side_effect=fixture_owner)
        self.owner.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(os.close, self.directory)
        self.addCleanup(self.owner.stop)

    def test_full_new_report_visible_only_at_atomic_rename(self):
        original = {'sequence': 1}; updated = {'sequence': 2, 'payload': 'x' * 32000}
        (self.root / 'report.json').write_text(json.dumps(original))
        def inspect_before_swap(source, target, **kwargs):
            self.assertEqual(json.loads((self.root / 'report.json').read_text()), original)
            self.assertEqual(json.loads((self.root / 'report.json.tmp').read_text()), updated)
            self.real_rename(source, target, **kwargs)
        with patch.object(observer.os, 'rename', side_effect=inspect_before_swap), \
             patch.object(observer.os, 'fsync', side_effect=AssertionError('volatile cache must not require durable synchronization')):
            written = observer.atomic_report(self.directory, updated)
        self.assertEqual(json.loads((self.root / 'report.json').read_text()), updated)
        self.assertEqual(written, (self.root / 'report.json').stat().st_size)
        self.assertEqual(stat.S_IMODE((self.root / 'report.json').stat().st_mode), 0o644)
        self.assertFalse((self.root / 'report.json.tmp').exists())

    def test_stale_long_temporary_file_is_replaced_without_suffix(self):
        (self.root / 'report.json.tmp').write_text('stale' * 10000)
        observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual(json.loads((self.root / 'report.json').read_text()), {'sequence': 2})

    def test_rename_failure_preserves_previous_report(self):
        original = b'{"sequence":1}\n'
        (self.root / 'report.json').write_bytes(original)
        with patch.object(observer.os, 'rename', side_effect=OSError('fixture rename refused')):
            with self.assertRaises(OSError): observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual((self.root / 'report.json').read_bytes(), original)
        self.assertEqual(json.loads((self.root / 'report.json.tmp').read_text()), {'sequence': 2})

    def test_failed_buffer_write_never_publishes_partial_json(self):
        original = b'{"sequence":1}\n'
        (self.root / 'report.json').write_bytes(original)
        real_fdopen = os.fdopen
        class FailingWriter:
            def __init__(self, fd, mode): self.stream = real_fdopen(fd, mode)
            def __enter__(self): return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def write(self, _): raise OSError('fixture write refused')
            def flush(self): self.stream.flush()
        with patch.object(observer.os, 'fdopen', side_effect=FailingWriter):
            with self.assertRaises(OSError): observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual((self.root / 'report.json').read_bytes(), original)

    def test_temporary_symlink_is_not_followed(self):
        target = self.root / 'other-fixture'; target.write_bytes(b'unchanged')
        (self.root / 'report.json.tmp').symlink_to(target.name)
        with self.assertRaises(OSError): observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual(target.read_bytes(), b'unchanged')

    def test_temporary_hardlink_is_refused_before_truncation(self):
        target = self.root / 'other-fixture'; target.write_bytes(b'unchanged')
        os.link(target, self.root / 'report.json.tmp')
        with self.assertRaisesRegex(ValueError, '^unsafe_report$'):
            observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual(target.read_bytes(), b'unchanged')

    def test_wrong_owner_is_refused_without_modifying_temporary_file(self):
        target = self.root / 'report.json.tmp'; target.write_bytes(b'unchanged')
        def wrong_owner(fd):
            info = list(self.real_fstat(fd)); info[4] = 65534
            return os.stat_result(info)
        with patch.object(observer.os, 'fstat', side_effect=wrong_owner):
            with self.assertRaisesRegex(ValueError, '^unsafe_report$'):
                observer.atomic_report(self.directory, {'sequence': 2})
        self.assertEqual(target.read_bytes(), b'unchanged')

    def test_oversized_or_nonfinite_report_does_not_touch_existing_cache(self):
        original = b'{"sequence":1}\n'; (self.root / 'report.json').write_bytes(original)
        for value in [{'payload': 'x' * 65536}, {'latency': float('nan')}]:
            with self.subTest(value_type=list(value)), self.assertRaises(ValueError):
                observer.atomic_report(self.directory, value)
        self.assertEqual((self.root / 'report.json').read_bytes(), original)
        self.assertFalse((self.root / 'report.json.tmp').exists())


if __name__ == '__main__': unittest.main()
