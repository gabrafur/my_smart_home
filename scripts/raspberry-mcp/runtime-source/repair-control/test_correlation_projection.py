import importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch,Mock
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('correlation_projection_candidate',ROOT/'health_summary.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
spec=importlib.util.spec_from_file_location('native_audit_candidate',ROOT.parents[1]/'procmon-observability/invocation_audit.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class CorrelationTests(unittest.TestCase):
 def fixture(self):
  now=1000000;manager=[];native=[];account=[]
  for at in range(now-86400,now,55):
   identity=hex(at)[2:].zfill(32)
   def env(time,**kw):return {'__REALTIME_TIMESTAMP':str(time*1000000),'__MONOTONIC_TIMESTAMP':str(time*1000000),'_BOOT_ID':'b'*32,**kw}
   manager += [env(at,INVOCATION_ID=identity,MESSAGE_ID=a.START),env(at+1,INVOCATION_ID=identity,MESSAGE_ID=a.SUCCESS)]
   native += [env(at+1,_SYSTEMD_INVOCATION_ID=identity,MESSAGE=json.dumps({'source':'procmon_runtime_v1','status':'completed','observed_at':at+1,'monotonic_ms':(at+1)*1000,'wall_ms':500,'cpu_us':1000,'process_total_cpu_us':2000,'peak_rss_bytes':1000000}))]
   import hashlib
   account += [env(at+1,MESSAGE=json.dumps({'source':'procmon_unit_accounting_v1','collector_invocation_id_sha256':hashlib.sha256(identity.encode()).hexdigest(),'state':'observed','collection_error':None,'cpu_usage_ns':3000000,'started_monotonic_us':at*1000000,'exited_monotonic_us':(at+1)*1000000}))]
  value=a.correlate(manager,native,account,now);value['journal_collection_error']=None;return value
 def test_full_correlated_window_separates_CPU_and_RSS_not_whole_goal(self):
  d=h.project_invocation_correlation(self.fixture(),1000000);self.assertTrue(d['unit_CPU_24h_window_proven']);self.assertTrue(d['all_started_process_peak_RSS_observed']);self.assertTrue(d['missing_or_killed_invocation_cost_proven']);self.assertFalse(d['full_goal_accepted'])
 def test_killed_missing_runtime_can_have_complete_unit_CPU_without_RSS_proof(self):
  value=self.fixture();value.update(missing_runtime_invocations=1,observed_peak_rss_rows=value['started_invocations']-1,invocations_without_observed_peak_rss=1,all_starts_have_correlated_runtime_in_window=False)
  d=h.project_invocation_correlation(value,1000000);self.assertTrue(d['unit_CPU_24h_window_proven']);self.assertFalse(d['missing_or_killed_invocation_cost_proven'])
 def test_inflight_bad_rows_and_missing_CPU_never_accept(self):
  for change in [{'in_flight_invocations':1},{'invalid_accounting_rows':1},{'native_unit_cgroup_CPU_rows':1},{'sum_native_unit_CPU_ns':None},{'one_boot':False},{'window_start':None},{'observed_at':1000002}]:
   value=self.fixture();value.update(change);self.assertFalse(h.project_invocation_correlation(value,1000000)['unit_CPU_24h_window_proven'])
 def test_no_correlation_in_old_report_is_unknown(self):
  self.assertEqual(h.project_invocation_correlation(None,1000000)['state'],'unknown')
 def test_raw_fields_and_private_errors_never_escape(self):
  value=self.fixture();value.update(journal_collection_error='PRIVATE_SENTINEL',private='PRIVATE_SENTINEL',observed_signals={'SIGTERM':1,'PRIVATE_SENTINEL':8})
  d=h.project_invocation_correlation(value,1000000);self.assertEqual(d['state'],'unknown');self.assertFalse(d['unit_CPU_24h_window_proven']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d));self.assertEqual(d['observed_signals'],{'SIGTERM':1})
 def test_fourth_due_missing_window_never_substitutes_old_success(self):
  reader=Mock(return_value=(None,'source_missing'))
  with patch.object(h,'read_metadata',reader),patch('time.time',return_value=1793012460):
   result=h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertTrue(reader.call_args.args[0].endswith('/window-1100.json'));self.assertEqual(result['state'],'unknown')
if __name__=='__main__':unittest.main()
