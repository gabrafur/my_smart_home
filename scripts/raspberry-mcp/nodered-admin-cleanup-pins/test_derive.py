import hashlib
import json
import unittest

import derive as d


def fixture():
    pins = {'/usr/src/a.js': {'/': [61, 10, 0, 0, 493], '/usr': [61, 11, 0, 0, 493]},
            '/usr/src/b.js': {'/': [61, 10, 0, 0, 493]}}
    policy = d.canonical({'backend': {'host': 'x'}, 'sources': {'engine.py': 'a' * 64},
                          'session_cleanup_recovery': {'enabled': True, 'runtime_source_parent_pins': pins,
                                                       'token_module_sha256': 'b' * 64}})
    unit = ('[Service]\nExecStart=/x ' + hashlib.sha256(policy).hexdigest() + '\n').encode()
    return {'admin_policy': policy, 'admin_unit': unit}, pins


def moved(pins):
    return {p: {n: [110, 9 if n == '/' else v[1]] + v[2:] for n, v in a.items()} for p, a in pins.items()}


class DeriveTests(unittest.TestCase):
    def test_replaces_only_cleanup_pins_and_moves_unit(self):
        before, pins = fixture()
        after = d.derive(before, moved(pins))
        policy = json.loads(after['admin_policy'])
        self.assertEqual(policy['session_cleanup_recovery']['runtime_source_parent_pins'], moved(pins))
        self.assertEqual(policy['sources'], {'engine.py': 'a' * 64})
        self.assertIn(hashlib.sha256(after['admin_policy']).hexdigest().encode(), after['admin_unit'])

    def test_refuses_mode_owner_path_changes_and_no_op(self):
        before, pins = fixture()
        bad = moved(pins)
        bad['/usr/src/a.js']['/usr'][2] = 1000
        with self.assertRaisesRegex(ValueError, 'only_device_and_inode_may_change'):
            d.derive(before, bad)
        with self.assertRaisesRegex(ValueError, 'same_paths_and_ancestors_required'):
            d.derive(before, {'/usr/src/a.js': moved(pins)['/usr/src/a.js']})
        with self.assertRaisesRegex(ValueError, 'pins_already_current'):
            d.derive(before, pins)


if __name__ == '__main__':
    unittest.main()
