import hashlib
import json
import unittest

import derive as d

LEGACY = b"            'repair_receipts': 'id task result_hash result ack'},\n"
GUARD = (b"SCHEMAS = {\n"
         b" 'task': {'tasks': 'id task_key spec_hash thread state created updated reconciled',\n"
         b"          'audit': 'seq id state at', 'creation_results': 'id result',\n"
         b"          'result_checkpoints': 'id result_hash terminal_state reply_available recorded'},\n"
         b" 'legacy': {'jobs': 'id thread intent state created updated attempts turn result',\n"
         b"            'repair_receipts': 'id task result_hash result ack'},\n}\n")
NEW = {'history_refs': 'kind id version',
       'profile_transitions': 'id operation thread grant_sha256 mode state receipt created updated'}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fixture(guard=GUARD):
    policy = json.dumps({'sources': {'native_guard.py': sha(guard), 'engine.py': 'e' * 64},
                         'native_guard_producer': {'source_sha256': sha(guard)}, 'grants': ['x']},
                        indent=2).encode()
    unit = b'[Service]\nEnvironment=POLICY_SHA256=' + sha(policy).encode() + b'\n'
    return {'guard': guard, 'admin_policy': policy, 'admin_unit': unit}


class DeriveTests(unittest.TestCase):
    def test_adds_tables_and_moves_only_dependent_pins(self):
        before = fixture()
        after = d.derive(before, NEW)
        namespace = {}
        exec(after['guard'], namespace)
        self.assertEqual(set(namespace['SCHEMAS']['task']),
                         {'tasks', 'audit', 'creation_results', 'result_checkpoints', *NEW})
        self.assertEqual(namespace['SCHEMAS']['task']['history_refs'], 'kind id version')
        self.assertEqual(namespace['SCHEMAS']['legacy']['repair_receipts'], 'id task result_hash result ack')
        policy = json.loads(after['admin_policy'])
        self.assertEqual(policy['sources']['native_guard.py'], sha(after['guard']))
        self.assertEqual(policy['native_guard_producer']['source_sha256'], sha(after['guard']))
        self.assertEqual(policy['sources']['engine.py'], 'e' * 64)
        self.assertIn(sha(after['admin_policy']).encode(), after['admin_unit'])

    def test_refuses_drifted_baseline_or_repeat(self):
        before = fixture()
        with self.assertRaisesRegex(ValueError, 'table_already_admitted'):
            d.derive(d.derive(before, NEW) | {}, NEW)  # guard already admits them; pins checked later
        drifted = dict(before, admin_policy=before['admin_policy'].replace(sha(GUARD).encode(), b'0' * 64, 1))
        with self.assertRaisesRegex(ValueError, 'admin_policy_baseline'):
            d.derive(drifted, NEW)
        with self.assertRaisesRegex(ValueError, 'guard_task_schema_anchor'):
            d.derive(fixture(GUARD.replace(b'reply_available', b'reply')), NEW)

    def test_legacy_growth_moves_only_dependent_pins(self):
        after = d.derive_legacy(fixture(), 'id task result_hash result ack created archive_hash terminal_state',
                                'id request_hash state result created')
        namespace = {}
        exec(after['guard'], namespace)
        legacy = namespace['SCHEMAS']['legacy']
        self.assertEqual(legacy['repair_receipts'].split()[-3:], ['created', 'archive_hash', 'terminal_state'])
        self.assertEqual(legacy['repair_resume_receipts'], 'id request_hash state result created')
        self.assertEqual(json.loads(after['admin_policy'])['sources']['native_guard.py'], sha(after['guard']))
        with self.assertRaisesRegex(ValueError, 'legacy_column_shape'):
            d.derive_legacy(fixture(), 'id ack', 'id')

    def test_rejects_unsafe_table_shapes(self):
        for tables in ({}, {'Bad': 'id'}, {'ok': "id'); import os"}, {'x' * 41: 'id'}):
            with self.assertRaisesRegex(ValueError, 'table_shape'):
                d.derive(fixture(), tables)


if __name__ == '__main__':
    unittest.main()
