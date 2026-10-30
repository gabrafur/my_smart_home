import copy
import unittest
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location('_mcp_active_health_projection', Path(__file__).with_name('health_summary.py'))
_active = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_active)
correct_backups, publication, static_capabilities, project_acceptance_report = _active.correct_backups, _active.publication, _active.static_capabilities, _active.project_acceptance_report

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



class AcceptanceReportTests(unittest.TestCase):
    def fixture(self):
        return {'schema_version':1,'source':'fixed_readonly_procmon_acceptance_capture',
            'observed_at':'2026-10-25T20:33:00Z','scheduled_for':'2026-10-25T20:33:00Z',
            'collection_error':None,'cadence':{'window_start':1792873980,'window_end':1792960380,
            'window_seconds':86400,'max_sample_gap_seconds':56,'issues':[], 'cadence_24h_proven':True},
            'runtime':{'observed_span_seconds':86401,'nonmonotonic_pairs':0,'invalid_telemetry_rows':0,
                'distinct_boot_count':1,'journal_exit':0,'journal_limit_reached':False,'journal_diagnostic_category':'none'},
            'private_extra':'SYNTHETIC-PRIVATE'}

    def test_report_is_sanitized_and_not_whole_goal(self):
        value=project_acceptance_report(self.fixture(),1792960400)
        self.assertTrue(value['cadence_and_emitted_runtime_window_proven'])
        self.assertFalse(value['full_goal_accepted'])
        self.assertFalse(value['administrative_admission_extended'])
        self.assertNotIn('SYNTHETIC-PRIVATE',str(value))

    def test_report_missing_future_and_failure_keep_unknown(self):
        self.assertEqual(project_acceptance_report(None,1792960400)['state'],'unknown')
        value=self.fixture();value['collection_error']='SYNTHETIC-PRIVATE'
        result=project_acceptance_report(value,1792960400)
        self.assertEqual(result['state'],'unknown');self.assertFalse(result['cadence_and_emitted_runtime_window_proven'])
        self.assertNotIn('SYNTHETIC-PRIVATE',str(result))
        self.assertEqual(project_acceptance_report(self.fixture(),1792880000)['state'],'unknown')

    def test_MCP_recovers_immutable_window_without_latest_pointer(self):
        from unittest.mock import Mock, patch
        reader=Mock(return_value=(self.fixture(),None))
        namespace=project_acceptance_report.__globals__
        with patch.dict(namespace, {'read_metadata':reader}), patch('time.time',return_value=1792960400):
            value=namespace['procmon_acceptance_observation']()
        self.assertEqual(value['state'],'observed')
        self.assertTrue(reader.call_args.args[0].endswith('/window-2033.json'))
        reader=Mock(return_value=(None,'source_missing'))
        with patch.dict(namespace, {'read_metadata':reader}), patch('time.time',return_value=1792960400):
            value=namespace['procmon_acceptance_observation']()
        self.assertEqual(value['state'],'unknown')
        self.assertEqual(reader.call_count,1)

    def test_report_gap_bad_clock_and_journal_warning_refuse_acceptance(self):
        for field, change in [('cadence',{'max_sample_gap_seconds':112}),('cadence',{'issues':['clock_discontinuity']}),
                ('cadence',{'window_start':None}),('runtime',{'journal_diagnostic_category':'reader_address_space_insufficient'}),
                ('runtime',{'distinct_boot_count':2})]:
            value=self.fixture();value[field].update(change)
            self.assertFalse(project_acceptance_report(value,1792960400)['cadence_and_emitted_runtime_window_proven'])


class HostObservationTests(unittest.TestCase):
    def fixture(self):
        now = 1000000
        at = '1970-01-12T13:46:40Z'
        policy = {'max_report_age_ms':30000, 'max_resource_age_ms':45000,
            'event_confirm_ms':5000, 'resource_confirm_ms':20000, 'observation_confirm_ms':20000,
            'cpu_busy_percent':90, 'memory_available_mib':512, 'disk_used_percent':85,
            'inodes_used_percent':85, 'temperature_celsius':80}
        report = {'schema_version':1, 'source':'fixed_readonly_host_observer', 'observed_at':at,
            'instance_id':'a'*64, 'boot_id_sha256':'b'*64, 'sequence':5, 'evicted_event_records':1,
            'sources':{x:{'state':'connected','collection_error':None} for x in ['docker','systemd']},
            'resources':{'observed_at':at,'collection_errors':[], 'data':{x:10 for x in _active.HOST_METRICS}},
            'producer_cost':{'self_cpu_seconds':1,'self_peak_rss_bytes':1024}}
        native = {'systemd:procmon':{'kind':'native','source':'systemd','name':'procmon','action':'started','occurred_at':at}}
        context = {'host_observer_policy_v1':policy,
            'host_observer_cursor_v1':{'instance':'a'*64,'sequence':5,'last_report_at':now*1000,'states':native},
            'host_observer_incidents_v1':{'version':1,'incidents':{}}}
        return report, context, now

    def project(self, report, context, now, *errors):
        return _active.project_host_observation(report,context,now,*errors)

    def test_current_metadata_is_not_operational_or_complete_goal_acceptance(self):
        report,context,now=self.fixture();out=self.project(report,context,now)
        self.assertEqual(out['state'],'observed')
        self.assertIsNone(out['collection_error'])
        self.assertEqual(out['operational_health'],'unknown')
        self.assertTrue(out['producer']['within_visual_report_validity'])
        self.assertFalse(out['Eva_execution_proven'])
        self.assertFalse(out['full24h_proven'])
        self.assertFalse(out['PC_off_proven'])
        self.assertEqual(out['NodeRED']['native_role_observations'][0]['role'],'procmon')

    def test_missing_conflicting_or_stale_dates_preserve_unknown(self):
        for change in [lambda r,c:r.update(observed_at=None),
                lambda r,c:r.update(observed_at='1970-01-12T13:46:50Z'),
                lambda r,c:r['resources'].update(observed_at='1970-01-12T13:46:50Z'),
                lambda r,c:c['host_observer_cursor_v1'].update(last_report_at=(1000010)*1000)]:
            report,context,now=self.fixture();change(report,context)
            self.assertEqual(self.project(report,context,now)['state'],'unknown')
        report,context,now=self.fixture()
        out=self.project(report,context,now+61)
        self.assertEqual(out['state'],'unknown')
        self.assertFalse(out['producer']['within_visual_report_validity'])

    def test_failed_collection_missing_policy_or_instance_sequence_conflict(self):
        report,context,now=self.fixture()
        for errors in [('source_missing',None),(None,'source_invalid_or_unavailable')]:
            self.assertEqual(self.project(report,context,now,*errors)['state'],'unknown')
        for change in [lambda c:c.pop('host_observer_policy_v1'),
                lambda c:c['host_observer_cursor_v1'].update(instance='c'*64),
                lambda c:c['host_observer_cursor_v1'].update(sequence=6),
                lambda c:c['host_observer_policy_v1'].update(cpu_busy_percent=True)]:
            candidate=copy.deepcopy(context);change(candidate)
            self.assertEqual(self.project(report,candidate,now)['state'],'unknown')

    def test_private_extra_fields_are_never_exported(self):
        report,context,now=self.fixture();report['private']='PRIVATE_SENTINEL'
        report['resources']['private']='PRIVATE_SENTINEL';context['private']='PRIVATE_SENTINEL'
        context['host_observer_cursor_v1']['states']['private']={'message':'PRIVATE_SENTINEL'}
        self.assertNotIn('PRIVATE_SENTINEL',str(self.project(report,context,now)))
        report['resources']['collection_errors']=['PRIVATE_SENTINEL']
        out=self.project(report,context,now)
        self.assertEqual(out['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',str(out))

    def test_missing_resource_metric_is_null_not_zero_or_recovery(self):
        report,context,now=self.fixture();report['resources']['data']['cpu_busy_percent']=None
        out=self.project(report,context,now)
        self.assertIsNone(out['producer']['resources']['data']['cpu_busy_percent'])
        self.assertEqual(out['operational_health'],'unknown')
        report['resources']['data']['cpu_busy_percent']=float('nan')
        self.assertEqual(self.project(report,context,now)['state'],'unknown')

    def test_incident_intent_is_not_delivery_and_unknown_is_preserved(self):
        report,context,now=self.fixture()
        context['host_observer_incidents_v1']['incidents']['native_systemd_procmon']={
            'first_seen_at':(now-20)*1000,'last_seen_at':now*1000,'notified_at':(now-10)*1000,
            'current_evidence':'unknown','private':'PRIVATE_SENTINEL'}
        out=self.project(report,context,now);incident=out['NodeRED']['incident_observations'][0]
        self.assertEqual(incident['evidence'],'unknown');self.assertTrue(incident['notification_intent_recorded'])
        self.assertNotIn('PRIVATE_SENTINEL',str(out));self.assertFalse(out['Eva_execution_proven'])
        context['host_observer_incidents_v1']['incidents']['native_systemd_procmon']['notified_at']=(now+5)*1000
        self.assertEqual(self.project(report,context,now)['state'],'unknown')

    def legacy_record(self, now):
        return {'role':'native_systemd_procmon','reason':'legacy_notified_before_first_seen',
            'quarantined_at':now*1000,'original':{'kind':'native','first_seen_at':(now-20)*1000,
                'last_seen_at':(now-10)*1000,'notified_at':(now-30)*1000,'current_evidence':'failed',
                'source_time_kind':'producer_occurrence','sample_count':0,'last_sample_at':None}}

    def test_quarantined_original_chronology_is_unknown_history_not_recovery(self):
        report,context,now=self.fixture();record=self.legacy_record(now);original=copy.deepcopy(record)
        context['host_observer_incidents_v1']['legacy_history_v1']={'version':1,'records':[record]}
        out=self.project(report,context,now)
        self.assertEqual(out['state'],'observed');self.assertIsNone(out['collection_error'])
        self.assertEqual(out['NodeRED']['incident_observations'],[])
        row=out['NodeRED']['legacy_incident_observations'][0]
        self.assertEqual(row['historical_evidence'],'unknown');self.assertTrue(row['original_chronology_retained'])
        self.assertFalse(row['recovery_proven']);self.assertTrue(row['not_current_failure_proof'])
        self.assertEqual(out['operational_health'],'unknown');self.assertFalse(out['full24h_proven'])
        self.assertEqual(record,original)

    def test_legacy_history_rejects_private_extra_future_unknown_or_valid_current_rows(self):
        report,context,now=self.fixture()
        for update in [{'role':'PRIVATE_SENTINEL'},{'private':'PRIVATE_SENTINEL'},
                       {'quarantined_at':(now+100)*1000},{'reason':'PRIVATE_SENTINEL'}]:
            with self.subTest(update=update):
                context['host_observer_incidents_v1']['legacy_history_v1']={'version':1,'records':[{**self.legacy_record(now),**update}]}
                out=self.project(report,context,now)
                self.assertEqual(out['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',str(out))
                self.assertIn('legacy_incident_metadata_invalid',out['collection_error'])
        for update in [{'private':'PRIVATE_SENTINEL'},{'kind':'resource'}, {'notified_at':(now-15)*1000}]:
            record=self.legacy_record(now);record['original'].update(update)
            context['host_observer_incidents_v1']['legacy_history_v1']={'version':1,'records':[record]}
            out=self.project(report,context,now);self.assertEqual(out['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',str(out))

    def test_legacy_history_rejects_duplicates_and_boolean_schema(self):
        report,context,now=self.fixture();record=self.legacy_record(now)
        for history in [{'version':1,'records':[record,copy.deepcopy(record)]},{'version':True,'records':[record]}]:
            context['host_observer_incidents_v1']['legacy_history_v1']=history
            out=self.project(report,context,now);self.assertEqual(out['state'],'unknown')
            self.assertEqual(out['NodeRED']['legacy_incident_observations'],[])

    def test_fixed_entry_calls_only_two_reviewed_paths(self):
        from unittest.mock import patch
        with patch.dict(_active.host_observation.__globals__,{'_observer_json':lambda *args:(None,'source_missing')}), patch('time.time',return_value=1000000):
            self.assertEqual(_active.host_observation()['state'],'unknown')
        from unittest.mock import Mock
        reader=Mock(side_effect=[(None,'source_missing'),(None,'source_missing')])
        with patch.dict(_active.host_observation.__globals__,{'_observer_json':reader}),patch('time.time',return_value=1000000):
            _active.host_observation()
        self.assertEqual(reader.call_args_list[0].args,('/mnt/data/docker/nodered/.host-health-observer','report.json',0))
        self.assertEqual(reader.call_args_list[1].args,('/mnt/data/docker/nodered/context/host_observer_tab','flow.json',1000))

    def test_reader_rejects_links_wrong_modes_bad_json_and_oversize(self):
        import os
        import tempfile
        import json
        with tempfile.TemporaryDirectory()as name:
            path=Path(name);path.chmod(0o755);file=path/'report.json';file.write_text('{}');file.chmod(0o644)
            self.assertEqual(_active._observer_json(name,'report.json',os.getuid()),({},None))
            file.chmod(0o666);self.assertIsNone(_active._observer_json(name,'report.json',os.getuid())[0]);file.chmod(0o644)
            os.link(file,path/'hardlink');self.assertIsNone(_active._observer_json(name,'report.json',os.getuid())[0]);(path/'hardlink').unlink()
            file.unlink();file.symlink_to('absent');self.assertIsNone(_active._observer_json(name,'report.json',os.getuid())[0]);file.unlink()
            for data in ['[1]','{','x'*65537]:
                file.write_text(data);file.chmod(0o644)
                self.assertIsNone(_active._observer_json(name,'report.json',os.getuid())[0])
            path.chmod(0o777);self.assertIsNone(_active._observer_json(name,'report.json',os.getuid())[0])

if __name__ == '__main__':
    unittest.main()
