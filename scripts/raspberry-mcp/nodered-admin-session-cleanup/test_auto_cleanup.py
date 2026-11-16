import unittest

import auto_cleanup as a

NOW = 1_000_000.0


def session(sid, age=600, confirmed=False, scope='*'):
    receipt = {'security_cleanup_confirmed': confirmed, 'login_confirmed': True, 'observed_at': NOW - age}
    own = {'source': 'own_nodered_admin_token_fingerprint_v1', 'session_id': sid,
           'raw_token_persisted': False, 'requested_scope': scope}
    return receipt, own


class SelectTests(unittest.TestCase):
    def pick(self, sessions, covered=(), attempted=(), evidence=None):
        evidence = evidence if evidence is not None else {k: {'token_received': True} for k in sessions}
        return a.select(sessions, evidence, lambda s: s in covered, set(attempted), NOW)

    def test_oldest_unconfirmed_own_session(self):
        sessions = {'a' * 32: session('a' * 32, 900), 'b' * 32: session('b' * 32, 3000)}
        self.assertEqual(self.pick(sessions), 'b' * 32)

    def test_skips_confirmed_covered_attempted_young_old_and_tokenless(self):
        sid = 'c' * 32
        for sessions, kw in (({sid: session(sid, confirmed=True)}, {}),
                             ({sid: session(sid)}, {'covered': {sid}}),
                             ({sid: session(sid)}, {'attempted': {sid}}),
                             ({sid: session(sid, age=30)}, {}),
                             ({sid: session(sid, age=8 * 86400)}, {}),
                             ({sid: session(sid, scope='admin')}, {}),
                             ({sid: session(sid)}, {'evidence': {sid: {'token_received': False}}})):
            self.assertIsNone(self.pick(sessions, **kw), kw)

    def test_foreign_journal_is_ignored(self):
        receipt, own = session('d' * 32)
        own['session_id'] = 'e' * 32
        self.assertIsNone(self.pick({'d' * 32: (receipt, own)}))


if __name__ == '__main__':
    unittest.main()
