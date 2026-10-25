import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock
P=Path(__file__).parent

def module(name):
 target=P/'capture.py' if name=='capture' else P.parent/'runtime-source/repair-control/health_summary.py'
 spec=importlib.util.spec_from_file_location('_fifth_'+name,target);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
h=module('health_summary');c=module('capture')
FIFTH='2026-10-26T16:00:00Z';NOW=h.stamp(FIFTH)+60

class SelectionTests(unittest.TestCase):
 def test_missing_fifth_is_unknown_without_old_fallback(self):
  reader=Mock(return_value=(None,'source_missing'))
  with patch('time.time',return_value=NOW),patch.object(h,'read_metadata',reader):r=h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertTrue(reader.call_args.args[0].endswith('/window-1600.json'))
  self.assertEqual(r['state'],'unknown');self.assertFalse(r['full_goal_accepted'])
 def test_before_fifth_still_selects_fourth(self):
  reader=Mock(return_value=(None,'source_missing'))
  with patch('time.time',return_value=h.stamp(FIFTH)-1),patch.object(h,'read_metadata',reader):h.procmon_acceptance_observation()
  self.assertTrue(reader.call_args.args[0].endswith('/window-1100.json'))
 def test_fifth_is_observation_without_inferred_full_acceptance(self):
  raw={'schema_version':1,'source':'fixed_readonly_procmon_acceptance_capture','observed_at':dt.datetime.fromtimestamp(NOW,dt.timezone.utc).isoformat(),'scheduled_for':FIFTH,'collection_error':None}
  r=h.project_acceptance_report(raw,NOW);self.assertEqual(r['state'],'observed');self.assertEqual(r['scheduled_for'],FIFTH)
  for key in ['full_goal_accepted','PC_off_proven','all_event_latency_proven','cadence_and_emitted_runtime_window_proven','unit_CPU_24h_window_proven']:self.assertFalse(r[key])
 def test_future_and_wrong_date_never_accept(self):
  for at,scheduled in [(NOW+10,FIFTH),(NOW,'2026-10-27T16:00:00Z')]:
   raw={'schema_version':1,'source':'fixed_readonly_procmon_acceptance_capture','observed_at':dt.datetime.fromtimestamp(at,dt.timezone.utc).isoformat(),'scheduled_for':scheduled}
   self.assertEqual(h.project_acceptance_report(raw,NOW)['state'],'unknown')
 def test_failed_fifth_is_not_replaced_with_old_success(self):
  raw={'schema_version':1,'source':'fixed_readonly_procmon_acceptance_capture','observed_at':dt.datetime.fromtimestamp(NOW,dt.timezone.utc).isoformat(),'scheduled_for':FIFTH,'collection_error':'bounded_capture_incomplete'}
  with patch('time.time',return_value=NOW),patch.object(h,'read_metadata',return_value=(raw,None)) as reader:r=h.procmon_acceptance_observation()
  self.assertEqual(reader.call_count,1);self.assertEqual(r['state'],'unknown');self.assertEqual(r['collection_error'],'capture_incomplete')

class CaptureTests(unittest.TestCase):
 def test_fifth_schedule_preserves_four_previous_dates_and_lease(self):
  self.assertEqual(c.SCHEDULE[:-1],('2026-10-25T04:30:00Z','2026-10-25T15:20:00Z','2026-10-25T20:33:00Z','2026-10-26T11:00:00Z'))
  self.assertEqual(c.SCHEDULE[-1],FIFTH);self.assertLess(h.stamp(FIFTH),(1793048374 + 764524 / 1_000_000))
 def test_existing_fifth_immutable_report_does_not_collect_again(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'window-1600.json').write_text('original')
   with patch.object(c,'ROOT',root),patch.object(c,'STATE',root),patch.object(c,'__file__',str(root/'capture.py')),patch.object(c.os,'geteuid',return_value=0),patch.object(c.sys,'argv',['capture.py']),patch.object(c.resource,'setrlimit'),patch.object(c.signal,'signal'),patch.object(c.signal,'alarm'),patch.object(c.time,'time',return_value=NOW),patch.object(c,'load') as loader,patch('builtins.print'):
    c.main()
   loader.assert_not_called();self.assertEqual((root/'window-1600.json').read_text(),'original')
 def test_single_boot_and_clock_gates_unchanged(self):
  cadence={'cadence_24h_proven':True};runtime={'observed_span_seconds':86400,'distinct_boot_count':1,'nonmonotonic_pairs':0,'invalid_telemetry_rows':0,'journal_limit_reached':False,'journal_exit':0,'journal_diagnostic_category':'none'}
  self.assertTrue(c.combine(cadence,runtime)['cadence_and_emitted_runtime_window_proven'])
  for change in [{'distinct_boot_count':2},{'nonmonotonic_pairs':1},{'invalid_telemetry_rows':1},{'journal_limit_reached':True},{'observed_span_seconds':86399},{'journal_exit':1}]:self.assertFalse(c.combine(cadence,{**runtime,**change})['cadence_and_emitted_runtime_window_proven'])
  self.assertFalse(c.combine(cadence,runtime)['full_goal_accepted'])
 def test_runtime_reader_retains_25h_and_bounded_journal_without_invoking_collector(self):
  fake=types.SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
  summarize=Mock(return_value={key:[] if key=='coverage' else 0 for key in c.RUNTIME_KEYS})
  with patch.object(c.subprocess,'run',return_value=fake) as run:c.runtime_audit(summarize,NOW)
  args=run.call_args.args[0];self.assertEqual(args[0],'/usr/bin/journalctl');self.assertIn('--since=@'+str(int(NOW)-90000),args)
  self.assertEqual(summarize.call_args.args[1],90000);self.assertIn('--lines=2048',args)

if __name__=='__main__':unittest.main()
