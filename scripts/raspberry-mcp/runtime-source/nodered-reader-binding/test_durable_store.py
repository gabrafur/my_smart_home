"""Real disposable filesystem/locks only, no privileged or household calls."""
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('binding_store', HERE / 'durable_store.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def competing(state, common, identity, pipe):
    try:
        with m.Store(state, common, identity, owner=os.getuid()).lock():
            pipe.send('unexpected_acquisition')
    except BlockingIOError:
        pipe.send('blocked_by_kernel_flock')
    finally:
        pipe.close()


class DurableStore(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / 'state'
        self.state.mkdir(mode=0o700)
        self.common = self.base / 'common.lock'
        self.common.write_bytes(b'fixed test lock')
        self.common.chmod(0o600)
        s = self.common.stat()
        self.identity = (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode & 0o777)
        self.store = self.new()

    def new(self):
        return m.Store(self.state, self.common, self.identity, owner=os.getuid())

    def row(self, identifier='a' * 32):
        return {'id': identifier, 'state': 'apply_intent',
                'effects': [{'kind': 'apply', 'at': 100000}],
                'observed_at_unix': 100000}

    def ledger(self, raw):
        p = self.state / 'ledger.json'
        p.write_bytes(raw)
        p.chmod(0o600)
        return p

    def test_new_store_does_not_create_directories_or_reset_ledger(self):
        self.assertFalse((self.state / 'ledger.json').exists())
        with self.store.lock():
            self.assertEqual(self.store.history(), [])
            self.store.save(self.row())
        raw = (self.state / 'ledger.json').read_bytes()
        self.new()
        self.assertEqual((self.state / 'ledger.json').read_bytes(), raw)

    def test_intent_is_persisted_and_seen_by_new_instance(self):
        with self.store.lock():
            self.store.save(self.row())
        with self.new().lock() as reopened:
            self.assertEqual(reopened.get('a' * 32), self.row())
        self.assertEqual((self.state / 'ledger.json').stat().st_mode & 0o777, 0o600)

    def test_read_copy_cannot_mutate_receipt_without_save(self):
        with self.store.lock():
            self.store.save(self.row())
            copied = self.store.history()
            copied[0]['effects'].clear()
            self.assertEqual(len(self.store.get('a' * 32)['effects']), 1)

    def test_atomic_replacement_updates_one_id_retains_other_and_budget(self):
        with self.store.lock():
            self.store.save(self.row())
            self.store.save(self.row('b' * 32))
            row = self.store.get('a' * 32)
            row['state'] = 'applied'
            self.store.save(row)
            self.assertEqual(len(self.store.history()), 2)
            self.assertEqual(sum(len(v['effects']) for v in self.store.history()), 2)
        self.assertEqual(sorted(p.name for p in self.state.iterdir()),
                         ['ledger.json', 'operation.lock'])

    def test_competing_process_is_blocked_and_cannot_write(self):
        parent, child = multiprocessing.Pipe(duplex=False)
        with self.store.lock():
            process = multiprocessing.get_context('fork').Process(
                target=competing, args=(self.state, self.common, self.identity, child))
            process.start()
            child.close()
            self.assertTrue(parent.poll(3), 'child failed to report kernel lock result')
            self.assertEqual(parent.recv(), 'blocked_by_kernel_flock')
            process.join(3)
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
            self.assertFalse((self.state / 'ledger.json').exists())
        parent.close()
        with self.new().lock():
            pass

    def test_symlink_ledger_is_not_followed(self):
        other = self.base / 'protected'
        other.write_bytes(b'protected contents')
        (self.state / 'ledger.json').symlink_to(other)
        with self.assertRaises(OSError), self.store.lock():
            pass
        self.assertEqual(other.read_bytes(), b'protected contents')

    def test_hardlink_ledger_refused(self):
        original = self.ledger(b'{}')
        os.link(original, self.base / 'other')
        with self.assertRaisesRegex(m.Refused, 'identity'), self.store.lock():
            pass

    def test_wrong_mode_and_symlink_directory_refused(self):
        self.state.chmod(0o755)
        with self.assertRaisesRegex(m.Refused, 'directory'), self.store.lock():
            pass
        self.state.chmod(0o700)
        link = self.base / 'link'
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(OSError), m.Store(link, self.common, self.identity,
                                               owner=os.getuid()).lock():
            pass

    def test_changed_common_lock_identity_is_not_adopted(self):
        self.common.rename(self.base / 'old-common')
        self.common.write_bytes(b'new lock')
        self.common.chmod(0o600)
        with self.assertRaisesRegex(m.Refused, 'maintenance_lock_identity'), self.store.lock():
            pass

    def test_foreign_ledger_update_preserved_no_overwrite(self):
        with self.store.lock():
            self.store.save(self.row())
            foreign = json.dumps({'schema_version': 1, 'operations': [self.row('c' * 32)]}).encode()
            p = self.ledger(foreign)
            with self.assertRaisesRegex(m.Refused, 'foreign_receipt'):
                self.store.save(self.row('b' * 32))
            self.assertEqual(p.read_bytes(), foreign)

    def test_revocation_closes_admission_even_when_object_is_symlink(self):
        with self.store.lock():
            self.assertFalse(self.store.revoked())
            (self.state / 'revoked').symlink_to(self.base / 'missing')
            self.assertTrue(self.store.revoked())

    def test_duplicate_ids_json_keys_and_nonfinite_values_refused(self):
        invalid = [b'{"schema_version":1,"schema_version":1,"operations":[]}',
                   b'{"schema_version":1,"operations":[],"x":NaN}',
                   json.dumps({'schema_version': 1, 'operations': [self.row(), self.row()]}).encode()]
        for raw in invalid:
            self.ledger(raw)
            with self.subTest(raw=raw), self.assertRaises((m.Refused, ValueError)), self.store.lock():
                pass

    def test_record_limit_and_size_limit_preserve_existing_receipts(self):
        with self.store.lock():
            for i in range(64):
                self.store.save(self.row(format(i, '032x')))
            previous = (self.state / 'ledger.json').read_bytes()
            with self.assertRaisesRegex(m.Refused, 'schema'):
                self.store.save(self.row('f' * 32))
            self.assertEqual((self.state / 'ledger.json').read_bytes(), previous)
            row = self.row('0' * 32)
            row['extra'] = 'x' * m.LIMIT
            with self.assertRaisesRegex(m.Refused, 'size_limit'):
                self.store.save(row)
            self.assertEqual((self.state / 'ledger.json').read_bytes(), previous)

    def test_replaced_state_directory_or_operation_lock_refused_while_held(self):
        with self.store.lock():
            lock = self.state / 'operation.lock'
            lock.rename(self.state / 'old.lock')
            lock.write_bytes(b'replacement')
            lock.chmod(0o600)
            with self.assertRaisesRegex(m.Refused, 'operation_lock_identity'):
                self.store.save(self.row())

    def test_methods_outside_lock_fail_closed(self):
        for function in (self.store.history, self.store.revoked,
                         lambda: self.store.save(self.row())):
            with self.assertRaisesRegex(m.Refused, 'locks_required'):
                function()


if __name__ == '__main__':
    unittest.main()
