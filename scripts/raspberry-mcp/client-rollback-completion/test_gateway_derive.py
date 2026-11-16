import hashlib
import json
import unittest

import gateway_derive as g

GATEWAY = ("import re\n" + g.FUNCTION_ANCHOR + "\n for value in []:\n" + g.ANCHOR_OLD).encode()


class GatewayDeriveTests(unittest.TestCase):
    def test_patch_and_owner_pin(self):
        owner = json.dumps({'core_sources': {'gateway.py': hashlib.sha256(GATEWAY).hexdigest(), 'x.py': 'a' * 64}}).encode()
        after, new_owner = g.derive(GATEWAY, owner)
        self.assertIn(b'def cg_rollback_completed', after)
        self.assertIn(b"'own_client_rollback_observed'", after)
        self.assertEqual(json.loads(new_owner)['core_sources'], {'gateway.py': hashlib.sha256(after).hexdigest(), 'x.py': 'a' * 64})
        with self.assertRaisesRegex(ValueError, 'gateway_already_patched'):
            g.derive(after, new_owner)


if __name__ == '__main__':
    unittest.main()
