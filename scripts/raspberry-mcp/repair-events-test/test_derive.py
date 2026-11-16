import hashlib
import json
import unittest

import derive as d


def sha(body):
    return hashlib.sha256(body).hexdigest()


def fixture():
    test = b"test('old',()=>{});\n"
    repair = json.dumps({'source_hashes': {'test_events.mjs': sha(test)}, 'grants': ['r']}).encode()
    component = json.dumps({'dependencies': {'repair': sha(repair)}}).encode()
    before = {'test': test, 'repair_policy': repair, 'component_policy': component}
    for unit in d.UNITS:
        before[unit] = ('[Service]\nExecStart=/x ' + sha(component) + '\n').encode()
    return before


class DeriveTests(unittest.TestCase):
    def test_moves_pins_through_the_chain(self):
        before = fixture()
        after = d.derive(before, b"test('new',()=>{});\n")
        repair = json.loads(after['repair_policy'])
        self.assertEqual(repair['source_hashes']['test_events.mjs'], sha(after['test']))
        self.assertEqual(repair['grants'], ['r'])
        self.assertEqual(json.loads(after['component_policy'])['dependencies']['repair'], sha(after['repair_policy']))
        for unit in d.UNITS:
            self.assertIn(sha(after['component_policy']).encode(), after[unit])

    def test_refuses_drift_and_no_op(self):
        before = fixture()
        with self.assertRaisesRegex(ValueError, 'new_test_required'):
            d.derive(before, before['test'])
        drifted = dict(before, repair_policy=before['repair_policy'].replace(sha(before['test']).encode(), b'0' * 64))
        with self.assertRaisesRegex(ValueError, 'repair_policy_pin_anchor'):
            d.derive(drifted, b'x')


if __name__ == '__main__':
    unittest.main()
