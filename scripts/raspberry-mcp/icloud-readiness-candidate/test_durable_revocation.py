import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('durable_revocation', Path(__file__).with_name('durable_revocation.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class DurableRevocationTest(unittest.TestCase):
    def test_policies_change_only_integrity_pins(self):
        a = {'expires_at': m.EXPIRY, 'readiness_scope': {'enabled': True}, 'dependencies': {'old': 'keep'}, 'budget': 6}
        r = {'expires_at': m.EXPIRY, 'dependencies': {str(m.ADMIN): 'old'}, 'maximum_submissions': 2}
        sha = lambda b: hashlib.sha256(b).hexdigest()
        aa, rr = m.proposed(json.dumps(a).encode(), json.dumps(r).encode(), sha)
        a['dependencies'][str(m.RULE)] = sha(m.CONTENT)
        r['dependencies'][str(m.ADMIN)] = sha(aa)
        self.assertEqual(json.loads(aa), a); self.assertEqual(json.loads(rr), r)

    def test_changed_expiry_or_existing_rule_refused(self):
        a = {'expires_at': m.EXPIRY, 'readiness_scope': {'enabled': True}, 'dependencies': {str(m.RULE): 'existing'}}
        r = {'expires_at': m.EXPIRY, 'dependencies': {}}
        with self.assertRaises(AssertionError): m.proposed(json.dumps(a).encode(), json.dumps(r).encode(), lambda _: 'hash')
        a['dependencies'] = {}; r['expires_at'] += 1
        with self.assertRaises(AssertionError): m.proposed(json.dumps(a).encode(), json.dumps(r).encode(), lambda _: 'hash')

    def test_rule_never_overwrites_or_creates_revocation_content(self):
        lines = m.CONTENT.decode().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[-1].startswith('L '))
        self.assertNotIn('L+', m.CONTENT.decode())
        self.assertFalse(any(line.startswith(('f ', 'f+', 'r ', 'R ')) for line in lines))
