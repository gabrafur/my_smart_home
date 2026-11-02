"""Serial synthetic incident recovery. No real reader, network, Root or manager."""
import copy
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import controller
import durable_store
import runtime
import test_controller as fixtures
import test_runtime as runtime_fixtures


class Correlation(unittest.TestCase):
    def setUp(self):
        self.now = 100000.0
        self.store = fixtures.Store()
        self.manager = fixtures.Manager(self.store)
        self.engine = controller.Controller(fixtures.policy(), self.store, self.manager, lambda: self.now)

    def call(self, verb='plan', key='a' * 32, tool='admin_action_apply'):
        return self.engine.request(tool, {'host': 'raspberry',
            'action': 'nodered_' + verb + '_reader_binding',
            'idempotency_key': 'nodered-peer-' + key})

    def test_second_key_recovers_valid_plan_without_alias_receipt_or_write(self):
        first = self.call(); ledger = copy.deepcopy(self.store.rows)
        self.now += 30
        second = self.call(key='b' * 32)
        self.assertEqual(second['operation_id'], first['operation_id'])
        self.assertEqual(second['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertTrue(second['incident_correlation']['observe_only'])
        self.assertEqual(second['incident_correlation']['preview_status'], 'valid')
        self.assertEqual(second['age_seconds'], 30)
        self.assertEqual(self.store.rows, ledger)
        with self.assertRaisesRegex(controller.Refused, 'plan_required'):
            self.call('apply', 'b' * 32)
        self.assertEqual(self.manager.writes, [])

    def test_same_incident_after_apply_keeps_original_pair_and_key(self):
        first = self.call(); self.call('apply'); ledger = copy.deepcopy(self.store.rows)
        match = self.call(key='b' * 32)  # Even during original spacing period.
        self.assertEqual(match['state'], 'applied')
        self.assertEqual(match['operation_id'], 'a' * 32)
        self.assertEqual(match['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertTrue(match['incident_correlation']['prior_effect_or_intent'])
        self.assertEqual(self.store.rows, ledger)
        self.assertEqual(len(self.manager.writes), 1)

    def test_new_instance_is_new_incident_with_preserved_prior_receipt(self):
        first = self.call(); self.call('apply'); self.now += 600
        old = self.store.get('a' * 32)
        self.manager.value.update(container_id='f' * 64, image_id='e' * 64, peer_ipv4='192.0.2.8')
        second = self.call(key='b' * 32)
        self.assertEqual(second['state'], 'planned')
        self.assertNotEqual(second['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertEqual(self.call('apply', 'b' * 32)['state'], 'applied')
        self.assertEqual(self.store.get('a' * 32), old)
        self.assertEqual(len(self.manager.writes), 2)

    def test_unit_revision_preserves_incident_but_changed_pair_is_distinct(self):
        first = self.call()
        self.engine.policy['unit_hashes'].append('5' * 64)
        self.manager.value['unit_sha256'] = '5' * 64
        revised = self.call(key='b' * 32)
        self.assertEqual(first['incident_correlation']['key'], revised['incident_correlation']['key'])
        self.assertEqual(revised['operation_id'], first['operation_id'])
        self.manager.value['peer_ipv4'] = '192.0.2.8'
        changed_pair = self.call(key='c' * 32)
        self.assertNotEqual(revised['incident_correlation']['key'], changed_pair['incident_correlation']['key'])

    def test_reviewed_unit_change_cannot_repeat_a_confirmed_apply(self):
        first = self.call(); self.call('apply'); original = self.store.get('a' * 32)
        self.now += 600
        self.engine.policy['unit_hashes'].append('5' * 64)
        self.manager.value['unit_sha256'] = '5' * 64
        self.manager.value['allowed'] = copy.deepcopy(original['before'])
        matched = self.call(key='b' * 32)
        self.assertEqual(matched['operation_id'], first['operation_id'])
        self.assertEqual(matched['incident_correlation']['key'], first['incident_correlation']['key'])
        with self.assertRaisesRegex(controller.Refused, 'plan_required'):
            self.call('apply', 'b' * 32)
        self.assertEqual(len(self.manager.writes), 1)
        self.assertEqual(self.store.get('a' * 32), original)

    def test_duplicate_acl_entries_do_not_form_a_new_incident(self):
        first = self.call(); row = self.store.get('a' * 32)
        row['before'].append(row['before'][0]); row['after'].append(row['after'][0])
        self.assertEqual(controller.incident_key(row), first['incident_correlation']['key'])
        self.manager.value['allowed'].append(self.manager.value['allowed'][0])
        second = self.call(key='b' * 32)
        self.assertEqual(second['operation_id'], first['operation_id'])
        self.assertEqual(len(self.store.rows), 1)

    def test_unknown_after_changed_peer_can_only_observe_original(self):
        first = self.call(); self.manager.lose_reply = True
        self.assertEqual(self.call('apply')['state'], 'outcome_unknown')
        ledger = copy.deepcopy(self.store.rows)
        with self.assertRaisesRegex(controller.Refused, 'requires_reconciliation'):
            self.call(key='b' * 32)
        recovered = self.call(tool='admin_action_status')
        self.assertEqual(recovered['state'], 'outcome_unknown')
        self.assertEqual(recovered['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertTrue(recovered['incident_correlation']['observe_only'])
        with self.assertRaisesRegex(controller.Refused, 'plan_required'):
            self.call('apply', 'b' * 32)
        self.assertEqual(self.store.rows, ledger)
        self.assertEqual(len(self.manager.writes), 1)

    def test_unknown_without_change_does_not_recycle_result(self):
        self.call(); self.manager.failure = True; self.call('apply')
        with self.assertRaisesRegex(controller.Refused, 'requires_reconciliation'):
            self.call(key='b' * 32)
        recovered = self.call(tool='admin_action_status')
        self.assertEqual(recovered['state'], 'outcome_unknown')
        self.call(tool='admin_action_reconcile')
        self.assertEqual(self.call(key='b' * 32)['state'], 'not_applied_observed')
        self.call('apply')
        self.assertEqual(len(self.manager.writes), 1)
        self.assertEqual(len(self.store.rows), 1)

    def test_unrelated_uncertain_instance_still_blocks_new_plan(self):
        self.call(); self.manager.failure = True; self.call('apply')
        self.manager.value.update(container_id='f' * 64, image_id='e' * 64)
        with self.assertRaisesRegex(controller.Refused, 'requires_reconciliation'):
            self.call(key='b' * 32)
        self.assertEqual(len(self.store.rows), 1)

    def test_restored_incident_never_receives_another_apply_under_new_key(self):
        first = self.call(); self.call('apply'); self.now += 600
        self.call('plan_restore'); self.call('restore')
        original = copy.deepcopy(self.store.rows)
        recovered = self.call(key='b' * 32)
        self.assertEqual(recovered['state'], 'restored')
        self.assertEqual(recovered['incident_correlation']['key'], first['incident_correlation']['key'])
        with self.assertRaises(controller.Refused): self.call('apply', 'b' * 32)
        self.assertEqual(self.store.rows, original)
        self.assertEqual(len(self.manager.writes), 2)

    def test_restore_unknown_remains_same_incident_and_blocks_new_key(self):
        self.call(); self.call('apply'); self.now += 600; self.call('plan_restore')
        self.manager.lose_reply = True
        self.assertEqual(self.call('restore')['state'], 'restore_unknown')
        with self.assertRaisesRegex(controller.Refused, 'requires_reconciliation'):
            self.call(key='b' * 32)
        self.assertEqual(self.call(tool='admin_action_status')['state'], 'restore_unknown')
        self.assertEqual(len(self.store.rows), 1)
        self.assertEqual(len(self.manager.writes), 2)

    def test_expired_no_effect_plan_gets_fresh_linked_preview_without_rewriting_it(self):
        first = self.call(); original = self.store.get('a' * 32); self.now += 901
        recovered = self.call(key='b' * 32)
        self.assertEqual(recovered['state'], 'planned')
        self.assertEqual(recovered['incident_correlation']['preview_status'], 'valid')
        self.assertFalse(recovered['incident_correlation']['observe_only'])
        self.assertEqual(recovered['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertEqual(recovered['incident_correlation']['prior_no_effect_preview_operation_id'], 'a' * 32)
        with self.assertRaisesRegex(controller.Refused, 'binding_plan_expired'): self.call('apply')
        self.assertEqual(self.store.get('a' * 32), original)
        self.assertEqual(self.manager.writes, [])
        self.assertEqual(self.call('apply', 'b' * 32)['state'], 'applied')
        self.assertEqual(len(self.manager.writes), 1)
        self.assertEqual(self.store.get('a' * 32), original)

    def test_new_plan_explicitly_correlates_current_verified_target(self):
        out = self.call()['incident_correlation']
        self.assertEqual(out['association_source'], 'current_target_verified_by_existing_preview')
        self.assertFalse(out['existing_operation'])
        self.assertFalse(out['observe_only'])
        self.assertFalse(out['correlation_grants_effect'])

    def test_no_change_matches_without_creating_an_operation_or_effect(self):
        self.manager.value['peer_ipv4'] = '192.0.2.7'
        first = self.call(); match = self.call(key='b' * 32)
        self.assertEqual(first['state'], 'no_change')
        self.assertEqual(match['operation_id'], first['operation_id'])
        self.assertTrue(match['incident_correlation']['observe_only'])
        self.assertEqual(len(self.store.rows), 1)
        self.assertEqual(self.manager.writes, [])

    def test_duplicate_legacy_plan_cannot_apply_even_if_it_already_has_a_row(self):
        self.call(); second = self.store.get('a' * 32)
        second.update(id='b' * 32, planned_at=self.now + 1, observed_at_unix=self.now + 1)
        self.store.save(second); self.now += 2
        before = copy.deepcopy(self.store.rows)
        with self.assertRaisesRegex(controller.Refused, 'canonical_operation'):
            self.call('apply', 'b' * 32)
        self.assertEqual(self.call(key='c' * 32)['operation_id'], 'a' * 32)
        self.assertEqual(self.store.rows, before)
        self.assertEqual(self.manager.writes, [])
        self.call('apply'); self.now += 600
        self.manager.value['allowed'] = copy.deepcopy(self.store.get('a' * 32)['before'])
        with self.assertRaisesRegex(controller.Refused, 'canonical_operation'):
            self.call('apply', 'b' * 32)
        self.assertEqual(len(self.manager.writes), 1)

    def test_new_fixed_refusal_reasons_are_sanitized_on_the_wire(self):
        import server
        for reason in ('ambiguous_incident_history_requires_review',
                       'incident_already_has_canonical_operation',
                       'incident_receipt_clock_unconfirmed', 'clock_order_unconfirmed'):
            self.assertIn(reason, server.SAFE_REASONS)

    def test_legacy_duplicate_effects_are_ambiguous_fail_closed(self):
        self.call(); self.call('apply'); second = self.store.get('a' * 32)
        second['id'] = 'b' * 32; self.store.save(second); self.now += 600
        with self.assertRaisesRegex(controller.Refused, 'ambiguous_incident_history'):
            self.call(key='c' * 32)
        self.assertEqual(len(self.manager.writes), 1)

    def test_full_budget_allows_only_matching_observation_not_new_plan(self):
        self.call(); self.call('apply'); original = self.store.get('a' * 32)
        for key in ('b', 'c', 'd'):
            row = copy.deepcopy(original); row['id'] = key * 32
            row['instance']['container_id'] = key * 64
            row['effects'] = [{'kind': 'apply', 'at': self.now - 1000}]
            self.store.save(row)
        ledger = copy.deepcopy(self.store.rows)
        self.assertEqual(self.call(key='e' * 32)['operation_id'], 'a' * 32)
        self.manager.value.update(container_id='f' * 64, peer_ipv4='192.0.2.8')
        with self.assertRaisesRegex(controller.Refused, 'daily_budget'):
            self.call(key='e' * 32)
        self.assertEqual(self.store.rows, ledger)
        self.assertEqual(len(self.manager.writes), 1)

    def test_full_history_has_no_export_or_capacity_bypass(self):
        self.call(); original = self.store.get('a' * 32)
        for n in range(63):
            row = copy.deepcopy(original); row['id'] = format(n, '032x')
            row['instance']['container_id'] = format(n, '064x'); self.store.save(row)
        out = self.call(key='f' * 32)
        self.assertEqual(out['operation_id'], 'a' * 32)
        self.assertNotIn('operations', out); self.assertNotIn('history', out)
        self.assertNotIn(format(62, '032x'), json.dumps(out))
        self.manager.value['container_id'] = 'f' * 64
        with self.assertRaisesRegex(controller.Refused, 'history_capacity'):
            self.call(key='f' * 32)

    def test_clock_invalid_never_creates_preview_or_writes(self):
        for now in (float('nan'), float('inf'), -1, True):
            self.now = now
            with self.subTest(now=str(now)), self.assertRaisesRegex(controller.Refused, 'clock'):
                self.call()
        self.assertEqual(self.store.rows, {})
        self.assertEqual(self.manager.writes, [])

    def test_backwards_clock_preserves_receipt_and_marks_recovered_preview_unknown(self):
        self.call(); original = copy.deepcopy(self.store.rows); self.now -= 10
        match = self.call(key='b' * 32)
        self.assertEqual(match['incident_correlation']['preview_status'], 'clock_invalid')
        self.assertIsNone(match['age_seconds'])
        self.assertEqual(match['collection_error'], 'clock_order_unconfirmed')
        with self.assertRaises(controller.Refused): self.call('apply')
        self.assertEqual(self.store.rows, original)
        self.assertEqual(self.manager.writes, [])

    def test_revocation_disabled_policy_and_headroom_still_block_correlation_inspection(self):
        self.call()
        for kind in ('revoked', 'disabled', 'headroom'):
            self.store.is_revoked = kind == 'revoked'
            self.engine.policy['enabled'] = kind != 'disabled'
            self.manager.safe = kind != 'headroom'
            with self.subTest(kind=kind), self.assertRaises(controller.Refused):
                self.call(key='b' * 32)
        self.assertEqual(self.manager.writes, [])

    def test_key_and_metadata_are_stable_sanitized_and_not_client_selectable(self):
        row = self.call(); serialized = json.dumps(row)
        self.assertRegex(row['incident_correlation']['key'], r'^nri1-[a-f0-9]{64}$')
        for private in ('192.0.2.', '198.51.100.', '1' * 64, '2' * 64, '/var/lib/', '/run/'):
            self.assertNotIn(private, serialized)
        args = {'host': 'raspberry', 'action': 'nodered_plan_reader_binding',
                'idempotency_key': 'nodered-peer-' + 'b' * 32, 'incident_key': row['incident_correlation']['key']}
        with self.assertRaises(controller.Refused): self.engine.request('admin_action_apply', args)

    def test_process_recreation_preserves_legacy_derived_key_without_migration(self):
        first = self.call(); original = copy.deepcopy(self.store.rows)
        self.engine = controller.Controller(fixtures.policy(), self.store, self.manager, lambda: self.now)
        second = self.call(key='b' * 32)
        self.assertEqual(second['incident_correlation']['key'], first['incident_correlation']['key'])
        self.assertEqual(self.store.rows, original)

    def test_status_does_not_inspect_or_claim_current_target(self):
        self.call()
        with patch.object(self.manager, 'inspect', side_effect=AssertionError('no active status probe')):
            out = self.call(tool='admin_action_status')
        self.assertEqual(out['incident_correlation']['association_source'], 'stored_receipt_not_current_target')


class PassiveDiscovery(unittest.TestCase):
    def test_explanation_only_without_native_inspection_or_receipt_enumeration(self):
        store = fixtures.Store()
        with patch.object(runtime.durable_store, 'Store', return_value=store), \
                patch.object(runtime, 'components', side_effect=AssertionError('no active manager')):
            out = runtime.metadata(runtime_fixtures.policy())
        meta = out['incident_correlation']
        self.assertEqual(meta['available_via'], 'nodered_plan_reader_binding')
        self.assertFalse(meta['current_target_observed'])
        self.assertFalse(meta['history_enumeration_enabled'])
        self.assertNotIn('operation_id', meta)
        self.assertFalse(out['client_event_policy']['approval_active'])
        self.assertEqual(runtime.CLIENT_EVENT_RULES['maximum_applies_per_incident'], 1)
        self.assertTrue(runtime.CLIENT_EVENT_RULES['interface_confirmations_required'])
        self.assertFalse(runtime.CLIENT_EVENT_RULES['server_scheduling_enabled'])


class DurableCorrelation(unittest.TestCase):
    def test_legacy_receipt_recovered_after_reopen_without_byte_change(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); state = base / 'state'; state.mkdir(mode=0o700)
            common = base / 'common.lock'; common.write_bytes(b'synthetic lock'); common.chmod(0o600)
            st = common.stat(); identity = (st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode & 0o777)
            def opened():
                store = durable_store.Store(state, common, identity, owner=os.getuid())
                manager = fixtures.Manager(store)
                return controller.Controller(fixtures.policy(), store, manager, lambda: 100000.0)
            args = {'host': 'raspberry', 'action': 'nodered_plan_reader_binding',
                    'idempotency_key': 'nodered-peer-' + 'a' * 32}
            first = opened().request('admin_action_apply', args)
            raw = (state / 'ledger.json').read_bytes()
            second = opened().request('admin_action_apply', {**args, 'idempotency_key': 'nodered-peer-' + 'b' * 32})
            self.assertEqual(second['operation_id'], first['operation_id'])
            self.assertEqual(second['incident_correlation']['key'], first['incident_correlation']['key'])
            self.assertEqual((state / 'ledger.json').read_bytes(), raw)
            self.assertTrue(second['incident_correlation']['observe_only'])


if __name__ == '__main__':
    unittest.main()
