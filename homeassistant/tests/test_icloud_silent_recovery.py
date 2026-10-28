"""Actual gate/adapter with synthetic provider boundaries; no network or config."""
import sys
import threading
import unittest
from test_icloud_cached_transport import load, RequestConnectionError, FakeAccount


class SilentProvider:
    primary = deliveries = probes = 0
    cached = False
    challenge = False
    failure = probe_failure = None
    before_primary = None

    def __init__(self, *args, **kwargs):
        assert kwargs['authenticate'] is False and kwargs['pause_2fa'] is True

    def _try_reuse_cached_session(self, force_refresh, pause_2fa):
        SilentProvider.probes += 1
        assert force_refresh is False and pause_2fa is True
        if self.probe_failure: raise self.probe_failure
        return self.cached

    @property
    def requires_2fa(self): return self.challenge
    @property
    def requires_2sa(self): return False
    def _update_state(self): pass

    def authenticate(self, **kwargs):
        raise AssertionError('token_first_login_forbidden')

    def _srp_authentication(self, *, pause_2fa):
        assert pause_2fa is True
        SilentProvider.primary += 1
        if SilentProvider.before_primary: SilentProvider.before_primary()
        # A real provider may inspect this property while the gate is locked.
        assert self.requires_2fa is self.challenge
        self._authenticate()
        self.request_2fa_code()  # Native fallback must always be suppressed.
        if self.failure: raise self.failure
        self._requires_mfa = self.challenge
        return False

    def _authenticate_with_token(self, *, require_trust):
        assert require_trust is False
        self.cached = True

    def _authenticate(self): pass
    def request_2fa_code(self):
        SilentProvider.deliveries += 1
        raise AssertionError('challenge_delivery_forbidden')
    def _request_sms_2fa_code(self):
        SilentProvider.deliveries += 1
        raise AssertionError('SMS_delivery_forbidden')


class SilentRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g, cls.b, _, cls.prior = load()

    @classmethod
    def tearDownClass(cls):
        for name, value in cls.prior.items():
            if value is None: sys.modules.pop(name, None)
            else: sys.modules[name] = value

    def setUp(self):
        SilentProvider.primary = SilentProvider.deliveries = SilentProvider.probes = 0
        SilentProvider.cached = SilentProvider.challenge = False
        SilentProvider.failure = SilentProvider.probe_failure = SilentProvider.before_primary = None
        self.saved = []
        self.recovery = []
        self.Client = self.b.service_adapter(SilentProvider, transport_errors=(RequestConnectionError,))
        FakeAccount.client=self.Client
        FakeAccount.reauth=FakeAccount.device_updates=0
        FakeAccount.update_error=None

    def gate(self, state=None, automatic=True):
        saved = None if state is None else {'schema_version': 1, 'state': state.value}
        return self.g.AuthGate(self.saved.append, saved, automatic_recovery=automatic,
                               persist_recovery=self.recovery.append)

    def client(self, gate):
        with self.b.bind_gate(gate): return self.Client()

    def test_expired_cached_session_recovers_without_challenge_delivery(self):
        gate = self.gate()
        SilentProvider.before_primary = lambda: self.assertEqual(self.saved[-1]['state'], self.g.State.UNCERTAIN)
        client = self.client(gate)
        self.assertEqual(gate.state, self.g.State.VALID)
        self.assertEqual(SilentProvider.primary, 1)
        self.assertEqual(SilentProvider.deliveries, 0)
        client.authenticate()
        self.assertEqual(SilentProvider.primary, 1)

    def test_existing_waiting_user_state_can_recover_once(self):
        gate = self.gate(self.g.State.USER)
        self.client(gate)
        self.assertEqual(gate.state, self.g.State.VALID)
        self.assertEqual(SilentProvider.primary, 1)

    def test_valid_cached_session_does_not_use_primary_authentication(self):
        SilentProvider.cached = True
        gate = self.gate();self.client(gate)
        self.assertEqual(gate.state, self.g.State.VALID)
        self.assertEqual(SilentProvider.primary, 0)

    def test_challenge_after_primary_waits_for_user_across_restart(self):
        SilentProvider.challenge = True
        gate = self.gate(self.g.State.USER);client = self.client(gate)
        self.assertEqual(gate.state, self.g.State.PRIMARY)
        restored = self.g.AuthGate(self.saved.append, self.saved[-1], automatic_recovery=True,
                                  persist_recovery=self.recovery.append, recovery_saved=self.recovery[-1])
        self.client(restored)
        with self.assertRaises(self.b.ManualActionRequired): client.authenticate()
        self.assertEqual(SilentProvider.primary, 1)
        self.assertEqual(SilentProvider.deliveries, 0)

    def test_cached_challenge_tries_saved_password_once(self):
        SilentProvider.cached = SilentProvider.challenge = True
        gate = self.gate();self.client(gate)
        self.assertEqual(gate.state, self.g.State.PRIMARY)
        self.assertEqual(SilentProvider.primary, 1)

    def test_primary_transport_uncertainty_is_persisted_and_not_retried(self):
        SilentProvider.failure = RequestConnectionError('PRIVATE_PROVIDER_TEXT')
        gate = self.gate(self.g.State.USER)
        with self.assertRaises(self.b.CachedSessionTransportError): self.client(gate)
        self.assertEqual(gate.state, self.g.State.UNCERTAIN)
        restored = self.g.AuthGate(self.saved.append, self.saved[-1], automatic_recovery=True,
                                  persist_recovery=self.recovery.append, recovery_saved=self.recovery[-1])
        self.client(restored)
        self.assertEqual(SilentProvider.primary, 1)
        self.assertEqual(SilentProvider.deliveries, 0)

    def test_cached_transport_keeps_existing_native_retry_without_primary(self):
        SilentProvider.probe_failure = RequestConnectionError('PRIVATE_PROVIDER_TEXT')
        gate = self.gate()
        with self.assertRaises(self.b.CachedSessionTransportError): self.client(gate)
        self.assertEqual(gate.state, self.g.State.PROBE)
        self.assertEqual(SilentProvider.primary, 0)

    def test_unknown_cached_failure_stops_without_primary_login(self):
        SilentProvider.probe_failure = ValueError('PRIVATE_PROVIDER_TEXT')
        gate = self.gate();self.client(gate);self.client(gate)
        self.assertEqual(gate.state, self.g.State.UNCERTAIN)
        self.assertEqual(SilentProvider.primary, 0)

    def test_manual_challenge_and_unknown_delivery_are_never_reopened(self):
        for state in (self.g.State.CODE, self.g.State.READY, self.g.State.UNCERTAIN,
                      self.g.State.LIMITED):
            self.client(self.gate(state))
        self.assertEqual(SilentProvider.primary, 0)
        self.assertEqual(SilentProvider.deliveries, 0)

    def test_policy_can_disable_automatic_recovery(self):
        gate = self.gate(self.g.State.USER, automatic=False);self.client(gate)
        self.assertEqual(gate.state, self.g.State.USER)
        self.assertEqual(SilentProvider.primary, 0)

    def test_guard_rechecks_state_after_lock_acquisition(self):
        gate = self.gate(self.g.State.CODE)
        calls=[];result=gate.recover_silently(lambda:calls.append(True))
        self.assertFalse(result.effect_attempted);self.assertFalse(calls)

    def test_concurrent_authentication_does_not_duplicate_primary_login(self):
        entered=threading.Event();release=threading.Event();errors=[]
        def wait():
            entered.set()
            if not release.wait(2): raise RuntimeError('synthetic_test_timeout')
        SilentProvider.before_primary=wait;gate=self.gate(self.g.State.USER)
        def first():
            try:self.client(gate)
            except Exception as error:errors.append(type(error).__name__)
        thread=threading.Thread(target=first);thread.start()
        try:
            self.assertTrue(entered.wait(2))
            with self.assertRaises(self.b.CachedSessionBusyError):self.client(gate)
        finally:release.set();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertFalse(errors)
        self.assertEqual(SilentProvider.primary,1)

    def test_persistence_failure_before_effect_prevents_primary_login(self):
        gate=self.gate(self.g.State.USER)
        gate.persist=lambda row:(_ for _ in ()).throw(OSError('synthetic_write_failure'))
        with self.assertRaises(OSError):self.client(gate)
        self.assertEqual(SilentProvider.primary,0)

    def test_manual_challenge_can_still_be_prepared_explicitly(self):
        gate=self.gate(self.g.State.PRIMARY)
        result=gate.submit('prepare_session',lambda:self.g.Outcome.CHALLENGE,explicit_submission=True)
        self.assertEqual(result.state,self.g.State.READY)
        call=[];gate.submit('request_challenge',lambda:call.append(True),explicit_submission=False)
        self.assertFalse(call)

    def test_primary_entrypoint_is_not_exposed_outside_owned_context(self):
        gate=self.gate(self.g.State.CODE);client=self.client(gate)
        with self.assertRaises(self.b.ManualActionRequired):client._authenticate()
        with self.assertRaises(self.b.ManualActionRequired):client._request_sms_2fa_code()
        self.assertFalse(client.validate_2fa_code('synthetic-unused-code'))
        self.assertEqual(SilentProvider.deliveries,0)

    def test_native_account_path_resumes_setup_and_normal_keepalive(self):
        gate=self.gate(self.g.State.USER)
        Account=self.b.account_adapter(FakeAccount,{'synthetic':gate},self.Client)
        account=Account();account.setup();account.keep_alive()
        self.assertEqual(gate.state,self.g.State.VALID)
        self.assertEqual(FakeAccount.reauth,0)
        self.assertEqual(FakeAccount.device_updates,1)
        self.assertEqual(SilentProvider.primary,1)

    def test_known_challenge_stops_native_account_keepalive(self):
        SilentProvider.challenge=True;gate=self.gate(self.g.State.USER)
        Account=self.b.account_adapter(FakeAccount,{'synthetic':gate},self.Client)
        account=Account();account.setup();before=SilentProvider.primary;account.keep_alive()
        self.assertEqual(gate.state,self.g.State.PRIMARY)
        self.assertEqual(SilentProvider.primary,before)
        self.assertEqual(FakeAccount.device_updates,0)

    def test_post_effect_persistence_failure_keeps_uncertainty_across_restart(self):
        def persist(row):
            if row['state']==self.g.State.VALID:raise OSError('synthetic_write_failure')
            self.saved.append(row)
        gate=self.g.AuthGate(persist,{'schema_version':1,'state':self.g.State.USER.value},automatic_recovery=True,
                                  persist_recovery=self.recovery.append)
        with self.assertRaises(OSError):self.client(gate)
        self.assertEqual(gate.state,self.g.State.UNCERTAIN)
        restored=self.g.AuthGate(self.saved.append,self.saved[-1],automatic_recovery=True,
                                  persist_recovery=self.recovery.append, recovery_saved=self.recovery[-1])
        self.client(restored);self.assertEqual(SilentProvider.primary,1)


    def test_successful_session_can_recover_after_new_confirmed_expiry(self):
        gate=self.gate();client=self.client(gate)
        self.assertTrue(gate.primary_attempted)
        client.cached=False
        client.authenticate()
        self.assertEqual(SilentProvider.primary,2)
        self.assertEqual([r['primary_attempted'] for r in self.recovery],[True,False,True])

    def test_attempt_marker_is_saved_before_provider_and_auth_state(self):
        gate=self.gate(self.g.State.USER)
        SilentProvider.before_primary=lambda:self.assertTrue(self.recovery[-1]['primary_attempted'])
        self.client(gate)
        self.assertTrue(gate.primary_attempted)

    def test_completed_recovery_allows_one_later_device_rejection_after_restart(self):
        # Yesterday's primary attempt and subsequent manual authentication.
        gate=self.gate(self.g.State.USER);self.client(gate)
        gate.submit('prepare_session',lambda:self.g.Outcome.VALID,explicit_submission=True)
        self.assertTrue(gate.primary_attempted)  # Token-only success is not setup.
        gate.confirm_account_ready()
        self.assertFalse(gate.primary_attempted)
        restored=self.g.AuthGate(self.saved.append,self.saved[-1],automatic_recovery=True,
            persist_recovery=self.recovery.append,recovery_saved=self.recovery[-1])
        class AuthRequired(Exception):pass
        class LaterServiceAccount(FakeAccount):
            calls=0
            def setup(account):
                LaterServiceAccount.calls+=1
                super().setup()
                if LaterServiceAccount.calls==1:raise AuthRequired('synthetic')
        SilentProvider.primary=0;SilentProvider.cached=True
        Account=self.b.account_adapter(LaterServiceAccount,{'synthetic':restored},self.Client,
                                      auth_required_errors=(AuthRequired,))
        Account().setup()
        self.assertEqual(SilentProvider.primary,1)
        self.assertEqual(LaterServiceAccount.calls,2)
        self.assertTrue(restored.primary_attempted)
        self.assertEqual(SilentProvider.deliveries,0)

    def test_incomplete_or_uncertain_recovery_never_rearms(self):
        for state in (self.g.State.USER,self.g.State.PRIMARY,self.g.State.READY,
                      self.g.State.CODE,self.g.State.UNCERTAIN,self.g.State.LIMITED):
            gate=self.g.AuthGate(self.saved.append,{'schema_version':1,'state':state.value},
                automatic_recovery=True,persist_recovery=self.recovery.append,
                recovery_saved={'schema_version':1,'primary_attempted':True})
            self.assertEqual(gate.confirm_account_ready().reason,'authenticated_setup_required')
            self.assertTrue(gate.primary_attempted)
        self.assertFalse(self.recovery)

    def test_ready_marker_write_failure_preserves_consumed_attempt(self):
        gate=self.gate();self.client(gate)
        gate.persist_recovery=lambda row:(_ for _ in ()).throw(OSError('synthetic'))
        with self.assertRaises(OSError):gate.confirm_account_ready()
        self.assertTrue(gate.primary_attempted)
        self.assertEqual(gate.state,self.g.State.VALID)

    def test_ready_confirmation_does_not_interleave_with_authentication(self):
        gate=self.gate();self.client(gate)
        gate._lock.acquire()
        try:self.assertEqual(gate.confirm_account_ready().reason,'operation_in_progress')
        finally:gate._lock.release()
        self.assertTrue(gate.primary_attempted)

    def test_marker_write_failure_prevents_provider(self):
        gate=self.gate(self.g.State.USER)
        gate.persist_recovery=lambda row:(_ for _ in ()).throw(OSError('synthetic'))
        with self.assertRaises(OSError):self.client(gate)
        self.assertEqual(SilentProvider.primary,0)

    def test_malformed_marker_and_missing_persistence_fail_closed(self):
        for bad in ({}, {'schema_version':True,'primary_attempted':False},
                    {'schema_version':1,'primary_attempted':'false'}):
            with self.assertRaises(ValueError):
                self.g.AuthGate(self.saved.append,automatic_recovery=True,
                    persist_recovery=self.recovery.append,recovery_saved=bad)
        with self.assertRaises(ValueError):self.g.AuthGate(self.saved.append,automatic_recovery=True)

    def test_attempted_primary_state_does_not_repeat_after_restart(self):
        gate=self.g.AuthGate(self.saved.append,{'schema_version':1,'state':self.g.State.PRIMARY.value},
            automatic_recovery=True,persist_recovery=self.recovery.append,
            recovery_saved={'schema_version':1,'primary_attempted':True})
        self.client(gate)
        self.assertEqual(SilentProvider.primary,0)


    def test_device_service_rejection_after_valid_token_uses_password_once(self):
        class AuthRequired(Exception):pass
        class ServiceAccount(FakeAccount):
            calls=0
            def setup(account):
                ServiceAccount.calls+=1
                super().setup()
                if ServiceAccount.calls==1:raise AuthRequired('synthetic')
        SilentProvider.cached=True;gate=self.gate()
        Account=self.b.account_adapter(ServiceAccount,{'synthetic':gate},self.Client,
                                      auth_required_errors=(AuthRequired,))
        account=Account();account.setup()
        self.assertEqual(gate.state,self.g.State.VALID)
        self.assertEqual(ServiceAccount.calls,2)
        self.assertEqual(SilentProvider.primary,1)
        self.assertEqual(SilentProvider.deliveries,0)

    def test_device_rejection_after_password_stops_without_setup_loop(self):
        class AuthRequired(Exception):pass
        class ServiceAccount(FakeAccount):
            calls=0
            def setup(account):
                ServiceAccount.calls+=1
                super().setup();raise AuthRequired('synthetic')
        SilentProvider.cached=True;gate=self.gate()
        Account=self.b.account_adapter(ServiceAccount,{'synthetic':gate},self.Client,
                                      auth_required_errors=(AuthRequired,))
        account=Account();account.setup();account.keep_alive()
        self.assertEqual(gate.state,self.g.State.PRIMARY)
        self.assertEqual(ServiceAccount.calls,2)
        self.assertEqual(SilentProvider.primary,1)
        self.assertEqual(SilentProvider.deliveries,0)


if __name__=='__main__':unittest.main()
