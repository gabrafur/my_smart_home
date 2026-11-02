"""Prepared isolated tests only; no runtime, socket, credentials or Root calls.
Primary executor runs serially. This author did not run the suite.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
PUBLIC = Path('/mnt/data/docker/scripts/raspberry-mcp/nodered-admin-candidate')
for name, path in (
        ('engine', HERE / 'engine.py' if (HERE / 'engine.py').exists() else PUBLIC / 'engine.py'),
        ('fixed_transport', HERE / 'fixed_transport.py'),
        ('coordination', HERE / 'coordination.py' if (HERE / 'coordination.py').exists() else PUBLIC / 'coordination.py'),
        ('gateway', HERE / 'gateway.py')):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
E = sys.modules['engine']
C = sys.modules['coordination']
G = sys.modules['gateway']
OP = '1' * 32
SHA = 'a' * 64


def request(method, **args):
    if method == 'read':
        args.setdefault('node_id', None)
        args.setdefault('field', None)
    return {'name': 'nodered_admin_' + method, 'arguments': {'host': 'raspberry', **args}}


class NativeTests(unittest.TestCase):
    def test_public_errors_are_closed_codes_not_underlying_private_messages(self):
        self.assertEqual(G.safe_reason(ValueError('global_compare_swap_conflict')),'global_compare_swap_conflict')
        self.assertEqual(G.safe_reason(ValueError('PRIVATE_FIXTURE_PASSWORD_DO_NOT_EXPORT')),'nodered_admin_operation_unconfirmed')
        self.assertEqual(G.safe_reason(FileNotFoundError('/private/fixture')),'required_sealed_evidence_unavailable')

    def test_effect_review_cannot_authorize_device_tests_or_unknown_sensitive_effects(self):
        obj=object.__new__(C.RootCoordinator)
        self.assertTrue(obj.check_effect_review({}, {'effect_review':{'device_tests':[],'sensitive_effects':[],'startup_effects':[]}}))
        with self.assertRaisesRegex(ValueError,'device_testing_not'):obj.check_effect_review({}, {'effect_review':{'device_tests':['light'],'sensitive_effects':[],'startup_effects':[]}})
        with self.assertRaisesRegex(ValueError,'specific_owner_effect_confirmation_required'):obj.check_effect_review({}, {'effect_review':{'device_tests':[],'sensitive_effects':['gate'],'startup_effects':[]}})

    def test_policy_view_schema_is_closed_and_credential_free(self):
        G.validate_request(request('read',view='policy',operation_id=None,offset=0,expected_sha256=None,node_id=None,field=None))
        with self.assertRaises(ValueError):G.validate_request(request('read',view='policy',operation_id=OP,offset=0,expected_sha256=None,node_id=None,field=None))

    def test_bootstrap_and_coordinator_same_source_set(self):
        spec=importlib.util.spec_from_file_location('bootstrap_contract',HERE/'bootstrap.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.assertEqual(set(module.NAMES),set(C.SOURCES))

    def test_closed_protocol_rejects_host_paths_commands_extra_fields_and_invalid_ids(self):
        for item in (
            request('status', operation_id=OP, command='whoami'),
            request('status', operation_id='../file'),
            {'name': 'nodered_admin_status', 'arguments': {'host': 'other', 'operation_id': OP}},
            request('shell', command='id'),
            request('read', view='private_context', operation_id=None, offset=0, expected_sha256=None),
            request('read', view='runtime', operation_id=None, offset=True, expected_sha256=None),
            request('read', view='runtime', operation_id=None, offset=1, expected_sha256=None),
            request('rollback', operation_id=OP, rollback_operation_id=OP),
        ):
            with self.subTest(item=item):
                with self.assertRaises(ValueError):
                    G.validate_request(item)

    def test_protocol_accepts_opaque_revision_and_changed_read_schema(self):
        method, args = G.validate_request(request('prepare', operation_id=OP,
            expected_revision='opaque:rev/with symbols', expected_sha256=SHA,
            edits=[{'kind': 'patch', 'node_id': 'a', 'expected_node_sha256': SHA,
                    'set_fields': {'name': 'synthetic'}, 'unset_fields': []}]))
        self.assertEqual(method, 'prepare')
        G.validate_request(request('read', view='runtime', operation_id=None, offset=9999, expected_sha256=SHA))
        G.validate_request(request('read', view='plan_diff', operation_id=OP, offset=1048576, expected_sha256=SHA))

    def test_node_field_read_schema_is_closed_and_keeps_other_views_separate(self):
        good = request('read', view='node_field', operation_id=None, offset=0,
                       expected_sha256=None, node_id='f1', field='func')
        self.assertEqual(G.validate_request(good)[0], 'read')
        later = request('read', view='node_field', operation_id=None, offset=8192,
                        expected_sha256=SHA, node_id='f1', field='func')
        G.validate_request(later)
        for mutation in ({'operation_id': OP}, {'node_id': '../secrets'},
                         {'field': 'nested.path'}, {'field': '../password'},
                         {'node_id': None}, {'field': None}, {'offset': -1},
                         {'offset': 1}, {'extra': True}):
            bad = {'name': good['name'], 'arguments': {**good['arguments'], **mutation}}
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    G.validate_request(bad)
        for view, operation in (('runtime', None), ('plan_diff', OP)):
            bad = request('read', view=view, operation_id=operation, offset=0,
                          expected_sha256=None, node_id='f1', field='func')
            with self.assertRaises(ValueError):
                G.validate_request(bad)
        missing = {'name': 'nodered_admin_read', 'arguments': {
            'host': 'raspberry', 'view': 'runtime', 'operation_id': None,
            'offset': 0, 'expected_sha256': None}}
        with self.assertRaises(ValueError):
            G.validate_request(missing)

    def test_node_field_read_uses_read_auth_and_engine_projection_without_raw_fallback(self):
        seen = []
        class Engine:
            def _policy(self, **kwargs):
                seen.append(('policy', kwargs))
                return SHA
            def read_field(self, node, field, offset, expected):
                seen.append(('field', node, field, offset, expected))
                return {'source': 'reviewed_public_node_field', 'state': 'withheld',
                        'collection_error': 'no_reviewed_public_value_proof', 'fragment': None}
        class Transport:
            def login(self, write=False):
                seen.append(('login', write))
            def revoke(self):
                seen.append(('revoke',))
                return True
        class Sessions:
            def begin(self, method, operation):
                seen.append(('session', method, operation))
                return OP
            def finish(self, session, cleanup, confirmed):
                seen.append(('finish', cleanup, confirmed))
        gateway = G.Gateway(Engine(), object(), Transport(), Sessions())
        result = gateway.handle(request('read', view='node_field', operation_id=None,
            offset=8192, expected_sha256=SHA, node_id='f1', field='func'))
        self.assertIn(('login', False), seen)
        self.assertIn(('field', 'f1', 'func', 8192, SHA), seen)
        self.assertEqual(result['state'], 'withheld')
        self.assertIsNone(result['fragment'])
        self.assertTrue(result['session_revoked'])

    def test_node_field_read_forwards_only_engine_utf8_fragment_and_cas_reference(self):
        class Engine:
            def read_field(self, node, field, offset, expected):
                self.last = (node, field, offset, expected)
                return {'node_id': node, 'field': field, 'node_sha256': expected,
                        'fragment': 'á🙂', 'next_offset': offset + len('á🙂'.encode())}
        engine = Engine()
        gateway = G.Gateway(engine, object(), object())
        result = gateway._read({'view': 'node_field', 'operation_id': None,
            'offset': 0, 'expected_sha256': SHA, 'node_id': 'f1', 'field': 'func'})
        self.assertEqual(engine.last, ('f1', 'func', 0, SHA))
        self.assertEqual(result['fragment'], 'á🙂')
        self.assertEqual(result['next_offset'], 6)

    def test_duplicate_or_nonfinite_json_rejected(self):
        for body in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(ValueError):
                C.decode(body)

    def test_root_proofs_cannot_be_injected_in_mcp_arguments(self):
        with self.assertRaises(ValueError):
            G.validate_request(request('apply', operation_id=OP, plan_sha256=SHA,
                approval_id=OP, credentials_unchanged=True))
        with self.assertRaises(ValueError):
            G.validate_request(request('preflight', operation_id=OP, approval_id=OP,
                policy={'enabled': True}))

    def test_post_guard_refuses_attestation_older_than_actual_intent(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.engine_policy = {'host': 'raspberry'}
        coordinator.lock_lease_id = OP
        coordinator._native_guard_ready = lambda: True
        coordinator._lease_context = lambda: {}
        from types import SimpleNamespace
        coordinator._inline_guard = SimpleNamespace(produce_guard=lambda *args: None)
        plan = {'operation_id': OP, 'risk': {}, 'deleted_logically': []}
        proof = {'plan_sha256': E.digest(plan), 'policy_sha256': E.digest(coordinator.engine_policy),
                 'risk_sha256': E.digest({}), 'phase': 'after', 'observed_at': 99,
                 'lock_lease_id': OP, 'executing_pid': os.getpid(),
                 'credentials_unchanged': True, 'context_preservation_proven': True}
        coordinator._proof = lambda *args: proof
        old = C.sealed_json
        C.sealed_json = lambda path: {'plan_sha256': E.digest(plan), 'attempted_at': 100}
        try:
            with self.assertRaisesRegex(ValueError, 'post_guard_predates'):
                coordinator.guard(plan, phase='after')
            proof['observed_at'] = 100
            self.assertTrue(coordinator.guard(plan, phase='after')['credentials_unchanged'])
        finally:
            C.sealed_json = old

    def test_absent_native_post_guard_producer_blocks_before_guard_or_deploy(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.document = {'native_guard_producer': None}
        coordinator._proof = lambda *args: (_ for _ in ()).throw(AssertionError('must block before proof'))
        with self.assertRaisesRegex(ValueError, 'native_post_guard_producer_unavailable'):
            coordinator.guard({'operation_id': OP}, phase='before')

    def test_inline_factory_uses_sealed_source_pin_and_current_lock_context(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.document = {'native_guard_producer': {'mode': 'inline', 'source_sha256': SHA},
                                'sources': {'native_guard.py': SHA}, 'shared_locks': {}}
        coordinator._inline_guard = None
        coordinator.locked = True
        coordinator.lock_lease_id = OP
        coordinator.locks_acquired_at = 999.
        coordinator._held_lock_fds = (11, 12, 13, 14, 15)
        calls = []
        class Inline:
            def ready(inner, context):
                calls.append(context)
                return True
        coordinator._make_native_guard = lambda expected: Inline() if expected == SHA else None
        self.assertTrue(coordinator._native_guard_ready())
        self.assertEqual(calls[0]['lock_fds'], (11, 12, 13, 14, 15))
        self.assertEqual(calls[0]['executing_pid'], os.getpid())
        self.assertEqual(calls[0]['lock_lease_id'], OP)
        coordinator.document['native_guard_producer']['source_sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'native_guard_producer_policy_pin_changed'):
            coordinator._native_guard_ready()

    def test_caller_ready_boolean_cannot_replace_inline_source_pin(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.document = {'native_guard_producer': {'mode': 'inline', 'ready': True},
                                'sources': {'native_guard.py': SHA}}
        with self.assertRaisesRegex(ValueError, 'native_guard_producer_policy_pin_changed'):
            coordinator._native_guard_ready()

    def test_attestation_policy_hash_expiry_and_producer_are_mandatory(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.engine_policy = {'expires_at': 2000}
        coordinator.root_policy_sha256 = SHA
        coordinator.locked = True
        coordinator.clock = lambda: 1000
        coordinator._unchanged = lambda: None
        value = {'root_policy_sha256': SHA, 'operation_id': OP, 'producer': 'sealed_nodered_admin_validator',
                 'observed_at': 999, 'expires_at': 1100}
        old = C.sealed_json
        C.sealed_json = lambda path: value
        try:
            self.assertEqual(coordinator._proof(OP, 'validation.json', 5), value)
            for key, bad in (('root_policy_sha256', 'b' * 64), ('expires_at', 999),
                             ('observed_at', 900), ('producer', 'client_assertion')):
                original = value[key]
                value[key] = bad
                with self.assertRaises(ValueError):
                    coordinator._proof(OP, 'validation.json', 5)
                value[key] = original
        finally:
            C.sealed_json = old

    def test_fresh_coordination_proof_from_old_lock_lease_is_refused(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.root_policy_sha256 = SHA
        coordinator.locked = True
        coordinator.lock_lease_id = OP
        coordinator.locks_acquired_at = 999.
        coordinator.clock = lambda: 1000.
        binding = {'operation_id': OP, 'plan_sha256': SHA}
        proof = {'root_policy_sha256': SHA, 'plan_sha256': SHA,
                 'lock_lease_id': '2' * 32, 'executing_pid': os.getpid(),
                 'producer': 'sealed_nodered_admin_validator',
                 'ledgers_checked_under_inherited_shared_locks': True,
                 'global_no_unrelated_busy_or_uncertain_work': True,
                 'observed_at': 999.9}
        old = C.sealed_json
        C.sealed_json = lambda path: proof
        try:
            with self.assertRaisesRegex(ValueError, 'cross_catalogue_coordination'):
                coordinator._coordination_proof(binding)
            proof['lock_lease_id'] = OP
            self.assertTrue(coordinator._coordination_proof(binding))
        finally:
            C.sealed_json = old

    def test_exact_root_public_catalogue_and_review_artifact_enable_only_matching_value(self):
        import hashlib
        source = b'synthetic pinned public validator source'
        source_sha = hashlib.sha256(source).hexdigest()
        value = 'return msg;'
        value_sha = E.digest(value)
        review = {'schema_version': 1, 'root_policy_sha256': SHA,
            'producer': 'sealed_nodered_admin_public_source_validator',
            'producer_source_sha256': source_sha, 'review_id': OP,
            'observed_at': 999, 'expires_at': 1100,
            'git_commit': 'b' * 40, 'git_blob': 'c' * 40,
            'public_artifact_sha256': 'd' * 64,
            'field_value_sha256': value_sha, 'public_source_review_passed': True}
        review_raw = E.raw(review)
        evidence = {k: review[k] for k in ('git_commit', 'git_blob',
                    'public_artifact_sha256', 'field_value_sha256', 'public_source_review_passed')}
        evidence.update(public_review_id=OP,
                        reviewed_artifact_sha256=hashlib.sha256(review_raw).hexdigest())
        catalogue = {'schema_version': 1, 'root_policy_sha256': SHA,
            'producer': review['producer'], 'producer_source_sha256': source_sha,
            'observed_at': 999, 'expires_at': 1100,
            'entries': [{'node_id': 'f', 'field': 'func', 'value_sha256': value_sha,
                         'value': value, 'evidence': evidence}]}
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.document = {'native_guard_producer': {
            'public_source_catalog_producer': {'source_sha256': source_sha}}}
        coordinator.root_policy_sha256 = SHA
        coordinator.engine_policy = {'expires_at': 2000}
        coordinator.locked = True
        coordinator.lock_lease_id = OP
        coordinator.clock = lambda: 1000
        coordinator._unchanged = lambda: None
        coordinator._native_guard_ready = lambda: True
        reads = {'public_source_validator.py': source,
                 'public-source-catalog.json': E.raw(catalogue), OP + '.json': review_raw}
        old = C.checked_read
        C.checked_read = lambda path, *args: reads[path.name]
        try:
            projected = coordinator.project_value('f', 'func', value)
            self.assertEqual(projected['source'], 'exact_reviewed_public_source')
            self.assertEqual(projected['value'], value)
            self.assertIsNone(coordinator.project_value('f', 'func', 'private runtime text'))
            # Even a matching catalogue row does not authorize a missing/tampered
            # reviewed Root artifact, or transfer proof to another node.
            self.assertIsNone(coordinator.project_value('other', 'func', value))
            reads[OP + '.json'] = b'{"tampered":true}'
            self.assertIsNone(coordinator.project_value('f', 'func', value))
        finally:
            C.checked_read = old

    def test_missing_public_source_proof_stays_withheld_without_breaking_metadata(self):
        coordinator = object.__new__(C.RootCoordinator)
        coordinator.document = {'native_guard_producer': {}}
        coordinator.locked = True
        coordinator.lock_lease_id = OP
        coordinator._unchanged = lambda: None
        coordinator._native_guard_ready = lambda: True
        self.assertIsNone(coordinator.project_value('f', 'func', 'PRIVATE'))
        self.assertEqual(coordinator._catalog_values, {})

    def test_plain_directory_read_rejects_symlink_without_reading_contents(self):
        # A fixed nonexistent symlink cannot be mistaken for a Root proof.
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'link').symlink_to('/dev/null')
            with self.assertRaises((ValueError, OSError)):
                C.checked_read(root / 'link')

    def test_root_source_and_lock_tuples_are_fixed(self):
        self.assertEqual(len(C.LOCKS), 5)
        self.assertEqual(len(set(C.LOCKS)), 5)
        self.assertTrue(all(path.startswith(('/tmp/', '/mnt/data/docker/', '/var/lib/raspberry-')) for path in C.LOCKS))
        self.assertEqual(set(C.SOURCES), {'engine.py', 'coordination.py', 'gateway.py', 'fixed_transport.py', 'bootstrap.py', 'native_guard.py'})

    def test_gateway_status_and_revoke_never_authenticate(self):
        class Coord:
            @contextlib.contextmanager
            def locks(self):
                yield
            def revoke(self, operation):
                return {'state': 'revoked', 'operation_id': operation}
        class Engine:
            def status(self, operation):
                return {'state': 'uncertain', 'operation_id': operation}
        class NoAuth:
            def login(self, **kwargs):
                raise AssertionError('authentication forbidden')
        gateway = G.Gateway(Engine(), Coord(), NoAuth())
        self.assertEqual(gateway.handle(request('status', operation_id=OP))['state'], 'uncertain')
        self.assertEqual(gateway.handle(request('revoke', operation_id=OP))['state'], 'revoked')

    def test_auth_response_loss_is_not_misreported_as_revoked(self):
        class Engine:
            def _policy(self, **kwargs):
                return SHA
        class Auth:
            def login(self, **kwargs):
                raise TimeoutError('SECRET MUST NOT BE EXPORTED')
            def revoke(self):
                return True  # token=None is NOT cleanup proof after lost login.
        class Sessions:
            def begin(self, *args):
                return OP
            def finish(self, session, cleanup, confirmed):
                self.proof = (session, cleanup, confirmed)
        sessions = Sessions()
        gateway = G.Gateway(Engine(), object(), Auth(), sessions)
        with self.assertRaises(TimeoutError):
            gateway.handle(request('read', view='runtime', operation_id=None, offset=0, expected_sha256=None))
        self.assertEqual(sessions.proof, (OP, False, False))

    def test_exact_pinned_transport_peer_refusal_closes_auth_as_not_dispatched(self):
        class Engine:
            def _policy(self, **kwargs):return SHA
        class Sessions:
            def begin(self,*args):return OP
            def finish(self,session,cleanup,confirmed):self.proof=(cleanup,confirmed)
        class NoNetwork:
            def __init__(self,*args,**kwargs):raise AssertionError('network constructor forbidden')
        wrapper=G.CredentialSessionTransport(object())
        wrapper.client=G.FixedTransport({'host':'192.0.2.8','port':1880,
            'username':'fixture','password':'FIXTURE_SECRET'},lambda:False,NoNetwork)
        sessions=Sessions()
        old=G.CredentialSessionTransport.login
        G.CredentialSessionTransport.login=lambda self,write=False:self.client.login(write=write)
        try:
            handler=G.Gateway(Engine(),object(),wrapper,sessions)
            with self.assertRaises(ValueError):
                handler.handle(request('read',view='runtime',operation_id=None,offset=0,expected_sha256=None))
            self.assertEqual(sessions.proof,(True,False))
        finally:G.CredentialSessionTransport.login=old

    def test_auth_dispatch_snapshot_survives_revoke_clearing_private_client(self):
        class Engine:
            def _policy(self,**kwargs):return SHA
        class Sessions:
            def begin(self,*args):return OP
            def finish(self,session,cleanup,confirmed):self.proof=(cleanup,confirmed)
        class LostRequest:
            def __init__(self,*args,**kwargs):pass
            def request(self,*args,**kwargs):raise OSError('synthetic request outcome unknown')
            def close(self):pass
        wrapper=G.CredentialSessionTransport(object())
        wrapper.client=G.FixedTransport({'host':'192.0.2.8','port':1880,
            'username':'fixture','password':'FIXTURE_SECRET'},lambda:True,LostRequest)
        sessions=Sessions()
        old=G.CredentialSessionTransport.login
        G.CredentialSessionTransport.login=lambda self,write=False:self.client.login(write=write)
        try:
            handler=G.Gateway(Engine(),object(),wrapper,sessions)
            with self.assertRaisesRegex(ValueError,'transport_outcome_unknown'):
                handler.handle(request('read',view='runtime',operation_id=None,offset=0,expected_sha256=None))
            self.assertIsNone(wrapper.client)  # revoke cleared it after snapshot.
            self.assertEqual(sessions.proof,(False,False))
        finally:G.CredentialSessionTransport.login=old

    def test_generic_adapter_no_dispatch_boolean_is_not_authority(self):
        class Engine:
            def _policy(self,**kwargs):return SHA
        class Forged:
            login_dispatch_attempted=False
            def login(self,**kwargs):raise TimeoutError('unknown generic outcome')
            def revoke(self):return True
        class Sessions:
            def begin(self,*args):return OP
            def finish(self,session,cleanup,confirmed):self.proof=(cleanup,confirmed)
        sessions=Sessions()
        with self.assertRaises(TimeoutError):
            G.Gateway(Engine(),object(),Forged(),sessions).handle(request('read',view='runtime',
                operation_id=None,offset=0,expected_sha256=None))
        self.assertEqual(sessions.proof,(False,False))

    def test_runtime_page_is_at_most16_and_requires_exact_snapshot(self):
        class Engine:
            def read(self):
                return {'sha256': SHA, 'nodes': [
                    {'id': str(i), 'type': 'debug', 'sha256': SHA, 'fields': {'name': {'sha256': SHA}}}
                    for i in range(40)]}
        gateway = G.Gateway(Engine(), object(), object())
        first = gateway._read({'view': 'runtime', 'operation_id': None, 'offset': 0, 'expected_sha256': None})
        self.assertEqual(len(first['nodes']), 16)
        self.assertEqual(first['next_offset'], 16)
        second = gateway._read({'view': 'runtime', 'operation_id': None, 'offset': 16, 'expected_sha256': SHA})
        self.assertEqual(second['next_offset'], 32)
        with self.assertRaisesRegex(ValueError, 'runtime_snapshot_changed'):
            gateway._read({'view': 'runtime', 'operation_id': None, 'offset': 16, 'expected_sha256': 'b' * 64})

    def test_plan_diff_fragments_reassemble_utf8_without_private_beforeimage(self):
        plan = E.build_plan(OP, {'rev': 'opaque', 'flows': [
            {'id': 't', 'type': 'tab'}, {'id': 'f', 'type': 'function', 'z': 't', 'func': 'PRIVATE BASELINE'}]},
            [{'kind': 'patch', 'node_id': 'f', 'expected_node_sha256': E.digest(
                {'id': 'f', 'type': 'function', 'z': 't', 'func': 'PRIVATE BASELINE'}),
              'set_fields': {'func': 'return msg;'}, 'unset_fields': []}], SHA, 1000)
        # Replace the already-sanitized diff text with reviewed synthetic Unicode
        # to exercise byte offsets. Private raw snapshots remain unrelated.
        plan['diff'][0]['fields'][0]['diff'] = 'áçã🙂' * 4000
        class Store:
            def read(self, operation, name):
                return plan
        class Engine:
            journal = Store()
        gateway = G.Gateway(Engine(), object(), object())
        offset, parts = 0, []
        while True:
            page = gateway._read({'view': 'plan_diff', 'operation_id': OP, 'offset': offset,
                                  'expected_sha256': E.digest(plan) if offset else None})
            self.assertLessEqual(len(page['fragment'].encode()), 8192)
            self.assertNotIn('PRIVATE BASELINE', page['fragment'])
            parts.append(page['fragment'])
            if page['next_offset'] is None:
                break
            offset = page['next_offset']
        self.assertEqual(''.join(parts).encode(), E.raw(plan['diff']))


if __name__ == '__main__':
    unittest.main()
