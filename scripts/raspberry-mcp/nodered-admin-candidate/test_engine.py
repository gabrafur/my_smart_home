"""Synthetic adapters only. Never opens runtime/network/credential paths.

Prepared for the primary executor to run serially; author did not run tests.
"""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate_nodered_admin_engine', HERE / 'engine.py')
E = importlib.util.module_from_spec(spec)
spec.loader.exec_module(E)
OP = '1' * 32
SECOND = '2' * 32
ROLLBACK = '3' * 32
APPROVAL = 'a' * 32
FLOWS = [
    {'id': 'tab1', 'type': 'tab', 'label': 'synthetic'},
    {'id': 'f1', 'type': 'function', 'z': 'tab1', 'func': 'return msg;', 'wires': [['d1']]},
    {'id': 'd1', 'type': 'debug', 'z': 'tab1', 'name': 'unchanged', 'wires': []},
]


class Transport:
    def __init__(self):
        self.current = {'rev': 'opaque revision:1/not-a-hash', 'flows': copy.deepcopy(FLOWS)}
        self.calls = []
        self.fail = False
        self.conflict = False
        self.verify_fail = False

    def fetch(self):
        if self.verify_fail and self.calls:
            raise TimeoutError('PRIVATE ERROR SHOULD NOT LEAK')
        return copy.deepcopy(self.current)

    def deploy(self, rev, flows):
        self.calls.append((rev, copy.deepcopy(flows)))
        if self.fail:
            raise TimeoutError('PRIVATE ERROR SHOULD NOT LEAK')
        if self.conflict:
            return {'state': 'conflict', 'effect_proven_absent': True}
        if rev != self.current['rev']:
            return {'state': 'conflict', 'effect_proven_absent': True}
        self.current = {'rev': 'opaque revision:' + str(len(self.calls) + 1), 'flows': copy.deepcopy(flows)}
        return {'state': 'accepted', 'rev': self.current['rev']}


class Coordinator:
    def __init__(self, clock):
        self.clock = clock
        self.is_revoked = False
        self.approved = True
        self.valid = True
        self.guarded = True
        self.post_guarded = True
        self.locked = False
        self.force_busy = False
        self.logical_restore = True

    @contextlib.contextmanager
    def locks(self):
        if self.force_busy or self.locked:
            raise ValueError('shared_lock_busy')
        self.locked = True
        try:
            yield
        finally:
            self.locked = False

    def revoked(self):
        return self.is_revoked

    def validate(self, plan):
        return {'plan_sha256': E.digest(plan), **{k: self.valid for k in
            ('syntax', 'graph', 'layout', 'observability', 'isolated_regression',
             'installed_node_types', 'canonical_sources_reconciled')}}

    def admit(self, binding, approval_id):
        return {**binding, 'approval_id': approval_id,
                'policy_activation_confirmed': self.approved,
                'interface_confirmation_preserved': True,
                'reviewed_startup_and_sensitive_effects': self.approved,
                'resources_available': True, 'shared_locks_held': self.locked,
                'expires_at': self.clock() + 200}

    def guard(self, plan, phase='before'):
        valid = self.guarded and (phase != 'after' or self.post_guarded)
        return {'plan_sha256': E.digest(plan), 'phase': phase, 'credentials_unchanged': valid,
                'context_preservation_proven': valid,
                'logical_delete_restore_isolated_proven': self.logical_restore}


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / 'journal'
        self.state.mkdir(mode=0o700)
        self.now = 1000.
        self.clock = lambda: self.now
        self.policy = {'enabled': True, 'activation_confirmed': True, 'host': 'raspberry',
                       'project': '/mnt/data/docker', 'expires_at': 100000.,
                       'maximum_deploys_per_24h': 4, 'minimum_deploy_spacing_seconds': 60,
                       'maximum_plan_age_seconds': 900}
        self.transport = Transport()
        self.coord = Coordinator(self.clock)
        self.store = E.Journal(self.state)
        self.engine = E.Engine(self.policy, self.transport, self.store, self.coord, self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def test_runtime_projection_only_requested_page(self):
        self.transport.current['flows'] += [{'id':'extra_'+str(i),'type':'function','z':'tab1','func':'return msg;'} for i in range(100)]
        seen=[]
        self.coord.project_value=lambda node,key,value:seen.append(node)
        page=self.engine.read_page(16,None)
        self.assertEqual(len(page['nodes']),16);self.assertEqual(page['total_nodes'],103)
        self.assertEqual(set(seen),{n['id']for n in self.transport.current['flows'][16:32]})

    def test_node_field_public_source_pagination_and_private_withholding(self):
        result=self.engine.read_field('f1','func',0,None)
        self.assertEqual(result['state'],'withheld');self.assertNotIn('fragment',result)
        self.transport.current['flows'][1]['func']='é'*5000
        self.coord.project_value=lambda node,key,value:{'source':'exact_reviewed_public_source','value':value,'value_sha256':E.digest(value)}
        first=self.engine.read_field('f1','func',0,None)
        self.assertEqual(first['state'],'observed');self.assertEqual(first['next_offset'],8192)
        second=self.engine.read_field('f1','func',8192,first['node_sha256'])
        self.assertEqual(first['fragment']+second['fragment'],'é'*5000)
        with self.assertRaisesRegex(ValueError,'character_boundary'):self.engine.read_field('f1','func',1,first['node_sha256'])
        with self.assertRaisesRegex(ValueError,'node_snapshot_changed'):self.engine.read_field('f1','func',0,'0'*64)

    def edits(self, body='return {...msg, payload: 1};'):
        return [{'kind': 'patch', 'node_id': 'f1', 'expected_node_sha256': E.digest(self.transport.current['flows'][1]),
                 'set_fields': {'func': body}, 'unset_fields': []}]

    def prepare(self, operation=OP, edits=None):
        current = self.transport.current
        return self.engine.prepare(operation, current['rev'], E.digest(current['flows']), edits or self.edits())

    def approved(self, operation=OP, edits=None):
        plan = self.prepare(operation, edits)
        self.engine.validate(operation)
        return plan

    def apply(self, operation=OP, plan=None):
        plan = plan or self.approved(operation)
        return self.engine.apply(operation, plan['plan_sha256'], APPROVAL)

    def test_opaque_revision_success_and_unaffected_fields_preserved(self):
        plan = self.approved()
        self.assertEqual(plan['before_revision'], 'opaque revision:1/not-a-hash')
        self.assertEqual(plan['deploy_type'], 'nodes')
        before = copy.deepcopy(self.transport.current['flows'])
        result = self.apply(plan=plan)
        self.assertEqual(result['state'], 'applied')
        self.assertFalse(result['functional_recovery_proven'])
        self.assertEqual(self.transport.current['flows'][0], before[0])
        self.assertEqual(self.transport.current['flows'][2], before[2])
        changed = self.transport.current['flows'][1]
        self.assertEqual({k: v for k, v in changed.items() if k != 'func'},
                         {k: v for k, v in before[1].items() if k != 'func'})
        self.assertTrue(self.engine.verify(OP)['own_applied_revision_matches'])

    def test_duplicate_prepare_after_apply_returns_original_without_fresh_fetch(self):
        original = copy.deepcopy(self.transport.current)
        edits = self.edits()
        plan = self.approved(edits=edits)
        self.apply(plan=plan)
        self.transport.fetch = lambda: (_ for _ in ()).throw(AssertionError('duplicate must not fetch'))
        repeated = self.engine.prepare(OP, original['rev'], E.digest(original['flows']), edits)
        self.assertTrue(repeated['duplicate'])
        self.assertEqual(repeated['plan_sha256'], plan['plan_sha256'])
        self.assertEqual(len(self.transport.calls), 1)

    def test_failed_post_guard_is_uncertain_and_loaded_match_does_not_override_it(self):
        plan = self.approved()
        self.coord.post_guarded = False
        receipt = self.apply(plan=plan)
        self.assertEqual(receipt['state'], 'uncertain')
        self.assertEqual(receipt['collection_error'], 'credential_or_context_after_unconfirmed')
        self.assertIsNotNone(receipt['guard_before_sha256'])
        self.assertIsNone(receipt['guard_after_sha256'])
        self.assertFalse(receipt['credentials_preservation_verified'])
        self.assertFalse(receipt['context_preservation_verified'])
        check = self.engine.verify(OP)
        self.assertTrue(check['loaded_after_sha256_matches'])
        self.assertFalse(check['credentials_and_context_preserved'])
        self.assertEqual(check['collection_error'], 'credential_or_context_verification_unconfirmed')
        self.coord.post_guarded = True
        self.assertTrue(self.engine.verify(OP)['credentials_and_context_preserved'])
        self.assertEqual(self.engine.status(OP)['state'], 'uncertain')
        self.engine.apply(OP, plan['plan_sha256'], APPROVAL)
        self.assertEqual(len(self.transport.calls), 1)

    def test_real_intent_is_durable_before_only_deploy(self):
        plan = self.approved()
        original = self.transport.deploy
        def checked(rev, flows):
            intent = self.store.read(OP, 'intent.json')
            self.assertEqual(intent['plan_sha256'], plan['plan_sha256'])
            self.assertEqual(intent['expected_revision'], rev)
            return original(rev, flows)
        self.transport.deploy = checked
        self.apply(plan=plan)
        self.assertEqual(len(self.transport.calls), 1)

    def test_duplicate_success_never_sends_again(self):
        plan = self.approved()
        self.apply(plan=plan)
        self.assertTrue(self.engine.apply(OP, plan['plan_sha256'], APPROVAL)['duplicate'])
        self.assertEqual(len(self.transport.calls), 1)

    def test_uncertain_receipt_survives_restart_and_blocks_different_operation(self):
        plan = self.approved()
        self.transport.fail = True
        result = self.apply(plan=plan)
        self.assertEqual(result['state'], 'uncertain')
        self.assertNotIn('PRIVATE ERROR', json.dumps(result))
        self.engine = E.Engine(self.policy, self.transport, E.Journal(self.state), self.coord, self.clock)
        self.assertEqual(self.engine.status(OP)['state'], 'uncertain')
        self.engine.apply(OP, plan['plan_sha256'], APPROVAL)
        other = self.approved(SECOND, self.edits('return {...msg, payload: 2};'))
        with self.assertRaisesRegex(ValueError, 'prior_uncertain'):
            self.engine.apply(SECOND, other['plan_sha256'], APPROVAL)
        self.assertEqual(len(self.transport.calls), 1)

    def test_interrupted_intent_without_receipt_never_replays(self):
        plan = self.approved()
        self.store.write(OP, 'intent.json', {'operation_id': OP, 'attempted_at': self.now})
        self.assertEqual(self.engine.apply(OP, plan['plan_sha256'], APPROVAL)['state'], 'uncertain')
        self.assertEqual(self.transport.calls, [])

    def test_local_node_cas_and_whole_snapshot_cas(self):
        edits = self.edits()
        edits[0]['expected_node_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'node_compare_swap'):
            self.prepare(edits=edits)
        plan = self.approved()
        self.transport.current['flows'][2]['name'] = 'third-party'
        with self.assertRaisesRegex(ValueError, 'global_compare_swap'):
            self.engine.apply(OP, plan['plan_sha256'], APPROVAL)
        self.assertEqual(self.transport.calls, [])

    def test_api_cas_conflict_is_known_no_effect_and_same_operation_is_terminal(self):
        plan = self.approved()
        self.transport.conflict = True
        result = self.apply(plan=plan)
        self.assertEqual(result['state'], 'rejected_without_effect')
        self.assertEqual(result['collection_error'], 'revision_conflict')
        self.engine.apply(OP, plan['plan_sha256'], APPROVAL)
        self.assertEqual(len(self.transport.calls), 1)

    def test_read_and_diff_never_export_runtime_value_without_internal_public_proof(self):
        self.transport.current['flows'][1]['func'] = 'some private runtime code with arbitrary text'
        listing = self.engine.read()
        self.assertNotIn('some private runtime code', json.dumps(listing))
        plan = self.prepare()
        self.assertNotIn('some private runtime code', json.dumps(plan))
        self.assertNotIn('return {...msg', json.dumps(plan))
        self.assertTrue(plan['risk']['startup_effects_unknown'])
        self.assertTrue(plan['risk']['sensitive_actuator_effects_unknown'])

    def test_only_trusted_public_source_projection_returns_exact_values(self):
        self.coord.project_value = lambda node, key, value: {
            'source': 'exact_reviewed_public_source', 'value_sha256': E.digest(value), 'value': value}
        listing = self.engine.read()
        self.assertIn('return msg;', json.dumps(listing))
        self.coord.project_value = lambda node, key, value: {
            'source': 'caller_says_public', 'value_sha256': E.digest(value), 'value': value}
        self.assertNotIn('return msg;', json.dumps(self.engine.read()))

    def test_protected_fields_nested_credentials_and_shell_file_or_listener_rejected(self):
        for field in ('credentials', 'adminAuth', 'password'):
            with self.subTest(field=field):
                edits = self.edits()
                edits[0]['set_fields'] = {field: 'do-not-export'}
                with self.assertRaisesRegex(ValueError, 'protected_field'):
                    self.prepare(edits=edits)
        edits = self.edits()
        edits[0]['set_fields'] = {'properties': {'credentials': {'password': 'do-not-export'}}}
        with self.assertRaisesRegex(ValueError, 'protected_field'):
            self.prepare(edits=edits)
        for kind in ('exec', 'file', 'file in', 'http in', 'tcp in'):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, 'shell_node_refused'):
                    self.prepare(edits=[{'kind': 'create', 'node': {'id': 'new', 'type': kind, 'z': 'tab1'}}])
        self.assertEqual(self.transport.calls, [])

    def test_recoverable_delete_disables_without_removing_or_changing_other_fields(self):
        before = copy.deepcopy(self.transport.current['flows'])
        edit = {'kind': 'delete', 'node_id': 'f1', 'expected_node_sha256': E.digest(before[1])}
        plan = self.approved(edits=[edit])
        self.assertFalse(plan['hard_delete_enabled'])
        self.assertEqual(plan['deleted_logically'], ['f1'])
        self.apply(plan=plan)
        self.assertEqual(len(self.transport.current['flows']), len(before))
        self.assertEqual(self.transport.current['flows'][1], {**before[1], 'd': True})

    def test_logical_delete_requires_specific_restore_proof(self):
        edit = {'kind': 'delete', 'node_id': 'f1', 'expected_node_sha256': E.digest(FLOWS[1])}
        plan = self.approved(edits=[edit])
        self.coord.logical_restore = False
        with self.assertRaisesRegex(ValueError, 'recoverable_delete_not_proven'):
            self.apply(plan=plan)
        self.assertEqual(self.transport.calls, [])

    def test_absent_activation_approval_validation_guard_and_revocation_block(self):
        plan = self.prepare()
        with self.assertRaisesRegex(ValueError, 'validation_required'):
            self.apply(plan=plan)
        self.engine.validate(OP)
        self.coord.approved = False
        with self.assertRaisesRegex(ValueError, 'exact_effect_admission_required'):
            self.apply(plan=plan)
        self.coord.approved = True
        self.coord.guarded = False
        with self.assertRaisesRegex(ValueError, 'credential_or_context'):
            self.apply(plan=plan)
        self.coord.guarded = True
        self.coord.is_revoked = True
        with self.assertRaisesRegex(ValueError, 'policy_revoked'):
            self.apply(plan=plan)
        # Stored receipts remain readable after revocation; no API call needed.
        self.assertEqual(self.engine.status(OP)['state'], 'prepared')
        self.coord.is_revoked = False
        self.engine.policy['activation_confirmed'] = False
        with self.assertRaisesRegex(ValueError, 'policy_not_activated'):
            self.engine.read()
        self.assertEqual(self.transport.calls, [])

    def test_expiry_and_plan_hash_and_lock_contention(self):
        plan = self.approved()
        with self.assertRaisesRegex(ValueError, 'exact_plan_hash'):
            self.engine.apply(OP, '0' * 64, APPROVAL)
        self.coord.force_busy = True
        with self.assertRaisesRegex(ValueError, 'shared_lock_busy'):
            self.apply(plan=plan)
        self.coord.force_busy = False
        self.now += 901
        with self.assertRaisesRegex(ValueError, 'prepared_plan_expired'):
            self.apply(plan=plan)
        self.assertEqual(self.transport.calls, [])

    def test_unknown_verification_not_promoted_and_rollback_cannot_erase_third_party(self):
        plan = self.approved()
        self.transport.verify_fail = True
        self.assertEqual(self.apply(plan=plan)['state'], 'uncertain')
        self.transport.verify_fail = False
        self.assertTrue(self.engine.verify(OP)['loaded_after_sha256_matches'])
        self.assertFalse(self.engine.verify(OP)['own_applied_revision_matches'])
        with self.assertRaisesRegex(ValueError, 'own_applied_result_required'):
            self.engine.rollback(OP, ROLLBACK)

    def test_own_rollback_needs_fresh_revision_and_separate_exact_review(self):
        plan = self.approved()
        self.apply(plan=plan)
        self.now += 61
        reverse = self.engine.rollback(OP, ROLLBACK)
        self.assertEqual(reverse['action'], 'rollback')
        with self.assertRaisesRegex(ValueError, 'validation_required'):
            self.engine.apply(ROLLBACK, reverse['plan_sha256'], APPROVAL)
        self.engine.validate(ROLLBACK)
        self.engine.apply(ROLLBACK, reverse['plan_sha256'], APPROVAL)
        self.assertEqual(self.transport.current['flows'], FLOWS)

    def test_third_party_revision_or_fields_prevent_rollback(self):
        self.apply()
        self.transport.current['rev'] = 'third-party even identical content'
        with self.assertRaisesRegex(ValueError, 'foreign_change_blocks_rollback'):
            self.engine.rollback(OP, ROLLBACK)

    def test_own_create_rollback_preserves_new_operational_and_tab_ids_and_data(self):
        created = [{'id': 'new-tab', 'type': 'tab', 'label': 'new'},
                   {'id': 'new-function', 'type': 'function', 'z': 'new-tab',
                    'func': 'return msg;', 'wires': [], 'arbitrary_preserved': {'data': [1, 2, 3]}}]
        plan = self.approved(edits=[{'kind': 'create', 'node': node} for node in created])
        self.apply(plan=plan)
        self.now += 61
        reverse = self.engine.rollback(OP, ROLLBACK)
        self.assertEqual(reverse['retired_created_nodes'], ['new-tab', 'new-function'])
        self.assertEqual(reverse['deleted_logically'], reverse['retired_created_nodes'])
        self.assertEqual(reverse['risk']['removed_node_ids'], [])
        self.assertNotEqual(reverse['after_sha256'], plan['before_sha256'])
        self.engine.validate(ROLLBACK)
        self.engine.apply(ROLLBACK, reverse['plan_sha256'], APPROVAL)
        self.assertEqual(self.transport.current['flows'][:len(FLOWS)], FLOWS)
        kept = {node['id']: node for node in self.transport.current['flows']}
        self.assertEqual(kept['new-tab'], {**created[0], 'disabled': True})
        self.assertEqual(kept['new-function'], {**created[1], 'd': True})

    def test_configuration_node_logical_delete_and_reverse_create_fail_closed(self):
        config = {'id': 'config1', 'type': 'config-synthetic', 'name': 'keep'}
        self.transport.current['flows'].append(copy.deepcopy(config))
        with self.assertRaisesRegex(ValueError, 'configuration_node_quarantine_unavailable'):
            self.prepare(edits=[{'kind': 'delete', 'node_id': config['id'],
                                 'expected_node_sha256': E.digest(config)}])
        new = {'id': 'config2', 'type': 'config-synthetic', 'name': 'new'}
        plan = self.approved(edits=[{'kind': 'create', 'node': new}])
        self.apply(plan=plan)
        with self.assertRaisesRegex(ValueError, 'configuration_node_quarantine_unavailable'):
            self.engine.rollback(OP, ROLLBACK)
        self.assertEqual(len(self.transport.calls), 1)

    def test_own_create_rollback_refuses_later_foreign_edit_without_retiring_nodes(self):
        node = {'id': 'new-function', 'type': 'function', 'z': 'tab1', 'func': 'return msg;', 'wires': []}
        plan = self.approved(edits=[{'kind': 'create', 'node': node}])
        self.apply(plan=plan)
        self.transport.current['flows'][2]['name'] = 'foreign edit'
        self.transport.current['rev'] = 'new foreign revision'
        with self.assertRaisesRegex(ValueError, 'foreign_change_blocks_rollback'):
            self.engine.rollback(OP, ROLLBACK)
        self.assertNotIn('d', self.transport.current['flows'][-1])
        self.assertEqual(len(self.transport.calls), 1)

    def test_shared_daily_budget_and_spacing_apply_to_reverse_changes(self):
        self.apply()
        reverse = self.engine.rollback(OP, ROLLBACK)
        self.engine.validate(ROLLBACK)
        with self.assertRaisesRegex(ValueError, 'deploy_spacing'):
            self.engine.apply(ROLLBACK, reverse['plan_sha256'], APPROVAL)
        self.now += 61
        self.engine.apply(ROLLBACK, reverse['plan_sha256'], APPROVAL)
        for i in range(2):
            self.now += 61
            op = str(i + 4) * 32
            self.apply(op, self.approved(op, self.edits('return {...msg, payload: ' + str(i) + '};')))
        self.now += 61
        plan = self.approved('6' * 32, self.edits('return {...msg, payload: 7};'))
        with self.assertRaisesRegex(ValueError, 'daily_deploy_budget'):
            self.engine.apply('6' * 32, plan['plan_sha256'], APPROVAL)
        self.assertEqual(len(self.transport.calls), 4)

    def test_symlink_receipt_and_directory_are_rejected(self):
        self.prepare()
        outside = Path(self.tmp.name) / 'outside.json'
        outside.write_text('{}')
        os.chmod(outside, 0o600)
        (self.state / OP / 'receipt.json').symlink_to(outside)
        with self.assertRaises(OSError):
            self.engine.status(OP)
        link = Path(self.tmp.name) / 'link'
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink_directory'):
            E.Journal(link)


if __name__ == '__main__':
    unittest.main()
