import copy
import json
import unittest

from notice_dependency_review import FILES, ROOT, POLICIES, candidate, reviewed_candidates, sha, unchanged_policy


class Review(unittest.TestCase):
    def setUp(self):
        self.old = {name: ('old synthetic ' + name).encode() for name in FILES}
        self.new = {name: ('reviewed synthetic ' + name).encode() for name in FILES}
        self.policy = {'enabled': False, 'expires_at': 123, 'maximum_submissions': 2,
                       'tasks': ['synthetic_task'], 'new_future_gate': {'preserve': True},
                       'dependencies': {ROOT + name: sha(raw) for name, raw in self.old.items()}}
        self.policy['dependencies']['/synthetic/unchanged.py'] = 'a' * 64

    def test_only_three_reviewed_pins_change_all_authority_fields_stay_exact(self):
        original = copy.deepcopy(self.policy)
        out, changes = candidate(self.policy, self.old, self.new, self.new)
        self.assertEqual(self.policy, original)
        self.assertEqual(len(changes), 3)
        for key in set(original) - {'dependencies'}:
            self.assertEqual(out[key], original[key])
        self.assertEqual(out['dependencies']['/synthetic/unchanged.py'], 'a' * 64)
        for name in FILES:
            self.assertEqual(out['dependencies'][ROOT + name], sha(self.new[name]))

    def test_unreviewed_live_change_is_not_adopted_as_a_new_pin(self):
        live = dict(self.new, **{FILES[0]: b'unreviewed drift'})
        with self.assertRaisesRegex(ValueError, 'live_not_reviewed'):
            candidate(self.policy, self.old, self.new, live)

    def test_wrong_old_baseline_is_refused_without_mutating_policy(self):
        self.policy['dependencies'][ROOT + FILES[0]] = 'b' * 64
        original = copy.deepcopy(self.policy)
        with self.assertRaisesRegex(ValueError, 'baseline_changed'):
            candidate(self.policy, self.old, self.new, self.new)
        self.assertEqual(self.policy, original)

    def test_extra_missing_empty_or_nonbyte_source_is_refused(self):
        for values in ({}, {**self.old, 'arbitrary.py': b'no'},
                       {**self.old, FILES[0]: b''}, {**self.old, FILES[0]: 'text'}):
            with self.assertRaisesRegex(ValueError, 'source_scope_changed'):
                candidate(self.policy, values, self.new, self.new)

    def test_reapplication_after_pin_publication_is_not_a_new_operation(self):
        updated, _ = candidate(self.policy, self.old, self.new, self.new)
        with self.assertRaisesRegex(ValueError, 'baseline_changed'):
            candidate(updated, self.old, self.new, self.new)

    def test_unchanged_files_do_not_masquerade_as_the_reviewed_update(self):
        with self.assertRaisesRegex(ValueError, 'not_changed'):
            candidate(self.policy, self.old, self.old, self.old)

    def test_concurrent_policy_edit_requires_reconciliation(self):
        unchanged_policy(b'original exact bytes', b'original exact bytes')
        with self.assertRaisesRegex(ValueError, 'policy_changed'):
            unchanged_policy(b'concurrent edit', b'original exact bytes')

    def test_admin_review_changes_only_its_existing_state_dependency(self):
        out, changes = candidate(self.policy, self.old, self.new, self.new, policy_kind='admin')
        self.assertEqual([r['file'] for r in changes], ['notification_state.cjs'])
        for name in FILES[:2]:
            self.assertEqual(out['dependencies'][ROOT + name], self.policy['dependencies'][ROOT + name])
        for key in set(self.policy) - {'dependencies'}:
            self.assertEqual(out[key], self.policy[key])

    def test_unknown_policy_cannot_extend_the_review_scope(self):
        with self.assertRaisesRegex(ValueError, 'policy_scope_changed'):
            candidate(self.policy, self.old, self.new, self.new, policy_kind='other')

    def coordinated(self):
        admin = json.dumps(self.policy).encode()
        repair = copy.deepcopy(self.policy)
        repair['dependencies'][POLICIES['admin']] = sha(admin)
        return {'admin': admin, 'repair': json.dumps(repair).encode()}

    def test_complete_plan_pins_the_exact_new_admin_bytes_without_other_changes(self):
        before = self.coordinated()
        after, changes = reviewed_candidates(before, self.old, self.new, self.new)
        admin = json.loads(after['admin']); repair = json.loads(after['repair'])
        self.assertEqual(repair['dependencies'][POLICIES['admin']], sha(after['admin']))
        self.assertEqual(len(changes['admin']), 1)
        self.assertEqual(len(changes['repair']), 4)
        for kind in before:
            original = json.loads(before[kind]); current = json.loads(after[kind])
            for key in set(original) - {'dependencies'}:
                self.assertEqual(current[key], original[key])
        self.assertFalse(admin['enabled'])

    def test_drifted_admin_policy_pin_does_not_adopt_live_bytes(self):
        policies = self.coordinated();repair = json.loads(policies['repair'])
        repair['dependencies'][POLICIES['admin']] = 'f' * 64
        policies['repair'] = json.dumps(repair).encode()
        with self.assertRaisesRegex(ValueError, 'admin_baseline_changed'):
            reviewed_candidates(policies, self.old, self.new, self.new)

    def test_completed_coordinated_plan_cannot_be_replayed_after_a_lost_return(self):
        after, _ = reviewed_candidates(self.coordinated(), self.old, self.new, self.new)
        original = copy.deepcopy(after)
        with self.assertRaisesRegex(ValueError, 'baseline_changed'):
            reviewed_candidates(after, self.old, self.new, self.new)
        self.assertEqual(after, original)


if __name__ == '__main__':
    unittest.main()
