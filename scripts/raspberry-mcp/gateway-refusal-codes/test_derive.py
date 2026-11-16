import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import derive as d

GATEWAY = ("import datetime\nimport json\nimport os\nimport re\n" + d.UNKNOWN_OLD +
           "    return {'source':'x','state':'unknown',\n" + d.UNKNOWN_RETURN_OLD +
           "def route(a,runtime):\n    if True:\n" + d.OBSERVE_OLD +
           "def main(q):\n    try:raise q\n" + d.MAIN_OLD + "        except BrokenPipeError:return\n").encode()


def load(body):
    path = Path(tempfile.mkdtemp()) / 'g.py'
    path.write_bytes(body)
    spec = importlib.util.spec_from_file_location('g', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GatewayRefusalTests(unittest.TestCase):
    def setUp(self):
        self.owner = json.dumps({'core_sources': {'gateway.py': hashlib.sha256(GATEWAY).hexdigest()}}).encode()
        self.after, self.new_owner = d.derive(GATEWAY, self.owner)
        self.g = load(self.after)

    def test_static_codes_only(self):
        self.assertEqual(self.g.refusal_code(ValueError('held_lock_path_changed')), 'held_lock_path_changed')
        self.assertEqual(self.g.refusal_code(ValueError('/etc/secret path')), 'ValueError')
        self.assertEqual(self.g.refusal_code(KeyError('token')), 'KeyError')
        self.assertIsNone(self.g.refusal_code(None))
        self.assertEqual(self.g.unknown(ValueError('shared_lock_identity_changed'))['refusal_code'], 'shared_lock_identity_changed')

    def test_absent_only_for_missing_operation(self):
        class R:
            def __init__(self, error): self.error = error
            def observe_operation(self, op): raise self.error
        self.assertEqual(self.g.route({'operation_id': 'a' * 32}, R(ValueError('operation_unknown_observe_only')))['state'], 'absent')
        with self.assertRaisesRegex(ValueError, 'other_refusal'):
            self.g.route({'operation_id': 'a' * 32}, R(ValueError('other_refusal')))

    def test_owner_pin_and_repeat(self):
        self.assertEqual(json.loads(self.new_owner)['core_sources']['gateway.py'], hashlib.sha256(self.after).hexdigest())
        with self.assertRaisesRegex(ValueError, 'gateway_already_patched'):
            d.derive(self.after, self.new_owner)


if __name__ == '__main__':
    unittest.main()
