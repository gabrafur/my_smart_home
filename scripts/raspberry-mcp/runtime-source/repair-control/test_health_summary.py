import copy
import unittest
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location('_mcp_active_health_projection', Path(__file__).with_name('health_summary.py'))
_active = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_active)
correct_backups, publication, static_capabilities = _active.correct_backups, _active.publication, _active.static_capabilities

T1 = '2026-10-24T04:00:05+00:00'
T2 = '2026-10-24T13:29:28+00:00'
NOW = 1792886400


def base(status='failed', at=T1, error=None):
    return {'data': {'git': {'status': status, 'reason': 'security_scan_failed',
        'finished_at': at, 'evidence': {'collection_error': error, 'data': {'original': True}}},
        'offsite': {'status': 'failed', 'remote_copy': {'verified': None},
                    'restoration': {'verified': None}}}, 'coverage': []}


def pushed(at=T2):
    return f'[{at}] backup finished: pushed abc1234\n'


class HealthTests(unittest.TestCase):
    def test_old_failure_later_publication(self):
        source = base(); original = copy.deepcopy(source)
        out = correct_backups(source, pushed(), NOW)
        self.assertEqual(out['data']['git']['summary']['state'], 'publication_after_worker_failure')
        self.assertEqual(out['data']['git']['status'], 'failed')
        self.assertEqual(out['data']['git']['last_worker_cycle']['reason'], 'security_scan_failed')
        self.assertEqual(out['data']['git']['last_scheduled_cycle']['status'], 'unknown')
        self.assertEqual(out['data']['offsite'], original['data']['offsite'])
        self.assertEqual(source, original)

    def test_later_failure(self):
        out = correct_backups(base(at=T2), pushed(T1), NOW)
        self.assertEqual(out['data']['git']['summary']['state'], 'worker_failure_after_publication')
        self.assertFalse(out['data']['git']['summary']['offsite_success_inferred'])

    def test_missing_times(self):
        for at in [None, '', 'not-a-date', '2026-10-24T04:00:05']:
            with self.subTest(at=at):
                out = correct_backups(base(at=at), pushed(), NOW)
                self.assertEqual(out['data']['git']['summary']['state'], 'unknown')
        self.assertEqual(publication('backup finished: pushed abc1234', NOW)['state'], 'unknown')

    def test_conflicting_times(self):
        out = correct_backups(base(), pushed(T2) + pushed(T1), NOW)
        self.assertEqual(out['data']['git']['summary']['state'], 'unknown')
        self.assertEqual(correct_backups(base(at=T1), pushed(T1), NOW)['data']['git']['summary']['state'], 'unknown')
        self.assertEqual(publication(pushed('2099-01-01T00:00:00Z'), NOW)['state'], 'unknown')
        source = base();source['data']['git']['started_at'] = T2
        self.assertEqual(correct_backups(source, pushed(), NOW)['data']['git']['summary']['state'], 'unknown')
        source = base();source['data']['git']['exit_code'] = 0
        self.assertEqual(correct_backups(source, pushed(), NOW)['data']['git']['summary']['state'], 'unknown')

    def test_collection_failure(self):
        for error in ['source_permission_denied', 'source_missing', 'collection_timeout']:
            out = correct_backups(base(error=error), pushed(), NOW)
            self.assertEqual(out['data']['git']['summary']['state'], 'unknown')
        self.assertEqual(correct_backups(base(), None, NOW)['data']['git']['summary']['state'], 'unknown')

    def test_no_changes_is_not_publication(self):
        out = publication(pushed(T1) + f'[{T2}] backup finished: no changes\n', NOW)
        self.assertEqual(out['finished_at'], T1)
        self.assertEqual(publication(f'[{T2}] backup finished: no changes', NOW)['state'], 'unknown')

    def test_static_capability_not_current_state(self):
        source = {'evidence': {'data': {'native_events': {'assistant_run_proven': False},
            'ha_notification_observer': {'events_subscription_enabled': False,
                                        'events_discovery_only': True}, 'autonomous_repairs': False}}}
        out = static_capabilities(source)['evidence']['data']
        self.assertNotIn('native_events', out)
        self.assertNotIn('events_subscription_enabled', out['ha_notification_observer'])
        self.assertTrue(out['events']['capability_static']['implemented'])
        self.assertEqual(out['events']['current_observation']['state'], 'unknown')
        self.assertFalse(source['evidence']['data']['ha_notification_observer']['events_subscription_enabled'])

    def test_never_exports_log_payloads(self):
        sentinel = 'SYNTHETIC-PRIVATE-TEXT'
        out = correct_backups(base(), sentinel + '\n' + pushed(), NOW)
        self.assertNotIn(sentinel, str(out))




class ScheduledProjectionTests(unittest.TestCase):
    def fixture(self, status='success'):
        import hashlib
        request = '20261024T040000Z-123'
        source = base(status=status)
        source['data']['git']['operation_id'] = hashlib.sha256(request.encode()).hexdigest()[:32]
        projection = {'schema_version': 1, 'source': 'canonical_nodered_git_backup_result',
            'observed_at': T2, 'last_scheduled_cycle': {'status': status, 'reason': 'completed',
            'finished_at': T1, 'request_id': request, 'origin': 'scheduled'},
            'failure_history': []}
        return source, projection

    def result(self, source, projection, error=None, historical=None):
        return correct_backups(source, pushed(), NOW, projection, error, historical)['data']['git']

    def test_scheduled_is_correlated_without_offsite_inference(self):
        source, projection = self.fixture()
        value = self.result(source, projection)
        self.assertEqual(value['last_scheduled_cycle']['state'], 'observed')
        self.assertTrue(value['summary']['scheduled_success_proven'])
        self.assertFalse(value['summary']['offsite_success_inferred'])
        self.assertFalse(value['summary']['restoration_inferred'])

    def test_manual_later_preserves_scheduled(self):
        source, projection = self.fixture()
        source['data']['git'].update(finished_at=T2, operation_id='a'*32)
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['worker_relation'], 'older_than_current_worker')

    def test_old_failure_then_success_is_retained(self):
        source, projection = self.fixture()
        failure = copy.deepcopy(projection['last_scheduled_cycle']); failure.update(status='failed', finished_at=T1, private='SYNTHETIC-PRIVATE')
        projection['failure_history'] = [failure]
        value = self.result(source, projection)
        self.assertEqual(value['known_failure_history'][0]['status'], 'failed')
        self.assertNotIn('SYNTHETIC-PRIVATE', str(value))
        self.assertEqual(value['last_scheduled_cycle']['status'], 'success')

    def test_later_failure_remains_failed(self):
        source, projection = self.fixture('failed')
        value = self.result(source, projection)
        self.assertEqual(value['last_scheduled_cycle']['status'], 'failed')
        self.assertFalse(value['summary']['scheduled_success_proven'])

    def test_missing_or_conflicting_dates_stay_unknown(self):
        for field, value in [('finished_at', None), ('finished_at', 'not-a-date'),
                ('finished_at', '2099-01-01T00:00:00Z'), ('request_id', '20261024T050000Z-123')]:
            source, projection = self.fixture(); projection['last_scheduled_cycle'][field] = value
            self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')
        source, projection = self.fixture();projection['observed_at'] = '2026-10-23T00:00:00Z'
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')

    def test_collection_failure_never_becomes_success(self):
        source, projection = self.fixture()
        self.assertEqual(self.result(source, projection, 'collection_timeout')['last_scheduled_cycle']['state'], 'unknown')
        source['data']['git']['evidence']['collection_error'] = 'source_missing'
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')

    def test_status_and_identity_conflicts(self):
        source, projection = self.fixture();source['data']['git']['status'] = 'failed'
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')
        source, projection = self.fixture();source['data']['git']['operation_id'] = 'b'*32
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')
        source, projection = self.fixture();projection['last_scheduled_cycle']['origin'] = 'manual'
        self.assertEqual(self.result(source, projection)['last_scheduled_cycle']['state'], 'unknown')

    def test_worker_exit_and_start_conflicts(self):
        for changes in [{'exit_code': 1}, {'started_at': T2}]:
            source, projection = self.fixture();source['data']['git'].update(changes)
            value = self.result(source, projection)
            self.assertEqual(value['last_scheduled_cycle']['state'], 'unknown')
            self.assertFalse(value['summary']['scheduled_success_proven'])

    def test_baseline_failure_survives_missing_projection(self):
        value = self.result(base('success'), None, 'source_missing', {'worker_cycle': {'status': 'failed', 'reason': 'security_scan_failed', 'finished_at': T1, 'operation_id': 'c'*32}})
        self.assertEqual(value['known_failure_history'][0]['status'], 'failed')
        self.assertEqual(value['known_failure_history'][0]['operation_id'], 'c'*32)
        self.assertEqual(value['last_scheduled_cycle']['state'], 'unknown')

if __name__ == '__main__':
    unittest.main()
