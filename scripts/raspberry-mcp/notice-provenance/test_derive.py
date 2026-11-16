import hashlib
import json
import unittest

import derive as d


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fixture():
    before = {n: ('// installed ' + n + '\n').encode() for n in d.SOURCES}
    cand = {n: ('// provenance ' + n + '\n').encode() for n in d.SOURCES}
    def policy(pins, extra):
        return json.dumps({'dependencies': {k: sha(before[k]) for k in pins}, 'grants': extra}, indent=2).encode()
    before['private_policy'] = json.dumps({'source_hashes': {k: sha(before[k]) for k in d.PINS['private_policy']},
                                           'tools': ['x']}).encode()
    before['admin_policy'] = policy(d.PINS['admin_policy'], ['a'])
    before['repair_policy'] = json.dumps({'dependencies': {
        'admin': sha(before['admin_policy']), 'reader': sha(before['notification_reader.py']),
        'state': sha(before['notification_state.cjs'])}, 'grants': ['r']}).encode()
    before['component_policy'] = json.dumps({'dependencies': {
        'admin': sha(before['admin_policy']), 'repair': sha(before['repair_policy'])}}).encode()
    for unit in d.UNITS:
        before[unit] = ('[Service]\nExecStart=/x ' + sha(before['component_policy']) + '\n').encode()
    return before, cand


class DeriveTests(unittest.TestCase):
    def test_moves_every_pin_through_the_chain(self):
        before, cand = fixture()
        after = d.derive(before, cand)
        self.assertEqual({n: after[n] for n in d.SOURCES}, cand)
        private = json.loads(after['private_policy'])
        self.assertEqual(private['source_hashes']['notification_collector.cjs'], sha(cand['notification_collector.cjs']))
        self.assertEqual(private['tools'], ['x'])
        repair = json.loads(after['repair_policy'])['dependencies']
        self.assertEqual(repair['admin'], sha(after['admin_policy']))
        self.assertEqual(repair['reader'], sha(cand['notification_reader.py']))
        component = json.loads(after['component_policy'])['dependencies']
        self.assertEqual(component['repair'], sha(after['repair_policy']))
        for unit in d.UNITS:
            self.assertIn(sha(after['component_policy']).encode(), after[unit])

    def test_refuses_drift_and_no_op(self):
        before, cand = fixture()
        drifted = dict(before, admin_policy=before['admin_policy'].replace(
            sha(before['notification_state.cjs']).encode(), b'0' * 64))
        with self.assertRaisesRegex(ValueError, 'admin_policy_pin_anchor'):
            d.derive(drifted, cand)
        with self.assertRaisesRegex(ValueError, 'candidate_equals_installed'):
            d.derive(before, dict(cand, **{'notification_text.cjs': before['notification_text.cjs']}))
        with self.assertRaisesRegex(ValueError, 'six_candidates_required'):
            d.derive(before, {})


if __name__ == '__main__':
    unittest.main()
