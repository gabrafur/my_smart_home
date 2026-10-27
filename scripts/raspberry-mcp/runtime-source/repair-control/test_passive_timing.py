"""Cross-language protocol verification; all frames and 25h are synthetic."""
import copy,datetime,json,subprocess,unittest,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('passive_projection',Path(__file__).with_name('health_summary.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Projection(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  root=Path(__file__).resolve().parents[4]
  code="""import {hostTimingTransition as next} from './nodered/tools/host-observation-timing.mjs';
import {frame,limits} from './nodered/tools/host-timing-fixtures.mjs';
let state=next(null,frame());for(let tick=20;tick<=90000;tick+=20)state=next(state,frame(tick));
console.log(JSON.stringify({context:{host_observer_timing_v1:state,host_observer_timing_policy_v1:limits},report:frame(90000).report}));"""
  result=subprocess.run(['node','--max-old-space-size=32','--input-type=module','-'],input=code,text=True,cwd=root,capture_output=True,timeout=20,check=True)
  cls.fixture=json.loads(result.stdout);cls.now=datetime.datetime.fromisoformat(cls.fixture['context']['host_observer_timing_v1']['observed_at'].replace('Z','+00:00')).timestamp()
 def project(self,value=None):
  value=self.fixture if value is None else value
  return m.project_passive_host_timing(value['context'],value['report'],self.now)
 def test_actual_JS_counters_and_25h_window_match_closed_Python_projection(self):
  result=self.project();self.assertEqual(result['state'],'observed');self.assertEqual(result['sources']['resources']['observed'],4500);self.assertEqual(result['window24h']['counters']['resources.observed'],4320);self.assertEqual(result['anchor_count'],25)
  self.assertFalse(result['full24h_proven']);self.assertFalse(result['all_event_latency_proven'])
 def test_missing_old_observations_stay_unknown_not_zero(self):
  result=m.project_passive_host_timing({},self.fixture['report'],self.now);self.assertEqual(result['state'],'unknown');self.assertIsNone(result['sources']);self.assertIsNone(result['window24h'])
 def test_clock_or_invalid_state_uses_closed_reason(self):
  value=copy.deepcopy(self.fixture);value['context']['host_observer_timing_v1']={'version':1,'state':'unknown','collection_error':'PRIVATE_SENTINEL'};result=self.project(value);self.assertEqual(result['collection_error'],'passive_timing_invalid');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
 def test_counter_conflicts_never_export_success(self):
  for mutate in [lambda s:s['sources']['resources'].__setitem__('observed',5000),lambda s:s['sources']['resources'].__setitem__('missing',1),lambda s:s['sources']['resources'].__setitem__('unknown',True),lambda s:s['sources']['resources'].__setitem__('max_source_to_reader_ms',float('inf'))]:
   value=copy.deepcopy(self.fixture);mutate(value['context']['host_observer_timing_v1']);self.assertEqual(self.project(value)['state'],'unknown')
 def test_expanded_or_future_or_changed_identity_is_rejected(self):
  for mutate in [lambda v:v['context']['host_observer_timing_v1']['limits'].__setitem__('private',1),lambda v:v['context']['host_observer_timing_v1'].__setitem__('observed_at','2099-01-01T00:00:00Z'),lambda v:v['report'].__setitem__('instance_id','c'*64)]:
   value=copy.deepcopy(self.fixture);mutate(value);self.assertEqual(self.project(value)['state'],'unknown')
 def test_bounded_anchors_and_window_counts_validated(self):
  for mutate in [lambda s:s['anchors'].append(s['anchors'][-1]),lambda s:s['window24h']['counters'].__setitem__(0,-1),lambda s:s['window24h'].__setitem__('minimum_span_seconds',1),lambda s:s['anchors'].__setitem__(0,['PRIVATE_SENTINEL'])]:
   value=copy.deepcopy(self.fixture);mutate(value['context']['host_observer_timing_v1']);result=self.project(value);self.assertEqual(result['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
 def test_optional_private_context_is_not_exported(self):
  value=copy.deepcopy(self.fixture);value['context']['host_observer_timing_v1']['private']='PRIVATE_SENTINEL';self.assertNotIn('PRIVATE_SENTINEL',json.dumps(self.project(value)))
 def test_window_must_match_actual_anchor_delta_and_monotonic_span(self):
  for mutate in [lambda s:s['window24h']['counters'].__setitem__(10,0),lambda s:s['window24h'].__setitem__('minimum_span_seconds',86401),lambda s:s['window24h'].__setitem__('started_at',s['observed_at'])]:
   value=copy.deepcopy(self.fixture);mutate(value['context']['host_observer_timing_v1']);self.assertEqual(self.project(value)['state'],'unknown')
if __name__=='__main__':unittest.main()
