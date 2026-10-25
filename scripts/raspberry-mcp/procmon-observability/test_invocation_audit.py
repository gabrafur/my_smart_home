import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('invocation_audit',Path(__file__).with_name('invocation_audit.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class InvocationTests(unittest.TestCase):
    def fixture(self,at=1000000,identity='a'*32):
        def envelope(timestamp,**rest):return {'__REALTIME_TIMESTAMP':str(timestamp*1000000),'__MONOTONIC_TIMESTAMP':str(timestamp*1000000),'_BOOT_ID':'b'*32,**rest}
        manager=[envelope(at,INVOCATION_ID=identity,MESSAGE_ID=a.START),envelope(at+1,INVOCATION_ID=identity,MESSAGE_ID=a.SUCCESS)]
        body={'source':'procmon_runtime_v1','status':'completed','observed_at':at+1,'monotonic_ms':(at+1)*1000,'wall_ms':500,'cpu_us':1000,'peak_rss_bytes':1000000,'process_total_cpu_us':2000,'signals_observed':[]}
        native=[envelope(at+1,_SYSTEMD_INVOCATION_ID=identity,MESSAGE=json.dumps(body))]
        cost={'source':'procmon_unit_accounting_v1','state':'observed','collection_error':None,'collector_invocation_id_sha256':hashlib.sha256(identity.encode()).hexdigest(),'cpu_usage_ns':3000000,'started_monotonic_us':at*1000000,'exited_monotonic_us':(at+1)*1000000}
        account=[envelope(at+1,MESSAGE=json.dumps(cost))]
        return manager,native,account

    def test_identity_pair_distinguishes_process_and_whole_unit_cost(self):
        value=a.correlate(*self.fixture(),1000002)
        self.assertEqual(value['started_invocations'],1);self.assertEqual(value['native_unit_cgroup_CPU_rows'],1)
        self.assertEqual(value['sum_process_CPU_us_to_telemetry'],2000);self.assertEqual(value['sum_native_unit_CPU_ns'],3000000)
        self.assertFalse(value['manager_start_window_coverage_proven']);self.assertFalse(value['full_goal_accepted'])

    def test_missing_killed_duplicate_or_inflight_never_become_zero_cost(self):
        manager,native,account=self.fixture()
        for n in [[],native+native]:
            value=a.correlate(manager,n,account,1000002)
            self.assertFalse(value['all_starts_have_correlated_runtime_in_window'])
        value=a.correlate(manager[:1],[],[],1000002)
        self.assertEqual(value['in_flight_invocations'],1);self.assertIsNone(value['sum_native_unit_CPU_ns'])

    def test_killed_invocation_can_have_unit_CPU_but_no_process_peak(self):
        manager,native,account=self.fixture();manager[-1]['MESSAGE_ID']=a.FAILURE
        value=a.correlate(manager,[],account,1000002)
        self.assertEqual(value['missing_runtime_invocations'],1)
        self.assertEqual(value['native_unit_cgroup_CPU_rows'],1)
        self.assertEqual(value['sum_native_unit_CPU_ns'],3000000)
        self.assertEqual(value['invocations_without_observed_peak_rss'],1)
        self.assertIsNone(value['max_observed_peak_rss_bytes'])
        self.assertFalse(value['full_goal_accepted'])

    def test_status_and_identity_conflicts_are_explicit(self):
        manager,native,account=self.fixture();manager[-1]['MESSAGE_ID']=a.FAILURE
        self.assertEqual(a.correlate(manager,native,account,1000002)['temporal_or_state_conflicts'],1)
        native[0]['_SYSTEMD_INVOCATION_ID']='c'*32
        self.assertEqual(a.correlate(manager,native,account,1000002)['missing_runtime_invocations'],1)

    def test_old_CPU_scope_and_memory_remain_observations_not_inferences(self):
        manager,native,account=self.fixture();body=json.loads(native[0]['MESSAGE']);body.pop('process_total_cpu_us');native[0]['MESSAGE']=json.dumps(body)
        value=a.correlate(manager,native,[],1000002)
        self.assertEqual(value['legacy_observer_CPU_rows'],1);self.assertEqual(value['native_process_total_CPU_rows'],0)
        self.assertEqual(value['sum_legacy_observer_CPU_us'],1000);self.assertEqual(value['native_unit_cgroup_CPU_rows'],0)

    def test_private_text_and_raw_invocation_identifiers_never_escape(self):
        manager,native,account=self.fixture();body=json.loads(native[0]['MESSAGE']);body['private']='PRIVATE_SENTINEL';native[0]['MESSAGE']=json.dumps(body)
        text=json.dumps(a.correlate(manager,native,account,1000002))
        self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn('a'*32,text);self.assertNotIn('b'*32,text)

    def test_full_window_requires_all_starts_and_native_accounting(self):
        now=2000000;manager=[];native=[];account=[]
        for at in range(now-86400,now-1,56):
            m,n,c=self.fixture(at,hashlib.md5(str(at).encode()).hexdigest());manager+=m;native+=n;account+=c
        value=a.correlate(manager,native,account,now)
        self.assertTrue(value['all_starts_have_correlated_runtime_in_window']);self.assertTrue(value['all_started_invocation_unit_CPU_observed'])
        self.assertFalse(value['full_goal_accepted'])
        self.assertFalse(a.correlate(manager,native,account[:-1],now)['all_started_invocation_unit_CPU_observed'])
        self.assertFalse(a.correlate(manager,native[:-1],account,now)['all_starts_have_correlated_runtime_in_window'])

    def test_empty_grep_is_missing_evidence_other_failures_are_unknown(self):
        import types
        with patch.object(a.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'')):
            self.assertEqual(a.read_fixed(['--grep=fixed']),([],False))
            with self.assertRaises(ValueError):a.read_fixed(['_PID=1'])
        for code,error in [(1,b'PRIVATE_SENTINEL'),(2,b'')]:
            with patch.object(a.subprocess,'run',return_value=types.SimpleNamespace(returncode=code,stdout=b'',stderr=error)):
                with self.assertRaises(ValueError):a.read_fixed(['--grep=fixed'])

    def test_reader_arguments_are_fixed_and_limit_failure_cannot_accept(self):
        with patch.object(a,'read_fixed',side_effect=[([],False),([],False),([],False)])as read:
            value=a.audit(1000000)
        self.assertEqual(read.call_count,3)
        self.assertIn('UNIT=raspberry-procmon.service',read.call_args_list[0].args[0])
        self.assertIn('--unit=raspberry-host-observation.service',read.call_args_list[2].args[0])
        self.assertFalse(value['collector_invoked']);self.assertFalse(value['state_changed'])

if __name__=='__main__':unittest.main()
