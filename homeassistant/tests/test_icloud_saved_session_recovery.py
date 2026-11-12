"""Saved-token recovery is durable and never grants automatic OTP delivery."""
import sys
import unittest
from test_icloud_cached_transport import load


class SavedSessionRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.g, self.bridge, _, self.prior = load()
        self.saved, self.attempts, self.primary = [], [], []

    def tearDown(self):
        for name, value in self.prior.items():
            if value is None: sys.modules.pop(name, None)
            else: sys.modules[name] = value

    def gate(self, state=None, attempted=False):
        return self.g.AuthGate(self.saved.append,
            {'schema_version': 1, 'state': (state or self.g.State.VALID).value},
            automatic_recovery=True, persist_recovery=self.primary.append,
            persist_cached_recovery=self.attempts.append,
            cached_recovery_saved={'schema_version': 1, 'attempted': attempted})

    def test_token_acceptance_does_not_rearm_until_full_authenticated_setup(self):
        gate = self.gate()
        calls = []
        def renew():
            self.assertEqual(self.attempts[-1], {'schema_version': 1, 'attempted': True})
            self.assertEqual(self.saved[-1]['state'], self.g.State.UNCERTAIN)
            calls.append('token_only')
            return self.g.Outcome.VALID
        self.assertEqual(gate.renew_saved_session(renew).state, self.g.State.VALID)
        gate.renew_saved_session(renew)
        self.assertEqual(calls, ['token_only'])
        self.assertEqual(self.primary, [])
        gate.confirm_account_ready()
        self.assertFalse(gate.cached_recovery_attempted)
        self.assertEqual(self.attempts[-1]['attempted'], False)

    def test_otp_and_uncertainty_survive_restart_without_replay(self):
        for outcome, state in [(self.g.Outcome.CHALLENGE, self.g.State.READY),
                               (self.g.Outcome.TRANSPORT, self.g.State.UNCERTAIN),
                               (self.g.Outcome.UNKNOWN, self.g.State.UNCERTAIN)]:
            gate = self.gate()
            self.assertEqual(gate.renew_saved_session(lambda: outcome).state, state)
            restored = self.gate(state, attempted=True)
            restored.renew_saved_session(lambda: self.fail('uncertain renewal replayed'))
            self.assertEqual(restored.state, state)
            self.assertEqual(self.primary, [])

    def test_known_code_wait_blocks_all_background_recovery(self):
        gate = self.gate(self.g.State.READY, attempted=True)
        gate.cached_session(lambda: self.fail('must wait for OTP'))
        gate.recover_silently(lambda: self.fail('must not log in again'))
        gate.renew_saved_session(lambda: self.fail('must not renew again'))
        self.assertEqual(gate.state, self.g.State.READY)
        self.assertEqual(gate.reopen_cached_challenge().reason, 'challenge_preparation_required')
        self.assertEqual(gate.state, self.g.State.PRIMARY)

    def test_failed_persistence_prevents_token_call(self):
        gate = self.gate()
        gate.persist_cached_recovery = lambda row: (_ for _ in ()).throw(OSError('synthetic'))
        with self.assertRaises(OSError):
            gate.renew_saved_session(lambda: self.fail('effect before durable admission'))

    def test_invalid_metadata_is_not_an_unused_recovery_slot(self):
        for saved in [{}, {'schema_version': True, 'attempted': False},
                      {'schema_version': 1, 'attempted': 'false'}]:
            with self.assertRaises(ValueError):
                self.g.AuthGate(self.saved.append, cached_recovery_saved=saved)

    def test_busy_and_disabled_policy_never_renew(self):
        gate = self.gate()
        gate._lock.acquire()
        try:
            self.assertEqual(gate.renew_saved_session(lambda: self.fail()).reason, 'operation_in_progress')
        finally: gate._lock.release()
        gate.automatic_recovery = False
        gate.renew_saved_session(lambda: self.fail('policy disabled'))
