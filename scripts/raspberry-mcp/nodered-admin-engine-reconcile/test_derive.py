import hashlib
import json
import unittest

import derive as d


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fixture():
    engine = b'# installed engine\n'
    policy = json.dumps({'sources': {'engine.py': sha(engine), 'gateway.py': 'a' * 64},
                         'native_guard_producer': {'source_sha256': 'b' * 64}}, indent=2).encode()
    unit = ('[Service]\nExecStart=/usr/bin/python3 bootstrap.py ' + sha(policy) + '\n').encode()
    return {'engine': engine, 'admin_policy': policy, 'admin_unit': unit}


class DeriveTests(unittest.TestCase):
    def test_moves_engine_and_policy_pins_only(self):
        before = fixture()
        after = d.derive(before, b'# reconciling engine\n')
        policy = json.loads(after['admin_policy'])
        self.assertEqual(policy['sources']['engine.py'], sha(after['engine']))
        self.assertEqual(policy['sources']['gateway.py'], 'a' * 64)
        self.assertIn(sha(after['admin_policy']).encode(), after['admin_unit'])
        self.assertNotIn(sha(before['admin_policy']).encode(), after['admin_unit'])

    def test_refuses_no_op_and_drift(self):
        before = fixture()
        with self.assertRaisesRegex(ValueError, 'new_engine_required'):
            d.derive(before, before['engine'])
        drifted = dict(before, admin_policy=before['admin_policy'].replace(sha(before['engine']).encode(), b'0' * 64))
        with self.assertRaisesRegex(ValueError, 'admin_policy_baseline'):
            d.derive(drifted, b'x')
        moved = dict(before, admin_unit=b'[Service]\nExecStart=/x\n')
        with self.assertRaisesRegex(ValueError, 'admin_unit_policy_anchor'):
            d.derive(moved, b'x')


if __name__ == '__main__':
    unittest.main()
