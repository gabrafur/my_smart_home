"""Admission tests never open the root socket, private files or live services."""
import json
import unittest
from unittest.mock import patch
import catalog
import runtime
import server

OP = 'a'*32


class CatalogueTests(unittest.TestCase):
    def args(self, action='storage_plan_npm_logs'):
        return {'host': 'raspberry', 'action': action, 'idempotency_key': 'storage-'+OP}

    def test_fixed_scopes_and_independent_observation(self):
        self.assertEqual(catalog.validate('admin_action_apply', self.args()), ('plan', 'npm_logs', OP))
        for tool in ('admin_action_status', 'admin_action_reconcile'):
            self.assertEqual(catalog.validate(tool, self.args('storage_quarantine_npm_logs'))[0], 'status')
        self.assertFalse(catalog.catalogue()['recurring_execution_enabled'])
        self.assertIn('backups', catalog.catalogue()['protected'])

    def test_paths_commands_protected_targets_foreign_hosts_and_bad_ids_refused(self):
        for change in ({'path': '/tmp'}, {'command': 'remove'}, {'host': 'other'},
                       {'action': 'storage_quarantine_backups'}, {'action': 'storage_quarantine_docker'},
                       {'idempotency_key': 'storage-../../etc'}, {'action': []}):
            with self.assertRaisesRegex(ValueError, 'storage_scope_refused'):
                catalog.validate('admin_action_apply', self.args() | change)

    def test_revoke_is_not_disguised_as_observation_or_apply(self):
        args = self.args('storage_revoke_cache_cleanup')
        self.assertEqual(catalog.validate('admin_action_revoke', args)[0], 'revoke')
        for tool in ('admin_action_apply', 'admin_action_status', 'admin_action_reconcile'):
            with self.assertRaises(ValueError): catalog.validate(tool, args)

    def test_legacy_notice_request_is_not_reinterpreted(self):
        q = {'tool': 'admin_action_apply', 'host': 'raspberry', 'action': 'migrate_two_notice_aliases',
             'idempotency_key': 'notice-exact-aliases-20261024'}
        parsed, new = server.classify(json.dumps(q));self.assertEqual(parsed, q);self.assertFalse(new)
        for raw in ('{"tool":"a","tool":"b"}', '[]'):
            with self.assertRaises(ValueError):server.classify(raw)

    def test_status_and_reconcile_do_not_execute_or_retry(self):
        with patch.object(runtime, 'approval'), patch.object(runtime, 'engine') as factory, \
             patch.object(runtime.maintenance, 'read_json', return_value={'scope': 'npm_logs'}):
            engine = factory.return_value;engine.status.return_value = {'state': 'unknown'}
            for tool in ('admin_action_status', 'admin_action_reconcile'):
                self.assertEqual(runtime.dispatch(tool, self.args('storage_quarantine_npm_logs')), {'state': 'unknown'})
            engine.execute.assert_not_called();engine.restore.assert_not_called();engine.plan.assert_not_called()

    def test_health_observation_does_not_construct_cleanup_engine(self):
        with patch.object(runtime, 'observe', return_value={'state': 'observed'}) as observe, \
             patch.object(runtime, 'engine') as factory:
            self.assertEqual(runtime.dispatch('storage_metadata_observe', {'host': 'raspberry'}), {'state': 'observed'})
            observe.assert_called_once_with();factory.assert_not_called()
            with self.assertRaises(ValueError):runtime.dispatch('storage_metadata_observe', {'host': 'raspberry', 'apply': True})

    def test_failed_specific_approval_blocks_before_engine_or_scan(self):
        with patch.object(runtime, 'approval', side_effect=ValueError('specific_storage_policy_approval_required')), \
             patch.object(runtime, 'engine') as factory:
            with self.assertRaisesRegex(ValueError, 'approval_required'):runtime.dispatch('admin_action_apply', self.args())
            factory.assert_not_called()

    def test_admission_is_observed_separately_from_static_catalogue(self):
        with patch.object(runtime.maintenance, 'policy', return_value={'expires_at': None}):
            with patch.object(runtime, 'STATE', __import__('pathlib').Path('/nonexistent-synthetic-storage')):
                value=runtime.admission();self.assertTrue(value['execution_active']);self.assertTrue(value['restore_active'])
                self.assertFalse(value['recurring_execution_enabled']);self.assertIsNone(value['expires_at'])
        with patch.object(runtime.maintenance, 'policy', side_effect=ValueError('disabled')):
            value=runtime.admission();self.assertFalse(value['execution_active']);self.assertFalse(value['restore_active'])
            self.assertIsNotNone(value['collection_error'])


if __name__ == '__main__':unittest.main()
