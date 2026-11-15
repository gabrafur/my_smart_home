"""Synthetic tests; no live policy, unit, mount or lock is read."""
import json
import unittest

import derive

OLD, NEW = [35, 88, 1001, 1001, 436], [45826, 260987, 1001, 1001, 436]


def policy(identity=OLD):
    return json.dumps({'schema_version': 1, 'sources': {'engine.py': 'a' * 64},
                       'shared_locks': {'/var/lib/a.lock': [45826, 1, 0, 0, 384], derive.LOCK: identity,
                                        '/var/lib/b.lock': [35, 88, 1001, 1001, 436]}}, separators=(',', ':')).encode()


class Derive(unittest.TestCase):
    def test_only_the_one_pin_and_the_unit_literal_move(self):
        before = policy()
        unit = b'ExecStart=/usr/bin/python3 bootstrap.py ' + derive.sha(before).encode() + b'\nUMask=0077\n'
        after, unit_after = derive.derive(before, unit, OLD, NEW)
        a, b = json.loads(before), json.loads(after)
        self.assertEqual(b['shared_locks'].pop(derive.LOCK), NEW)
        a['shared_locks'].pop(derive.LOCK)
        self.assertEqual(a, b)
        self.assertEqual(b['shared_locks']['/var/lib/b.lock'], [35, 88, 1001, 1001, 436])
        self.assertEqual(unit_after, unit.replace(derive.sha(before).encode(), derive.sha(after).encode()))
        self.assertEqual(len(after) - len(before), len('45826,260987') - len('35,88'))

    def test_refusals(self):
        before = policy()
        unit = b'x ' + derive.sha(before).encode()
        cases = [
            (before, unit, [34, 55, 1001, 1001, 436], NEW),       # baseline is not what is installed
            (before, unit, OLD, OLD),                              # nothing to change
            (before, unit, OLD, [45826, 260987, 0, 0, 436]),       # owner must not change
            (before, unit, OLD, [45826, 260987, 1001, 1001, 438]), # mode must not change
            (before, unit, OLD, [45826, '260987', 1001, 1001, 436]),
            (before, b'no literal', OLD, NEW),
            (before, unit + b' ' + derive.sha(before).encode(), OLD, NEW),
            (json.dumps(json.loads(before), indent=1).encode(), unit, OLD, NEW),  # unexpected formatting
        ]
        for args in cases:
            with self.assertRaises(ValueError):
                derive.derive(*args)


if __name__ == '__main__':
    unittest.main()
