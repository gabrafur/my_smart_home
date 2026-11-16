"""Own-session cleanup: bounded shared-lock waits, a separate cleanup reserve
and sanitized cleanup evidence.

Synthetic only: temp lock files, a loopback HTTP stand-in for the fixed
Node-RED routes and temp session/evidence directories. No Root, credentials,
native state, Node-RED, MCP or household effects.
"""
import contextlib, http.server, importlib.util, json, os, stat, subprocess, sys
import tempfile, threading, time, types, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
for name in ('engine', 'fixed_transport', 'coordination', 'gateway'):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
T, C, G = sys.modules['fixed_transport'], sys.modules['coordination'], sys.modules['gateway']
RECEIPT_KEYS = frozenset({'source', 'root_policy_sha256', 'session_id', 'security_cleanup_confirmed',
                          'login_confirmed', 'login_dispatch_attempted', 'cleanup_basis',
                          'observed_at', 'automatic_retry'})


class EvidenceReasonTests(unittest.TestCase):
    def test_identifier_shaped_private_text_stays_generic(self):
        result = G.evidence_reason(ValueError('sensitive_token_value'))
        self.assertEqual(result['reason'], 'nodered_admin_operation_unconfirmed')
        self.assertNotIn('sensitive_token_value', json.dumps(result))

    def test_fixed_reviewed_reason_is_preserved(self):
        self.assertEqual(G.evidence_reason(ValueError('configuration_unconfirmed'))['reason'],
                         'configuration_unconfirmed')


class Backend:
    """Local stand-in for Node-RED's three fixed routes."""
    def __init__(self):
        self.revoke_mode = 'ok'
        self.counts = {}
        self.lock = threading.Lock()
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _reply(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                with outer.lock: outer.counts[self.path] = outer.counts.get(self.path, 0) + 1
                self._reply(200, {'rev': 'r1', 'flows': []})

            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                with outer.lock: outer.counts[self.path] = outer.counts.get(self.path, 0) + 1
                if self.path == '/auth/token':
                    return self._reply(200, {'access_token': 'synthetic-token'})
                mode = outer.revoke_mode
                if mode == 'ok':
                    return self._reply(200, {})
                if mode == '401':
                    return self._reply(401, {})
                if mode == 'close':
                    self.connection.shutdown(2); return
                if mode == 'hang':
                    time.sleep(2.0); return
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


def holder(path, seconds):
    process = subprocess.Popen([sys.executable, '-c',
        'import fcntl,os,sys,time;fd=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX);'
        'print("held",flush=True);time.sleep(float(sys.argv[2]))', path, str(seconds)], stdout=subprocess.PIPE)
    assert process.stdout.readline().strip() == b'held'
    return process


class Coordinator:
    """Fake coordinator with the REAL locks()/peer_check() bound from a module."""
    def __init__(self, module, paths, guard_delay=0.2):
        self.locked = False
        self.current_session = None
        self.root_policy_sha256 = 'a' * 64
        self.clock = time.time
        self.document = {'shared_locks': {}, 'backend': {'host': '192.0.2.9', 'username': 'u'}}
        for p in paths:
            i = os.stat(p)
            self.document['shared_locks'][p] = [i.st_dev, i.st_ino, i.st_uid, i.st_gid, stat.S_IMODE(i.st_mode)]
        self.locks = types.MethodType(module.RootCoordinator.locks, self)
        self.peer_check = types.MethodType(module.RootCoordinator.peer_check, self)
        self.guard_delay = guard_delay
        self.guard_calls = 0
        self.fail_guard_from = None
        self.transient_at = None
        self.unlocked_guard_calls = 0
        self.max_concurrent = 0

    def _unchanged(self): pass
    def revoked(self): return False

    def _peer_check_locked(self):
        self.guard_calls += 1
        if not self.locked:
            self.unlocked_guard_calls += 1
        time.sleep(self.guard_delay)
        if self.transient_at == self.guard_calls:
            raise ValueError('transient_process_unavailable')
        if self.fail_guard_from is not None and self.guard_calls >= self.fail_guard_from:
            raise ValueError('return_peer_identity_unconfirmed')
        return True


class Engine:
    """Minimal engine: one locked fetch, then an optional hook (contention)."""
    def __init__(self, coordinator, transport, after=None, fail=None):
        self.c, self.t, self.after, self.fail = coordinator, transport, after, fail
    def _policy(self, effect=False): pass
    def verify(self, operation_id):
        with self.c.locks():
            self.t.fetch()
        if self.after: self.after()
        if self.fail: raise ValueError(self.fail)
        return {'state': 'verified', 'operation_id': operation_id}


def read_json(path):
    with open(path) as stream:
        return json.load(stream)


def read_text(path):
    with open(path) as stream:
        return stream.read()


def writer(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(json.dumps(value, sort_keys=True) + '\n')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = []
        for i in range(5):
            p = os.path.join(self.tmp.name, 'lock%d' % i); open(p, 'w').close(); os.chmod(p, 0o600)
            self.paths.append(p)
        self.sessions = os.path.join(self.tmp.name, 'sessions'); os.mkdir(self.sessions, 0o700)
        self.evidence = os.path.join(self.tmp.name, 'session-cleanup-evidence')
        self.block = os.path.join(self.tmp.name, 'session-unconfirmed.json')
        self.saved = []
        self.patch(C, 'LOCKS', tuple(self.paths))
        self.patch(C, 'PROCESS_STARTED', time.monotonic())  # one fresh transaction process
        self.patch(G, 'SESSIONS', Path(self.sessions))
        self.patch(G, 'CLEANUP_BLOCK', Path(self.block))
        self.patch(G, 'atomic_create', writer)
        self.patch(G, 'CLEANUP_EVIDENCE', Path(self.evidence))
        self.backend = Backend()
        self.procs = []

    def patch(self, module, name, value):
        self.saved.append((module, name, getattr(module, name)))
        setattr(module, name, value)

    def tearDown(self):
        for p in self.procs: p.kill(); p.wait(); p.stdout.close()
        for module, name, value in reversed(self.saved): setattr(module, name, value)
        self.backend.close(); self.tmp.cleanup()

    def transport(self, c, timeout=12):
        t = G.CredentialSessionTransport(c)
        port = self.backend.port
        class Redirect(G.ObservedConnection):
            def __init__(self, host, _port, _timeout, observer):
                super().__init__('127.0.0.1', port, timeout, observer)
        def login(write=False):
            t.client = T.FixedTransport({'host': '192.0.2.9', 'port': 1880, 'username': 'u', 'password': 'p'},
                                        c.peer_check, connection=lambda h, p, timeout=None: Redirect(h, p, timeout, t._http))
            t.client.login(write=write)
            t.token_received = True
        t.login = login  # instance attribute; type(t) stays CredentialSessionTransport
        return t

    def run_once(self, after=None, fail=None, timeout=12, coordinator=None):
        c = coordinator or Coordinator(C, self.paths)
        t = self.transport(c, timeout)
        gw = G.Gateway(Engine(c, t, after, fail), c, t, G.RootSessionJournal(c))
        error = None
        try:
            result = gw.handle({'name': 'nodered_admin_verify', 'arguments': {'host': 'raspberry', 'operation_id': 'b' * 32}})
        except Exception as caught:
            result, error = None, caught
        receipts = [f for f in os.listdir(self.sessions) if f.endswith('.receipt.json')]
        self.assertEqual(len(receipts), 1)
        receipt = read_json(os.path.join(self.sessions, receipts[0]))
        session = receipts[0][:-len('.receipt.json')]
        evidence_path = os.path.join(self.evidence, session + '.json')
        evidence = read_json(evidence_path) if os.path.exists(evidence_path) else None
        for name in os.listdir(self.sessions): os.unlink(os.path.join(self.sessions, name))
        return result, error, receipt, evidence, c

    def hold_after_fetch(self, seconds, index=1):
        return lambda: self.procs.append(holder(self.paths[index], seconds))


class Success(Base):
    def test_success_confirmed_with_evidence_and_unchanged_receipt_schema(self):
        result, error, receipt, ev, c = self.run_once()
        self.assertIsNone(error)
        self.assertTrue(result['security_cleanup_confirmed'])
        self.assertEqual(set(receipt), RECEIPT_KEYS)
        self.assertEqual(receipt['cleanup_basis'], 'authenticated_session_revoked')
        self.assertEqual(ev['revoke'], {'stage': 'revoked_confirmed', 'http_status': 200})
        self.assertEqual(self.backend.counts.get('/auth/revoke'), 1)
        self.assertEqual(c.unlocked_guard_calls, 0)
        self.assertFalse(os.path.exists(self.block))


class Recurrence(Base):
    def test_cleanup_waits_for_minute_start_holder_and_confirms(self):
        _, _, receipt, ev, _ = self.run_once(after=self.hold_after_fetch(1.5))
        self.assertTrue(receipt['security_cleanup_confirmed'])
        self.assertGreater(ev['cleanup_lock_wait_seconds'], 1.0)
        self.assertEqual(self.backend.counts.get('/auth/revoke'), 1)

    def test_cleanup_reserve_independent_of_exhausted_transaction_budget(self):
        c = Coordinator(C, self.paths)
        def exhaust():
            c._lock_wait_spent = C.LOCK_WAIT_TOTAL_SECONDS
            self.procs.append(holder(self.paths[1], 1.0))
        _, _, receipt, ev, _ = self.run_once(after=exhaust, coordinator=c)
        self.assertTrue(receipt['security_cleanup_confirmed'])
        self.assertEqual(ev['revoke']['stage'], 'revoked_confirmed')

    def test_ordinary_locks_wait_bounded_then_refuse(self):
        self.patch(C, 'LOCK_WAIT_SECONDS', 0.3)
        self.procs.append(holder(self.paths[2], 2.0))
        c = Coordinator(C, self.paths)
        start = time.monotonic()
        with self.assertRaises(BlockingIOError):
            with c.locks(): pass
        self.assertLess(time.monotonic() - start, 1.5)
        self.assertFalse(c.locked)


class PreDispatchRefusal(Base):
    def test_lock_never_free_records_refused_before_dispatch(self):
        self.patch(C, 'CLEANUP_LOCK_WAIT_SECONDS', 0.5)
        _, _, receipt, ev, _ = self.run_once(after=self.hold_after_fetch(3.0))
        self.assertFalse(receipt['security_cleanup_confirmed'])
        self.assertEqual(receipt['cleanup_basis'], 'unconfirmed')
        self.assertEqual(ev['revoke'], {'stage': 'refused_before_dispatch', 'http_status': None})
        self.assertEqual(ev['cleanup_lock_error'], {'reason': 'shared_lock_busy', 'exception_kind': 'BlockingIOError'})
        self.assertIsNone(self.backend.counts.get('/auth/revoke'))
        self.assertTrue(os.path.exists(self.block))

    def test_process_deadline_caps_cleanup_wait(self):
        C.PROCESS_STARTED = time.monotonic() - C.CLEANUP_LOCK_DEADLINE_SECONDS
        start = time.monotonic()
        _, _, receipt, ev, _ = self.run_once(after=self.hold_after_fetch(3.0))
        self.assertLess(time.monotonic() - start, 2.5)
        self.assertEqual(ev['revoke']['stage'], 'refused_before_dispatch')
        self.assertFalse(receipt['security_cleanup_confirmed'])

    def test_peer_verification_failure_before_revoke_is_pre_dispatch(self):
        c = Coordinator(C, self.paths)
        def fail_next(): c.fail_guard_from = c.guard_calls + 1
        _, _, receipt, ev, _ = self.run_once(after=fail_next, coordinator=c)
        self.assertFalse(receipt['security_cleanup_confirmed'])
        self.assertEqual(ev['revoke']['stage'], 'refused_before_dispatch')
        self.assertIsNone(self.backend.counts.get('/auth/revoke'))


class Uncertain(Base):
    def test_timeout_after_dispatch_is_uncertain_and_not_retried(self):
        self.backend.revoke_mode = 'hang'
        _, _, receipt, ev, _ = self.run_once(timeout=0.5)
        self.assertFalse(receipt['security_cleanup_confirmed'])
        self.assertEqual(ev['revoke'], {'stage': 'dispatch_outcome_unconfirmed', 'http_status': None})
        self.assertEqual(self.backend.counts.get('/auth/revoke'), 1)

    def test_connection_dropped_is_uncertain(self):
        self.backend.revoke_mode = 'close'
        _, _, receipt, ev, _ = self.run_once()
        self.assertEqual(ev['revoke']['stage'], 'dispatch_outcome_unconfirmed')
        self.assertEqual(self.backend.counts.get('/auth/revoke'), 1)

    def test_backend_refusal_is_proven_failure(self):
        self.backend.revoke_mode = '401'
        _, _, receipt, ev, _ = self.run_once()
        self.assertEqual(ev['revoke'], {'stage': 'backend_refused', 'http_status': 401})
        self.assertFalse(receipt['security_cleanup_confirmed'])

    def test_existing_block_preserved(self):
        writer(self.block, {'session_id': 'c' * 32, 'source': 'own_nodered_admin_session_cleanup'})
        before = read_text(self.block)
        self.backend.revoke_mode = 'close'
        _, _, receipt, _, _ = self.run_once()
        self.assertEqual(read_text(self.block), before)
        self.assertEqual(set(receipt), RECEIPT_KEYS)


class PartialAndConcurrency(Base):
    def test_operation_failure_still_cleans_up_and_keeps_sanitized_cause(self):
        _, error, receipt, ev, _ = self.run_once(fail='configuration_unconfirmed')
        self.assertIsInstance(error, ValueError)
        self.assertTrue(receipt['security_cleanup_confirmed'])
        self.assertEqual(ev['operation_error'], {'reason': 'configuration_unconfirmed', 'exception_kind': 'ValueError'})

    def test_unsafe_messages_are_not_persisted(self):
        _, _, _, ev, _ = self.run_once(fail='Token abc/def leaked: /run/x')
        self.assertEqual(ev['operation_error']['reason'], 'nodered_admin_operation_unconfirmed')
        self.assertNotIn('abc', json.dumps(ev))

    def test_evidence_failure_never_blocks_receipt(self):
        self.patch(G, 'write_cleanup_evidence', lambda *a: (_ for _ in ()).throw(OSError('disk')))
        _, _, receipt, ev, _ = self.run_once()
        self.assertTrue(receipt['security_cleanup_confirmed'])
        self.assertIsNone(ev)

    def test_refused_login_takes_no_cleanup_locks(self):
        c = Coordinator(C, self.paths)
        calls = []
        original = c.locks
        def spy(cleanup=False):
            calls.append(cleanup); return original(cleanup=cleanup)
        c.locks = spy
        c.fail_guard_from = 1
        _, _, receipt, ev, _ = self.run_once(coordinator=c)
        self.assertNotIn(True, calls)
        self.assertEqual(receipt['cleanup_basis'], 'sealed_transport_no_auth_dispatch')
        self.assertEqual(ev['revoke']['stage'], 'no_token')

    def test_concurrent_transactions_exclusive_and_all_confirmed(self):
        state = {'inside': 0, 'max': 0}
        guard = threading.Lock()
        original = C.RootCoordinator.locks
        @contextlib.contextmanager
        def counted(self, cleanup=False):
            with original(self, cleanup=cleanup):
                with guard:
                    state['inside'] += 1; state['max'] = max(state['max'], state['inside'])
                try:
                    time.sleep(0.05); yield
                finally:
                    with guard: state['inside'] -= 1
        self.patch(C.RootCoordinator, 'locks', counted)
        results = []
        def one():
            c = Coordinator(C, self.paths)
            t = self.transport(c)
            results.append(G.Gateway(Engine(c, t), c, t, G.RootSessionJournal(c)).handle(
                {'name': 'nodered_admin_verify', 'arguments': {'host': 'raspberry', 'operation_id': 'd' * 32}}))
        threads = [threading.Thread(target=one) for _ in range(3)]
        for th in threads: th.start()
        for th in threads: th.join(60)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r['security_cleanup_confirmed'] for r in results))
        self.assertEqual(state['max'], 1)
        self.assertEqual(self.backend.counts.get('/auth/revoke'), 3)


class Budget(unittest.TestCase):
    def test_cleanup_reserve_fits_runtime_max(self):
        # Installed transport: passive peer precheck deadline 10 s, request timeout 12 s.
        source = (HERE / 'fixed_transport.py').read_text()
        self.assertIn('deadline=time.monotonic()+10', source)
        self.assertIn('timeout=12)', source)
        self.assertLessEqual(C.CLEANUP_LOCK_DEADLINE_SECONDS + 10.0 + 12.0 + 2.0, 45)
        self.assertLessEqual(C.CLEANUP_LOCK_WAIT_SECONDS, C.CLEANUP_LOCK_DEADLINE_SECONDS)
        self.assertEqual((C.LOCK_WAIT_SECONDS, C.LOCK_WAIT_TOTAL_SECONDS), (8.0, 12.0))

    def test_lock_mode_is_closed(self):
        with self.assertRaises(ValueError):
            with C.RootCoordinator.locks(types.SimpleNamespace(locked=False), cleanup=1): pass


if __name__ == '__main__':
    unittest.main()
