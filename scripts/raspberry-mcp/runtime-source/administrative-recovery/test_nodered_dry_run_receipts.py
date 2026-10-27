import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fixed_nodered_receipts',
    Path(__file__).with_name('apply_nodered_dry_run_receipts.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
admission_spec = importlib.util.spec_from_file_location('live_scoped_admission',
    Path(__file__).with_name('scoped_task_admission.py'))
admission = importlib.util.module_from_spec(admission_spec)
admission_spec.loader.exec_module(admission)
legacy_spec = importlib.util.spec_from_file_location('frozen_kia_task_admission',
    Path(__file__).with_name('apply_kia_promotion_evidence.py'))
legacy = importlib.util.module_from_spec(legacy_spec)
legacy_spec.loader.exec_module(legacy)

class ScopeTests(unittest.TestCase):
    def pair(self):
        before = [{'id': key, 'type': 'function', 'func': 'old', 'wires': [[]], 'x': 100}
            for key in sorted(module.NODE_IDS)] + [{'id': 'other', 'type': 'inject', 'wires': [[]]}]
        after = copy.deepcopy(before)
        for node in after[:-1]:
            node['func'] = 'reviewed'
        return before, after

    def test_only_six_function_bodies_are_admitted(self):
        before, after = self.pair()
        self.assertEqual(module.function_delta(before, after), sorted(module.NODE_IDS))

    def test_wiring_positions_and_types_cannot_be_changed(self):
        for key, value in [('wires', [['physical_effect']]), ('x', 200), ('type', 'exec')]:
            before, after = self.pair()
            after[0][key] = value
            with self.assertRaisesRegex(ValueError, 'non_function_property_changed'):
                module.function_delta(before, after)

    def test_unrelated_node_changes_are_rejected(self):
        before, after = self.pair()
        after[-1]['payload'] = 'unreviewed'
        with self.assertRaisesRegex(ValueError, 'node_scope_changed'):
            module.function_delta(before, after)

    def test_missing_extra_and_duplicate_nodes_are_rejected(self):
        for mutation in ['missing', 'extra', 'duplicate']:
            before, after = self.pair()
            if mutation == 'missing':
                after.pop()
            else:
                after.append(copy.deepcopy(after[-1]) if mutation == 'duplicate' else {'id': 'new'})
            with self.assertRaisesRegex(ValueError, 'node_inventory_changed'):
                module.function_delta(before, after)

    def test_partial_change_cannot_be_mistaken_for_full_package(self):
        before, after = self.pair()
        after[0]['func'] = before[0]['func']
        with self.assertRaisesRegex(ValueError, 'node_scope_changed'):
            module.function_delta(before, after)

class AdmissionTests(unittest.TestCase):
    def case(self, observed=False):
        create = {'operation_id': 'a' * 32, 'task_key': 'eva-admin-test', 'objective': 'bounded', 'acceptance': 'proof'}
        send = {'operation_id': 'b' * 32, 'task_id': create['operation_id'], 'text': 'fixed effect'}
        manifest = {'phases': {'rollback': {'create': create, 'send': send}}}
        task = {'id': create['operation_id'], 'task_key': create['task_key'], 'spec_hash': admission.fingerprint(create),
            'state': 'created', 'thread': 'native-thread', 'reconciled': 1}
        live = {'operation_state': 'inProgress', 'turn_id': 'native-turn', 'started_at': 100, 'completed_at': None}
        row = {'id': send['operation_id'], 'task': task['id'], 'input_hash': admission.fingerprint(send),
            'state': 'inProgress' if observed else 'accepted', 'turn': 'native-turn', 'reconciled': 0,
            'result': json.dumps(live) if observed else None}
        return manifest, [task], [row]

    def test_original_unobserved_admission_is_preserved(self):
        args = self.case()
        legacy.validate_task_context(args[0], 'rollback', *args[1:])
        admission.validate_task_context(args[0], 'rollback', *args[1:])

    def test_own_progress_poll_cannot_invalidate_the_same_authorized_send(self):
        args = self.case(observed=True)
        with self.assertRaisesRegex(ValueError, 'scoped_send_unconfirmed'):
            legacy.validate_task_context(args[0], 'rollback', *args[1:])
        admission.validate_task_context(args[0], 'rollback', *args[1:])

    def test_foreign_terminal_or_inconsistent_observations_are_rejected(self):
        mutations = [lambda v: v.update(turn_id='other'), lambda v: v.update(completed_at=101),
            lambda v: v.update(operation_state='completed'), lambda v: v.update(extra=True),
            lambda v: v.update(started_at=True), lambda v: v.update(started_at=float('nan')),
            lambda v: v.update(started_at=-1)]
        for mutate in mutations:
            m, tasks, sends = self.case(observed=True)
            value = json.loads(sends[0]['result']); mutate(value); sends[0]['result'] = json.dumps(value)
            with self.assertRaisesRegex(ValueError, 'scoped_send_unconfirmed'):
                admission.validate_task_context(m, 'rollback', tasks, sends)
        for result in ['{', '{}', 1, {'operation_state': 'inProgress'}]:
            m, tasks, sends = self.case(observed=True); sends[0]['result'] = result
            with self.assertRaisesRegex(ValueError, 'scoped_send_unconfirmed'):
                admission.validate_task_context(m, 'rollback', tasks, sends)

    def test_live_cache_does_not_allow_a_different_identity_or_input(self):
        for key, value in [('id', 'c' * 32), ('task', 'c' * 32), ('input_hash', 'c' * 64),
            ('state', 'outcome_unknown'), ('state', 'accepted'), ('turn', None)]:
            m, tasks, sends = self.case(observed=True); sends[0][key] = value
            with self.assertRaises(ValueError):
                admission.validate_task_context(m, 'rollback', tasks, sends)

    def test_every_other_busy_or_unreconciled_send_remains_blocking(self):
        for state, reconciled in [('inProgress', 1), ('accepted', 0), ('completed', 0), ('outcome_unknown', 0)]:
            m, tasks, sends = self.case(observed=True)
            sends.append({**sends[0], 'id': 'c' * 32, 'state': state, 'reconciled': reconciled})
            with self.assertRaises(ValueError):
                admission.validate_task_context(m, 'rollback', tasks, sends)

    def test_unreconciled_or_changed_task_is_rejected(self):
        for key, value in [('reconciled', 0), ('task_key', 'other'), ('spec_hash', 'c' * 64),
            ('state', 'create_unknown'), ('thread', None)]:
            m, tasks, sends = self.case(observed=True); tasks[0][key] = value
            with self.assertRaises(ValueError):
                admission.validate_task_context(m, 'rollback', tasks, sends)

    def test_missing_or_duplicate_reservations_are_rejected(self):
        for part in ['no_tasks', 'duplicate_tasks', 'no_send', 'reconciled_send']:
            m, tasks, sends = self.case(observed=True)
            if part == 'no_tasks': tasks = []
            elif part == 'duplicate_tasks': tasks += copy.deepcopy(tasks)
            elif part == 'no_send': sends = []
            else: sends[0]['reconciled'] = 1
            with self.assertRaises(ValueError):
                admission.validate_task_context(m, 'rollback', tasks, sends)

if __name__ == '__main__':
    unittest.main()
