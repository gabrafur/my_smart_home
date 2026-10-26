"""Pure candidate tests. No HA/provider imports, network, cookies or config."""
import ast
from http.client import RemoteDisconnected
import importlib.util
from pathlib import Path
from socket import gaierror
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'custom_components' / 'icloud'
PUBLIC = ROOT / 'setup_retry.py'
SECRET = ''.join(('PRIVATE', '_SYNTHETIC_PROVIDER_TEXT'))


class RequestConnectionError(Exception): pass
class RequestTimeout(Exception): pass
class CustomTransport(Exception): pass


def load():
    # Load the actual public pure classifier AST, replacing provider exception
    # imports with synthetic boundaries; never import requests or HA here.
    tree = ast.parse(PUBLIC.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'is_transport_failure')
    classifier = ModuleType('cached_transport_candidate.setup_retry')
    classifier.__dict__.update(RemoteDisconnected=RemoteDisconnected, gaierror=gaierror,
                               RequestsConnectionError=RequestConnectionError, Timeout=RequestTimeout)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(PUBLIC), 'exec'), classifier.__dict__)
    package = ModuleType('cached_transport_candidate'); package.__path__ = [str(ROOT)]
    names = ['cached_transport_candidate', 'cached_transport_candidate.setup_retry',
             'cached_transport_candidate.auth_gate', 'cached_transport_candidate.native_bridge']
    prior = {n: sys.modules.get(n) for n in names}
    sys.modules[names[0]] = package; sys.modules[names[1]] = classifier
    modules = []
    for short in ('auth_gate', 'native_bridge'):
        name = 'cached_transport_candidate.' + short
        spec = importlib.util.spec_from_file_location(name, ROOT / (short + '.py'))
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module
        spec.loader.exec_module(module); modules.append(module)
    return modules[0], modules[1], classifier, prior


class FakeProvider:
    failure = None
    cached_valid = True
    challenge = False
    attempts = primary = deliveries = updates = 0

    def __init__(self, *args, **kwargs):
        assert kwargs['authenticate'] is False and kwargs['pause_2fa'] is True
    def _try_reuse_cached_session(self, force_refresh, pause_2fa):
        assert force_refresh is False and pause_2fa is True
        FakeProvider.attempts += 1
        if self.failure is not None: raise self.failure
        return self.cached_valid
    @property
    def requires_2fa(self): return self.challenge
    @property
    def requires_2sa(self): return False
    def _update_state(self): FakeProvider.updates += 1
    def authenticate(self, **kwargs):
        FakeProvider.primary += 1; raise AssertionError('primary authentication forbidden')
    def request_2fa_code(self):
        FakeProvider.deliveries += 1; raise AssertionError('OTP forbidden')


class FakeAccount:
    client = None
    update_error = None
    reauth = device_updates = 0

    def __init__(self):
        self._config_entry = SimpleNamespace(entry_id='synthetic')
        self._username = 'synthetic@example.invalid'; self._password = SECRET
        self._icloud_dir = SimpleNamespace(path='/not-read'); self._with_family = False
        self.api = None
    def setup(self):
        self.api = self.client(self._username, self._password, self._icloud_dir.path)
        if self.api.requires_2fa: self._require_reauth()
    def keep_alive(self, now=None):
        if self.api is None: self.setup()
        if self.api is None: return
        self.api.authenticate()
        self.update_devices()
    def update_devices(self):
        FakeAccount.device_updates += 1
        if self.update_error is not None: raise self.update_error
    def _require_reauth(self): FakeAccount.reauth += 1


class ProviderAPIError(Exception): pass


def swallowing_provider():
    # Model the provider boundary which swallows its API exception. The real
    # pyicloud implementation is also checked separately in the isolated HA image.
    class SwallowingProvider(FakeProvider):
        def _try_reuse_cached_session(self, force_refresh, pause_2fa):
            if not self.session.data.get('session_token') or force_refresh:
                return False
            try:
                self.data = self._validate_token()
            except ProviderAPIError:
                return False
            return self.is_trusted_session or pause_2fa
        enter = release = None
        own_property_seen = False
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.session = SimpleNamespace(data={'session_token': 'fixture'})
            self.data = {}
        @property
        def is_trusted_session(self): return True
        def _validate_token(self):
            FakeProvider.attempts += 1
            # Own validation must not misclassify its guard as contention.
            self.requires_2fa
            SwallowingProvider.own_property_seen = True
            if self.enter is not None:
                self.enter.set()
                if not self.release.wait(2): raise AssertionError('bounded_fixture_wait')
            if self.failure is not None: raise self.failure
            return {'synthetic': True}
    return SwallowingProvider


class CachedTransportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.g, cls.b, cls.classifier, cls.prior = load()
    @classmethod
    def tearDownClass(cls):
        for name, value in cls.prior.items():
            if value is None: sys.modules.pop(name, None)
            else: sys.modules[name] = value
    def setUp(self):
        FakeProvider.failure = None; FakeProvider.cached_valid = True; FakeProvider.challenge = False
        FakeProvider.attempts = FakeProvider.primary = FakeProvider.deliveries = FakeProvider.updates = 0
        FakeAccount.reauth = FakeAccount.device_updates = 0; FakeAccount.update_error = None
        self.saved = []
        self.Client = self.b.service_adapter(FakeProvider, transport_errors=(RequestConnectionError, RequestTimeout, CustomTransport))
        FakeAccount.client = self.Client
    def gate(self, state=None):
        saved = None if state is None else {'schema_version': 1, 'state': state.value}
        return self.g.AuthGate(self.saved.append, saved)
    def client(self, gate):
        with self.b.bind_gate(gate): return self.Client()
    def assert_no_auth(self):
        self.assertEqual(FakeProvider.primary, 0); self.assertEqual(FakeProvider.deliveries, 0)
    def test_probe_direct_transport_preserved_and_typed_constructor_error(self):
        gate = self.gate(); FakeProvider.failure = RequestTimeout(SECRET)
        with self.assertRaises(self.b.CachedSessionTransportError) as caught: self.client(gate)
        self.assertIsInstance(caught.exception, ConnectionError)
        self.assertEqual(str(caught.exception), 'cached_session_transport_unavailable')
        self.assertEqual(gate.state, self.g.State.PROBE)
        self.assertEqual(self.saved[-1], {'schema_version': 1, 'state': self.g.State.PROBE.value})
        self.assertTrue(self.classifier.is_transport_failure(caught.exception))
        self.assertEqual(FakeProvider.attempts, 1); self.assert_no_auth()
    def test_valid_wrapped_transport_preserved_without_retry(self):
        gate = self.gate(); client = self.client(gate); FakeProvider.attempts = 0
        error = RuntimeError(SECRET); error.__cause__ = RemoteDisconnected(SECRET)
        FakeProvider.failure = error
        with self.assertRaises(self.b.CachedSessionTransportError): client.authenticate()
        self.assertEqual(gate.state, self.g.State.VALID)
        self.assertEqual(FakeProvider.attempts, 1); self.assert_no_auth()
    def test_configured_direct_transport_supported(self):
        gate = self.gate(); FakeProvider.failure = CustomTransport(SECRET)
        with self.assertRaises(self.b.CachedSessionTransportError): self.client(gate)
        self.assertEqual(gate.state, self.g.State.PROBE); self.assert_no_auth()
    def test_setup_transport_propagates_without_manual_repair(self):
        gate = self.gate(); FakeProvider.failure = gaierror(SECRET)
        Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, self.Client)
        account = Account()
        with self.assertRaises(self.b.CachedSessionTransportError): account.setup()
        self.assertEqual(FakeAccount.reauth, 0); self.assertEqual(FakeAccount.device_updates, 0)
        self.assertEqual(FakeProvider.attempts, 1); self.assert_no_auth()
    def test_keepalive_typed_transport_returns_until_next_natural_cycle(self):
        gate = self.gate(); client = self.client(gate); FakeProvider.attempts = 0
        Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, self.Client)
        account = Account(); account.api = client; FakeProvider.failure = RequestConnectionError(SECRET)
        account.keep_alive()
        self.assertEqual(FakeProvider.attempts, 1); self.assertEqual(FakeAccount.reauth, 0)
        self.assertEqual(FakeAccount.device_updates, 0); self.assertEqual(gate.state, self.g.State.VALID)
        FakeProvider.failure = None; account.keep_alive()
        self.assertEqual(FakeProvider.attempts, 2); self.assertEqual(FakeAccount.device_updates, 1)
        self.assert_no_auth()
    def test_keepalive_does_not_swallow_unrelated_device_transport(self):
        gate = self.gate(); client = self.client(gate); FakeProvider.attempts = 0
        Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, self.Client)
        account = Account(); account.api = client; FakeAccount.update_error = RequestConnectionError(SECRET)
        with self.assertRaises(RequestConnectionError): account.keep_alive()
        self.assertEqual(FakeProvider.attempts, 1); self.assertEqual(FakeAccount.device_updates, 1)
        self.assertEqual(FakeAccount.reauth, 0); self.assert_no_auth()
    def test_expired_challenge_and_unknown_remain_manual(self):
        for kind in ('expired', 'challenge', 'unknown', 'transport_text_only'):
            with self.subTest(kind=kind):
                FakeProvider.cached_valid = kind != 'expired'; FakeProvider.challenge = kind == 'challenge'
                FakeProvider.failure = RuntimeError(SECRET if kind == 'unknown' else 'timeout') if kind in ('unknown', 'transport_text_only') else None
                gate = self.gate(); client = self.client(gate)
                self.assertEqual(gate.state, self.g.State.USER)
                prior = FakeProvider.attempts
                with self.assertRaises(self.b.ManualActionRequired): client.authenticate()
                self.assertEqual(FakeProvider.attempts, prior); self.assert_no_auth()
    def test_old_blocked_states_never_reopened(self):
        for state in (self.g.State.USER, self.g.State.CODE, self.g.State.READY, self.g.State.UNCERTAIN, self.g.State.PRIMARY, self.g.State.LIMITED):
            with self.subTest(state=state):
                gate = self.gate(state); prior = FakeProvider.attempts; client = self.client(gate)
                Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, self.Client)
                account = Account(); account.api = client; account.keep_alive()
                self.assertEqual(gate.state, state); self.assertEqual(FakeProvider.attempts, prior)
                self.assertEqual(FakeAccount.reauth, 0); self.assert_no_auth()
    def test_uncertain_otp_submission_still_forbidden(self):
        gate = self.gate(self.g.State.UNCERTAIN); calls = []
        result = gate.submit('request_challenge', lambda: calls.append(True), explicit_submission=True)
        self.assertEqual(result.reason, 'delivery_unknown'); self.assertEqual(calls, [])
        self.assertFalse(result.effect_attempted); self.assert_no_auth()
    def test_validation_unknown_exception_text_never_exported(self):
        gate = self.gate(); FakeProvider.failure = RuntimeError(SECRET)
        self.client(gate)
        self.assertNotIn(SECRET, str(self.saved)); self.assertEqual(gate.state, self.g.State.USER)
        self.assert_no_auth()

    def test_provider_reuse_catch_wrapped_timeout_is_transport_not_expiration(self):
        Provider = swallowing_provider()
        Client = self.b.service_adapter(Provider, transport_errors=(RequestConnectionError, RequestTimeout))
        wrapped = ProviderAPIError(SECRET); wrapped.__cause__ = RequestTimeout(SECRET)
        FakeProvider.failure = wrapped; gate = self.gate()
        with self.b.bind_gate(gate):
            with self.assertRaises(self.b.CachedSessionTransportError): Client()
        self.assertEqual(gate.state, self.g.State.PROBE)
        self.assertEqual(FakeProvider.attempts, 1); self.assert_no_auth()

    def test_provider_reuse_auth_error_still_expires_without_transport_heuristic(self):
        Provider = swallowing_provider()
        Client = self.b.service_adapter(Provider)
        FakeProvider.failure = ProviderAPIError('timeout is text only'); gate = self.gate()
        with self.b.bind_gate(gate): client = Client()
        self.assertEqual(gate.state, self.g.State.USER)
        self.assertEqual(FakeProvider.attempts, 1); self.assert_no_auth()

    def test_explicit_validation_preserves_original_wrapped_exception(self):
        Provider = swallowing_provider(); Client = self.b.service_adapter(Provider)
        gate = self.gate()
        with self.b.bind_gate(gate): client = Client()
        wrapped = ProviderAPIError(SECRET); wrapped.__cause__ = RequestTimeout(SECRET)
        FakeProvider.failure = wrapped
        with self.assertRaises(ProviderAPIError) as raised:
            client._manual(client._validate_token)
        self.assertIs(raised.exception, wrapped); self.assert_no_auth()

    def test_busy_gate_has_distinct_result_and_no_callback(self):
        gate = self.gate(); gate.busy = True; calls = []
        gate._lock.acquire()
        try:
            result = gate.cached_session(lambda: calls.append(True))
        finally:
            gate._lock.release(); gate.busy = False
        self.assertEqual(result.reason, 'operation_in_progress')
        self.assertFalse(result.effect_attempted); self.assertEqual(calls, [])
        self.assertEqual(self.saved, [])

    def test_concurrent_cached_validation_does_not_request_repair_or_repeat_api(self):
        Provider = swallowing_provider(); Client = self.b.service_adapter(Provider)
        gate = self.gate()
        with self.b.bind_gate(gate): client = Client()
        FakeProvider.attempts = 0
        Provider.enter = threading.Event(); Provider.release = threading.Event()
        failures = []
        def run():
            try: client.authenticate()
            except BaseException as exc: failures.append(exc)
        thread = threading.Thread(target=run, daemon=True); thread.start()
        try:
            self.assertTrue(Provider.enter.wait(2))
            self.assertTrue(gate.busy)
            with self.assertRaises(self.b.CachedSessionBusyError): client.authenticate()
            with self.assertRaises(self.b.CachedSessionBusyError): client.requires_2fa
            Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, Client)
            account = Account(); account.api = client
            with self.assertRaises(self.b.CachedSessionBusyError): account.setup()
            account.keep_alive()
            # Manual context does not inherit the new background busy exception.
            self.assertIsInstance(client._manual(lambda: client.requires_2fa), bool)
            self.assertEqual(FakeProvider.attempts, 1)
            self.assertEqual(FakeAccount.reauth, 0); self.assertEqual(FakeAccount.device_updates, 0)
        finally:
            Provider.release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(failures, [])
        self.assertEqual(gate.state, self.g.State.VALID)
        self.assertFalse(gate.busy); self.assertTrue(Provider.own_property_seen)
        self.assert_no_auth()


    def interleaving_gate(self):
        # Return a gate whose next state read starts a competing validation.
        # If the caller owns the lock, competitor reports busy. If it doesn't,
        # capture its transient USER before letting it finish: a deterministic
        # simulation of the old busy-read / state-read scheduling window.
        outer = self
        class InterleavingGate(outer.g.AuthGate):
            def __getattribute__(self, name):
                if name == 'state':
                    hook = object.__getattribute__(self, '__dict__').pop('_read_hook', None)
                    if hook is not None: return hook()
                return super().__getattribute__(name)
        gate = InterleavingGate(self.saved.append, {'schema_version': 1, 'state': self.g.State.VALID.value})
        results = []; callbacks = []; errors = []; threads = []
        def install():
            def hook():
                ready = threading.Event(); release = threading.Event(); done = threading.Event()
                def callback():
                    callbacks.append(True); ready.set()
                    if not release.wait(2): raise AssertionError('bounded_interleave_wait')
                    return outer.g.Outcome.TRANSPORT
                def compete():
                    try: results.append(gate.cached_session(callback))
                    except BaseException as exc: errors.append(exc)
                    finally: ready.set(); done.set()
                thread = threading.Thread(target=compete, daemon=True); threads.append(thread); thread.start()
                outer.assertTrue(ready.wait(2))
                captured = object.__getattribute__(gate, 'state')
                release.set(); outer.assertTrue(done.wait(2)); thread.join(2)
                outer.assertFalse(thread.is_alive())
                return captured
            gate._read_hook = hook
        return gate, install, results, callbacks, errors

    def test_cached_session_interleaving_never_reads_transient_user_unlocked(self):
        gate, install, results, callbacks, errors = self.interleaving_gate(); install()
        calls = []
        result = gate.cached_session(lambda: calls.append(True) or self.g.Outcome.VALID)
        self.assertEqual(result.state, self.g.State.VALID.value)
        self.assertEqual(calls, [True]); self.assertEqual(callbacks, []); self.assertEqual(errors, [])
        self.assertEqual([r.reason for r in results], ['operation_in_progress'])
        self.assertFalse(gate.busy)

    def test_requires_2fa_interleaving_uses_locked_snapshot(self):
        gate, install, results, callbacks, errors = self.interleaving_gate()
        client = self.client(gate); FakeProvider.attempts = 0; install()
        self.assertFalse(client.requires_2fa)
        self.assertEqual(callbacks, []); self.assertEqual(errors, [])
        self.assertEqual([r.reason for r in results], ['operation_in_progress'])
        self.assertEqual(FakeProvider.attempts, 0); self.assertEqual(FakeAccount.reauth, 0)
        self.assert_no_auth()

    def test_setup_interleaving_does_not_use_transient_user_branch(self):
        gate, install, results, callbacks, errors = self.interleaving_gate()
        Account = self.b.account_adapter(FakeAccount, {'synthetic': gate}, self.Client)
        account = Account(); install(); account.setup()
        self.assertEqual(FakeAccount.reauth, 0); self.assertEqual(FakeProvider.attempts, 1)
        self.assertEqual(callbacks, []); self.assertEqual(errors, [])
        self.assertEqual([r.reason for r in results], ['operation_in_progress'])
        self.assertEqual(gate.state, self.g.State.VALID); self.assert_no_auth()

    def test_snapshot_contention_does_not_persist_or_call_provider(self):
        gate = self.gate(self.g.State.VALID); gate._lock.acquire()
        try: result = gate.snapshot_state()
        finally: gate._lock.release()
        self.assertEqual(result.reason, 'operation_in_progress')
        self.assertFalse(result.effect_attempted); self.assertEqual(self.saved, [])
        self.assertEqual(FakeProvider.attempts, 0)


if __name__ == '__main__': unittest.main()
