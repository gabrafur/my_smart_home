"""Synthetic tests; they use the exported public source and no live policy."""
import hashlib
import json
import types
import unittest
from pathlib import Path

import derive

EXPORT = Path(__file__).resolve().parent.parent / 'runtime-source/task-control/task_list.py'
NOW = 1767225600.0


def load(body):
    module = types.ModuleType('patched_task_list')
    exec(compile(body, 'task_list.py', 'exec'), module.__dict__)
    return module


def row(thread, error=None):
    return {'thread_id': thread, 'last_activity_at': '2026-01-01T00:00:00+00:00', 'created_at': None,
            'adapter_execution_proven': False, 'last_executed_at': None, 'last_execution_observed_at': None,
            'creation_operation_id': None, 'last_executed_operation_id': None, 'last_executed_outcome': None,
            'collection_error': error}


ARGS = {'host': 'raspberry', 'page_size': 16, 'cursor': None}


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.before = EXPORT.read_bytes()
        self.module = load(derive.patch_task_list(self.before))

    def page(self, rows, errors=(), truncated=False):
        return self.module.page(rows, ARGS, 'r' * 64, list(errors), truncated, NOW)

    def test_row_gap_no_longer_poisons_the_listing(self):
        before = load(self.before).page([row('a'), row('b', 'thread_not_loaded_metadata_unavailable')], ARGS, 'r' * 64, [], False, NOW)
        self.assertEqual(before['collection_error'], 'partial_collection_failure')
        self.assertEqual(before['collection_errors'], [])
        after = self.page([row('a'), row('b', 'thread_not_loaded_metadata_unavailable')])
        self.assertIsNone(after['collection_error'])
        self.assertEqual(after['row_collection_errors'], {
            'count': 1, 'reasons': {'thread_not_loaded_metadata_unavailable': 1}, 'thread_ids': ['b'],
            'registered_identities_listed': True,
            'semantics': 'row_daemon_metadata_unavailable_identity_and_adapter_records_still_listed'})
        errors = {r['thread_id']: r['collection_error'] for r in after['threads']}
        self.assertEqual(errors, {'a': None, 'b': 'thread_not_loaded_metadata_unavailable'})

    def test_collector_failure_is_still_a_global_error(self):
        after = self.page([row('a', 'daemon_metadata_unconfirmed')], errors=['daemon_metadata_collection_failed'])
        self.assertEqual(after['collection_error'], 'partial_collection_failure')
        self.assertEqual(after['collection_errors'], ['daemon_metadata_collection_failed'])
        self.assertEqual(after['row_collection_errors']['count'], 1)

    def test_clean_listing_and_bounded_ids(self):
        clean = self.page([row('a')])
        self.assertIsNone(clean['collection_error'])
        self.assertEqual(clean['row_collection_errors']['count'], 0)
        many = self.page([row('t%02d' % i, 'daemon_metadata_unconfirmed') for i in range(12)], truncated=True)
        self.assertEqual(many['row_collection_errors']['count'], 12)
        self.assertEqual(len(many['row_collection_errors']['thread_ids']), 8)
        self.assertFalse(many['row_collection_errors']['registered_identities_listed'])

    def test_patch_refuses_changed_or_already_patched_source(self):
        with self.assertRaises(ValueError):
            derive.patch_task_list(self.before.replace(b'partial_collection_failure', b'other'))
        with self.assertRaises(ValueError):
            derive.patch_task_list(derive.patch_task_list(self.before))


class DeriveTests(unittest.TestCase):
    def setUp(self):
        self.task_list = EXPORT.read_bytes()
        self.policy = derive.canonical({
            'schema': 'raspberry-task-policy-v2', 'enabled': True, 'profile': 'restricted',
            'admin_delegation': {'enabled': False}, 'owner_approval_sha256': 'a' * 64, 'max_sends_per_24h': 48,
            'source_hashes': {'task_list.py': derive.sha(self.task_list), 'task_store.py': 'b' * 64},
            'dependencies': {'/x': 'c' * 64}})
        self.enrollment = derive.canonical({
            'schema': 'raspberry-task-peer-attestor-v2', 'enabled': True, 'policy_sha256': derive.sha(self.policy),
            'owner_confirmation_sha256': 'a' * 64, 'daemon_cgroup': 'fixture', 'engine_sha256': 'd' * 64})
        self.expected = {'task_list': derive.sha(self.task_list), 'policy': derive.sha(self.policy),
                         'enrollment': derive.sha(self.enrollment)}

    def test_only_the_three_bindings_change(self):
        task_list, policy, enrollment = derive.derive(self.task_list, self.policy, self.enrollment, self.expected)
        p, e = json.loads(policy), json.loads(enrollment)
        self.assertEqual(p['source_hashes']['task_list.py'], hashlib.sha256(task_list).hexdigest())
        self.assertEqual(p['source_hashes']['task_store.py'], 'b' * 64)
        self.assertEqual(p['max_sends_per_24h'], 48)
        self.assertEqual(e['policy_sha256'], hashlib.sha256(policy).hexdigest())
        self.assertEqual(e['daemon_cgroup'], 'fixture')
        self.assertEqual(e['engine_sha256'], 'd' * 64)

    def test_stale_baselines_and_changed_scope_are_refused(self):
        with self.assertRaises(ValueError):
            derive.derive(self.task_list, self.policy, self.enrollment, {**self.expected, 'policy': 'e' * 64})
        widened = derive.canonical({**json.loads(self.policy), 'admin_delegation': {'enabled': True}})
        enrollment = derive.canonical({**json.loads(self.enrollment), 'policy_sha256': derive.sha(widened)})
        with self.assertRaises(ValueError):
            derive.derive(self.task_list, widened, enrollment,
                          {**self.expected, 'policy': derive.sha(widened), 'enrollment': derive.sha(enrollment)})
        unbound = derive.canonical({**json.loads(self.enrollment), 'policy_sha256': 'f' * 64})
        with self.assertRaises(ValueError):
            derive.derive(self.task_list, self.policy, unbound, {**self.expected, 'enrollment': derive.sha(unbound)})


if __name__ == '__main__':
    unittest.main()
