"""Pure scheduling/projection tests. No root, journal, collector or service call."""
import ast,contextlib,datetime as dt,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch,Mock
P=Path(__file__).parent

def module(name):
 target=P/'capture.py'if name=='capture'else P.parent/'runtime-source/repair-control/health_summary.py'
 spec=importlib.util.spec_from_file_location('_headroom_window_'+name,target);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
c=module('capture');h=module('health_summary')
SIXTH='2026-10-28T10:00:00Z';AT=h.stamp(SIXTH)
OLD=('2026-10-25T04:30:00Z','2026-10-25T15:20:00Z','2026-10-25T20:33:00Z','2026-10-26T11:00:00Z','2026-10-26T16:00:00Z','2026-10-26T20:00:00Z','2026-10-27T23:00:00Z')
OLD_NAMES=('window-0430.json','window-1520.json','window-2033.json','window-1100.json','window-1600.json','window-2000.json','window-2300.json')

def report(now=AT,error=None):
 return {'schema_version':1,'source':'fixed_readonly_procmon_acceptance_capture','observed_at':dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),'scheduled_for':SIXTH,'collection_error':error}

class HeadroomWindowTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.state=Path(self.tmp.name)
  self.original={name:('immutable-'+name).encode()for name in OLD_NAMES}
  for name,value in self.original.items():(self.state/name).write_bytes(value)
 def unchanged(self):
  self.assertEqual({n:(self.state/n).read_bytes()for n in OLD_NAMES},self.original)
 def run_capture(self,now,failure=False):
  cadence=types.SimpleNamespace(BASE=self.state/'unread',read_history=Mock(return_value=[]),open_dir=Mock(return_value=99),read_at=Mock(return_value={}),assess=Mock(return_value={'cadence_24h_proven':False}))
  loader=Mock(side_effect=ValueError('fixture_failure'))if failure else Mock(side_effect=lambda name:cadence if name=='cadence_window'else types.SimpleNamespace(summarize=Mock()))
  writes=[];runtime=Mock(return_value={});correlation=Mock(return_value={})
  def atomic(name,data,replace=False):
   p=self.state/name
   if p.exists()and not replace:raise FileExistsError('immutable_fixture')
   writes.append(name);p.write_bytes(data)
  with contextlib.ExitStack()as stack:
   for obj,name,value in [(c,'ROOT',self.state),(c,'STATE',self.state),(c,'__file__',str(self.state/'capture.py')),(c.os,'geteuid',lambda:0),(c.sys,'argv',['capture.py']),(c.resource,'setrlimit',Mock()),(c.signal,'signal',Mock()),(c.signal,'alarm',Mock()),(c.time,'time',lambda:now),(c,'load',loader),(c,'atomic',atomic),(c,'runtime_audit',runtime),(c,'invocation_correlation',correlation),(c.os,'close',Mock()),(c.pwd,'getpwnam',lambda name:types.SimpleNamespace(pw_uid=1000))]:stack.enter_context(patch.object(obj,name,value))
   stack.enter_context(patch('builtins.print'));c.main()
  return writes,loader,runtime,correlation
 def test_eighth_appends_exactly_seven_original_capture_dates(self):
  self.assertEqual(c.SCHEDULE,(*OLD,SIXTH))
 def test_capture_not_due_before28Oct10_preserves_previous_receipt_without_collecting(self):
  writes,loader,runtime,correlation=self.run_capture(AT-1)
  self.assertEqual(writes,[]);loader.assert_not_called();runtime.assert_not_called();correlation.assert_not_called();self.assertFalse((self.state/'window-1000.json').exists());self.unchanged()
 def test_one_new_due_capture_preserves_old_windows_and_has_no_collector_effect(self):
  writes,loader,runtime,correlation=self.run_capture(AT)
  self.assertEqual(writes,['window-1000.json','latest.json']);self.assertEqual(runtime.call_count,1);self.assertEqual(correlation.call_count,1);self.unchanged()
  raw=json.loads((self.state/'window-1000.json').read_text());self.assertEqual(raw['scheduled_for'],SIXTH)
  for name in ('collector_invoked','production_changes','administrative_admission_extended','raw_messages_exported'):self.assertIs(raw[name],False)
  self.assertFalse(raw['acceptance']['full_goal_accepted'])
 def test_second_attempt_is_idempotent_without_new_reads_or_writes(self):
  self.run_capture(AT);first=(self.state/'window-1000.json').read_bytes();latest=(self.state/'latest.json').read_bytes()
  writes,loader,runtime,correlation=self.run_capture(AT+30)
  self.assertEqual(writes,[]);loader.assert_not_called();runtime.assert_not_called();correlation.assert_not_called();self.assertEqual((self.state/'window-1000.json').read_bytes(),first);self.assertEqual((self.state/'latest.json').read_bytes(),latest);self.unchanged()
 def test_failed_new_capture_stays_immutable_unknown_and_does_not_fallback(self):
  self.run_capture(AT,failure=True);raw=json.loads((self.state/'window-1000.json').read_text());self.assertEqual(raw['collection_error'],'bounded_capture_incomplete');self.unchanged()
  reader=Mock(return_value=(raw,None))
  with patch('time.time',return_value=AT+1),patch.object(h,'read_metadata',reader):out=h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertTrue(reader.call_args.args[0].endswith('window-1000.json'));self.assertEqual(out['state'],'unknown');self.assertEqual(out['collection_error'],'capture_incomplete');self.assertFalse(out['full_goal_accepted'])
 def test_reader_before28Oct10_selects27Oct23_window(self):
  reader=Mock(return_value=(None,'source_missing'))
  with patch('time.time',return_value=AT-1),patch.object(h,'read_metadata',reader):h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertTrue(reader.call_args.args[0].endswith('window-2300.json'))
 def test_missing_eighth_does_not_use_old_success(self):
  reader=Mock(return_value=(None,'source_missing'))
  with patch('time.time',return_value=AT),patch.object(h,'read_metadata',reader):out=h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertTrue(reader.call_args.args[0].endswith('window-1000.json'));self.assertEqual(out['state'],'unknown');self.assertFalse(out['full_goal_accepted'])
 def test_new_projection_does_not_infer_goal_or_cost_from_schedule(self):
  out=h.project_acceptance_report(report(),AT+1);self.assertEqual(out['state'],'observed');self.assertEqual(out['scheduled_for'],SIXTH)
  for key in ('full_goal_accepted','PC_off_proven','all_event_latency_proven','cadence_and_emitted_runtime_window_proven','unit_CPU_24h_window_proven','administrative_admission_extended'):self.assertFalse(out[key])
 def test_future_or_unannounced_schedule_stays_unknown(self):
  for raw in [report(AT+10),{**report(),'scheduled_for':'2026-10-27T20:00:00Z'}]:self.assertEqual(h.project_acceptance_report(raw,AT)['state'],'unknown')
 def test_timer_preserves_seven_original_dates_and_adds_one_fixed_readonly_capture(self):
  text=(P/'raspberry-procmon-acceptance.timer').read_text()
  self.assertEqual(text.count('OnCalendar='),8)
  for when in (*OLD,SIXTH):self.assertIn('OnCalendar='+when.replace('T',' ').replace('Z',' UTC'),text)
  for field in ['AccuracySec=1s','RandomizedDelaySec=0','Persistent=true','Unit=raspberry-procmon-acceptance.service']:self.assertIn(field,text)
if __name__=='__main__':unittest.main()
