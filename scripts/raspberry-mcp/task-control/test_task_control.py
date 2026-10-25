import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import os
import sqlite3

from task_store import Store, fingerprint
from thread_catalog import catalog
import task_control


THREAD = '00000000-0000-0000-0000-000000000001'
TASK = 'a' * 32
SEND = 'b' * 32


def entry(i, origin='adapter'):
    return {'thread_id': f'00000000-0000-0000-0000-{i:012d}',
            'origin': origin, 'task_id': str(i) * 32, 'operation_id': None,
            'operation_state': 'not_sent', 'created_at': i}


def metadata(q):
    i = int(q['thread_id'][-12:])
    return {'thread_id': q['thread_id'], 'state': 'notLoaded' if i == 1 else 'idle',
            'can_accept_input': i != 1, 'source': 'vscode', 'created_at': i,
            'last_activity': 10 - i, 'last_execution':
            {'turn_id': THREAD, 'state': 'completed', 'started_at': 20} if i == 1 else None,
            'collection_error': None, 'prompt': 'PRIVATE', 'name': 'PRIVATE'}


class CatalogTests(unittest.TestCase):
    def test_pagination_order_legacy_new_notloaded_and_last_executed(self):
        entries = [entry(3), entry(1, 'legacy_authorized'), entry(2)]
        calls = []
        def invoke(q):
            self.assertEqual(q['mode'], 'metadata')
            calls.append(q)
            return metadata(q)
        first = catalog(entries, invoke, 1, None, lambda: 100)
        second = catalog(entries, invoke, 1, first['next_cursor'])
        third = catalog(entries, invoke, 1, second['next_cursor'])
        self.assertEqual([p['data'][0]['thread_id'] for p in (first, second, third)],
                         [entry(i)['thread_id'] for i in (1, 2, 3)])
        self.assertIsNone(third['next_cursor'])
        self.assertEqual(first['latest_created_thread_id'], entry(3)['thread_id'])
        self.assertEqual(first['latest_executed_thread_id'], entry(1)['thread_id'])
        self.assertEqual(first['data'][0]['state'], 'notLoaded')
        self.assertEqual(first['observed_at'], 100)
        self.assertIsNone(first['data'][0]['open_link'])
        self.assertIsNone(first['data'][0]['safe_title'])
        self.assertNotIn('PRIVATE', json.dumps(first))
        self.assertIn('partial', first['coverage'])

    def test_failure_keeps_thread_and_unknown_state(self):
        def fail(q):
            raise RuntimeError('PRIVATE')
        result = catalog([entry(1)], fail, 50, None)
        self.assertEqual(result['collection_error'], 'partial_collection')
        self.assertEqual(result['data'][0]['state'], 'unknown')
        self.assertIsNone(result['latest_executed_thread_id'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_cursor_invalid_and_scope_change_rejected_before_rpc(self):
        first = catalog([entry(1), entry(2)], metadata, 1, None)
        for entries, cursor, limit in [([entry(1)], first['next_cursor'], 1),
                ([entry(1)], 'invalid', 1), ([entry(1)], None, True),
                ([entry(1)], None, 0), ([entry(1)], None, 51)]:
            with self.assertRaises(ValueError):
                catalog(entries, lambda q: self.fail('RPC before validation'), limit, cursor)

    def test_equal_activity_has_stable_id_order_and_empty(self):
        def same(q):
            return {**metadata(q), 'last_activity': 9}
        result = catalog([entry(2), entry(1)], same, 50, None)
        self.assertEqual(result['data'][0]['thread_id'], entry(1)['thread_id'])
        self.assertEqual(catalog([], same, 1, None)['data'], [])


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'jobs.db', clock=lambda: 100)
        self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,0)',
            (TASK, 'safe-task', 'hash', THREAD, 'create_unknown', 1, 1))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_confirm_creation_profile_block_without_sending(self):
        result = self.store.observe_creation(TASK, lambda q: {
            'state': 'durable_blocked', 'thread_id': THREAD, 'reason': 'profile_mismatch'})
        self.assertEqual(result['state'], 'created')
        receipt = json.loads(result['result'])
        self.assertTrue(receipt['creation_confirmed'])
        self.assertEqual(receipt['send_state'], 'not_sent')
        self.assertEqual(receipt['send_rows'], 0)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sends').fetchone()[0], 0)
        with self.assertRaisesRegex(ValueError, 'creation_result_unconfirmed'):
            self.store.reconcile_creation(TASK, fingerprint(receipt), lambda q: self.fail('RPC'))

    def test_no_send_intent_when_creation_profile_blocked(self):
        self.store.db.execute("UPDATE tasks SET state='created'")
        calls = []
        def invoke(q):
            calls.append(q['mode'])
            return {'state': 'durable_blocked', 'thread_id': THREAD, 'reason': 'profile_mismatch'}
        with self.assertRaisesRegex(ValueError, 'task_creation_not_ready'):
            self.store.send({'operation_id': SEND, 'task_id': TASK, 'text': 'safe'},
                            invoke, lambda *a: None, lambda: None)
        self.assertEqual(calls, ['creation_probe'])
        self.assertIsNone(self.store.row('sends', SEND))

    def test_uncertain_send_is_never_replayed_after_reopen(self):
        self.store.db.execute("UPDATE tasks SET state='created'")
        calls = []
        def invoke(q):
            calls.append(q['mode'])
            if q['mode'] == 'creation_probe':
                return {'state': 'durable_ready', 'thread_id': THREAD}
            if q['mode'] == 'send':
                raise TimeoutError()
            return {}
        q = {'operation_id': SEND, 'task_id': TASK, 'text': 'safe'}
        result = self.store.send(q, invoke, lambda *a: None, lambda: None)
        self.assertEqual(result['state'], 'send_unknown')
        self.store.close()
        self.store = Store(Path(self.tmp.name) / 'jobs.db')
        duplicate = self.store.send(q, lambda q: self.fail('replayed'),
                                    lambda *a: self.fail('admission'), lambda: self.fail('idle'))
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(duplicate['id'], SEND)
        self.assertEqual(calls.count('send'), 1)

    def test_uncertain_creation_observation_retains_identity(self):
        result = self.store.observe_creation(TASK, lambda q: {
            'state': 'unconfirmed', 'thread_id': THREAD})
        self.assertEqual(result['thread'], THREAD)
        self.assertEqual(result['state'], 'create_unknown')
        self.assertFalse(json.loads(result['result'])['creation_confirmed'])

    def test_observation_failure_never_marks_terminal(self):
        self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
            (SEND, TASK, 'hash', 'accepted', THREAD, 1, 1, None))
        def fail(q):
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            self.store.observe(SEND, fail)
        self.assertEqual(self.store.row('sends', SEND)['state'], 'accepted')

    def test_creation_with_send_never_reports_stale_zero_sends(self):
        self.store.db.execute("UPDATE tasks SET state='created'")
        self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
            (SEND, TASK, 'hash', 'accepted', THREAD, 1, 1, None))
        for state in ('inProgress', 'completed'):
            result = self.store.observe_creation(TASK, lambda q: {
                'operation_state': state, 'turn_id': THREAD})
            receipt = json.loads(result['result'])
            self.assertEqual(receipt['send_rows'], 1)
            self.assertEqual(receipt['send_operation_id'], SEND)
            self.assertEqual(receipt['execution_state'], state)

    def test_absent_send_receipt_is_explicit(self):
        result = self.store.observe(SEND, lambda q: self.fail('unexpected RPC'))
        self.assertEqual(result['id'], SEND)
        self.assertEqual(result['state'], 'not_recorded')
        self.assertEqual(result['send_state'], 'not_sent_by_adapter')


class ReadOnlyRegistryTests(unittest.TestCase):
    def test_listing_preserves_database_bytes_and_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            task_db = root / 'jobs.sqlite3'
            store = Store(task_db)
            store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,0)',
                (TASK, 'safe-task', 'hash', THREAD, 'created', 1, 1))
            store.close()
            legacy_db = root / 'legacy.sqlite3'
            with sqlite3.connect(legacy_db) as db:
                db.execute('CREATE TABLE jobs(id,thread,state,turn,created)')
            for path in (task_db, legacy_db):
                path.chmod(0o600)
            before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in (task_db, legacy_db)]
            with patch.object(task_control, 'STATE', root), \
                 patch.object(task_control, 'LEGACY_DB', legacy_db), \
                 patch.object(task_control, 'UID', os.getuid()), \
                 patch.object(task_control, 'rpc', side_effect=lambda q, *a: metadata(q)):
                result = task_control.list_threads({'limit': 50, 'cursor': None}, {},
                    {'threads': []}, None)
            self.assertEqual(result['data'][0]['thread_id'], THREAD)
            after = [(p.read_bytes(), p.stat().st_mtime_ns) for p in (task_db, legacy_db)]
            self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
