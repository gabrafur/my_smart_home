"""Synthetic protocol facts; no live systemd/Docker requests or service control."""
import json,unittest
import observer as o
class TimingMetadata(unittest.TestCase):
 def event(self,source='docker',occurred=1000,now=1000.25):
  if source=='docker':return o.docker_event({'Type':'container','Action':'start','timeNano':int(occurred*1e9),'Actor':{'ID':'synthetic','Attributes':{'com.docker.compose.project':'docker','com.docker.compose.service':'nodered'}}},now,55.25)
  return o.journal_event({'UNIT':'raspberry-procmon.service','MESSAGE_ID':'39f53479d3a045ac8e11786248231fbf','__REALTIME_TIMESTAMP':str(int(occurred*1e6)),'__CURSOR':'synthetic'},now,55.25)
 def test_decoder_boundary_retains_monotonic_clock_and_actual_source_delay(self):
  for source in ['docker','systemd']:
   row=self.event(source);self.assertEqual(row['observer_monotonic_seconds'],55.25);self.assertEqual(row['source_to_observer_ms'],250);self.assertTrue(row['source_clock_ordered'])
 def test_future_source_is_not_fabricated_as_zero_latency(self):
  for source in ['docker','systemd']:
   row=self.event(source,occurred=1000.5,now=1000.25);self.assertIsNone(row['source_to_observer_ms']);self.assertFalse(row['source_clock_ordered'])
 def test_expected_source_totals_count_every_unique_event_after_eviction(self):
  state=o.State();d=self.event();j=self.event('systemd');state.add(d);state.add(d);state.add(j)
  self.assertEqual(state.source_event_counts,{'docker':1,'systemd':1})
  for i in range(70):state.add({**d,'id':str(i)})
  self.assertEqual(len(state.events),64);self.assertEqual(state.sequence,72);self.assertEqual(state.source_event_counts,{'docker':71,'systemd':1});self.assertEqual(sum(state.source_event_counts.values()),state.sequence)
 def test_unavailable_stream_does_not_invent_source_events(self):
  state=o.State();state.health('docker','unknown','stream_unavailable_or_invalid');state.add(None);self.assertEqual(state.source_event_counts,{'docker':0,'systemd':0})
 def test_short_transient_fault_is_retained_after_recovery(self):
  state=o.State();state.health('docker','connected');state.health('docker','unknown','stream_unavailable_or_invalid');state.health('docker','connected');self.assertEqual(state.source_fault_counts['docker'],1);self.assertEqual(state.sources['docker']['state'],'connected')
 def test_clock_change_stays_uncertain_for_source_replay_window(self):
  state=o.State();self.assertTrue(state.clock(1000,10)[2]);self.assertFalse(state.clock(990,11)[2]);self.assertEqual(state.clock_change_count,1);self.assertFalse(state.clock(1049,70)[2]);self.assertTrue(state.clock(1050,71)[2]);self.assertEqual(state.clock_change_count,1)
if __name__=='__main__':unittest.main()
