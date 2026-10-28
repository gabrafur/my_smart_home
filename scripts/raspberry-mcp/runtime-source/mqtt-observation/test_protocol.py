import copy
import json
import unittest
from protocol import KINDS,MAX_EVENTS,accept


def frame(seq=1,total=0,rows=None,**extra):
    counts={k:'0'for k in KINDS};counts['publish_in']=str(total)
    d=dict(v=1,instance='a'*32,started_ns='100',frame_seq=str(seq),
           event_seq=str(total),totals=counts,source_dropped={k:'0'for k in KINDS},
           clock_faults='0',send_failures='0',emitted_ns=str(200+seq),events=rows or [])
    d.update(extra)
    return d


def event(seq=1,at='150',kind='publish_in'):
    return dict(seq=str(seq),kind=kind,at_ns=at)


def project(d,prior=None,now=300,binding=True):
    return accept(prior,json.dumps(d,separators=(',',':')).encode(),now,source_binding_verified=binding)


class ProtocolTests(unittest.TestCase):
    def test_clock_and_send_failure_history_survives_multiple_source_generations(self):
        state=project(frame(clock_faults='2',send_failures='7'))['state']
        second=frame(clock_faults='3',send_failures='11');second['instance']='b'*32
        state=project(second,state,now=400)['state']
        third=frame(clock_faults='1',send_failures='13');third['instance']='c'*32
        state=project(third,state,now=500)['state']
        self.assertEqual(state['past_clock_faults'],5);self.assertEqual(state['past_send_failures'],18)
        self.assertEqual(state['clock_faults']+state['past_clock_faults'],6)
        self.assertEqual(state['send_failures']+state['past_send_failures'],31)
        self.assertEqual(state['previous_epoch_summary']['clock_faults'],3)
        self.assertEqual(state['previous_epoch_summary']['send_failures'],11)

    def test_old_unarmed_state_is_rejected_without_silent_counter_upgrade(self):
        state=project(frame())['state'];state['version']=1
        del state['past_clock_faults'];del state['past_send_failures']
        result=project(frame(2),state,now=400)
        self.assertEqual(result['status'],'unknown');self.assertEqual(result['reason'],'accounting_state_invalid')

    def test_first_epoch_cannot_contain_unattributed_past_faults(self):
        state=project(frame())['state'];state['past_clock_faults']=1
        self.assertEqual(project(frame(2),state,now=400)['status'],'unknown')

    def test_baseline_and_live_event_have_exact_native_latency(self):
        a=project(frame())['state'];b=project(frame(2,1,[event()]),a)
        self.assertEqual(b['status'],'accepted')
        r=b['state']['stats']['publish_in'];self.assertEqual(r['expected'],1)
        self.assertEqual(r['observed'],1);self.assertEqual(r['missing'],0)
        self.assertEqual(r['max_source_to_reader_ns'],150)

    def test_kernel_frame_loss_is_counted_by_class(self):
        a=project(frame())['state'];d=frame(3,3,[event(3)])
        b=project(d,a);self.assertEqual(b['status'],'accepted')
        r=b['state']['stats']['publish_in'];self.assertEqual(r['missing'],2)
        self.assertEqual(r['transport_missing'],2);self.assertEqual(b['state']['report_gaps'],1)

    def test_source_ring_overflow_is_not_mislabeled_transport_loss(self):
        d=frame(1,2,[event()]);d['source_dropped']['publish_in']='1'
        r=project(d)['state']['stats']['publish_in']
        self.assertEqual(r['missing'],1);self.assertEqual(r['source_dropped'],1)
        self.assertEqual(r['transport_missing'],0)

    def test_failed_nonblocking_send_can_retain_all_events(self):
        d=frame(1,2,[event(1),event(2)]);d['send_failures']='7'
        r=project(d);self.assertEqual(r['status'],'accepted')
        self.assertEqual(r['state']['stats']['publish_in']['missing'],0)
        self.assertEqual(r['state']['send_failures'],7)

    def test_consecutive_frame_cannot_hide_unexplained_event_loss(self):
        r=project(frame(1,2,[event()]))
        self.assertEqual(r['reason'],'unexplained_consecutive_frame_loss')

    def test_same_frame_is_idempotent(self):
        d=frame();a=project(d)['state'];r=project(d,a,now=400)
        self.assertEqual(r['status'],'duplicate');self.assertEqual(r['state'],a)

    def test_same_sequence_different_frame_is_conflict(self):
        a=project(frame())['state'];d=frame();d['send_failures']='1'
        self.assertEqual(project(d,a)['reason'],'frame_reuse_conflict')

    def test_new_generation_preserves_history_and_unknown_tail(self):
        d=frame(1,1,[event()]);a=project(d)['state']
        d2=frame();d2['instance']='b'*32;b=project(d2,a)['state']
        d3=frame();d3['instance']='c'*32;c=project(d3,b)['state']
        self.assertEqual(c['epoch'],3);self.assertEqual(c['unknown_epoch_tails'],2)
        self.assertEqual(c['past_stats']['publish_in']['observed'],1)
        self.assertTrue(c['previous_epoch_tail_unknown'])

    def test_unverified_peer_is_unknown_without_mutating_prior(self):
        a=project(frame())['state'];r=project(frame(2),a,binding=False)
        self.assertEqual(r['reason'],'source_binding_unverified');self.assertEqual(r['state'],a)

    def test_private_extra_fields_are_rejected_and_not_exported(self):
        d=frame();d['payload']='SYNTHETIC_PRIVATE_CANARY'
        r=project(d);self.assertEqual(r['status'],'unknown')
        self.assertNotIn('CANARY',json.dumps(r))
        d=frame(1,1,[dict(event(),topic='SYNTHETIC_PRIVATE_CANARY')])
        self.assertEqual(project(d)['status'],'unknown')

    def test_large_and_recursive_frames_fail_closed(self):
        for raw in [b'x'*40000,b'['*2000+b']'*2000,b'{"v":'+b'9'*5000+b'}']:
            r=accept(None,raw,300,source_binding_verified=True)
            self.assertEqual(r['status'],'unknown')

    def test_duplicate_keys_are_not_silently_overwritten(self):
        raw=json.dumps(frame()).encode().replace(b'"v": 1',b'"v": 2,"v": 1')
        self.assertEqual(accept(None,raw,300,source_binding_verified=True)['status'],'unknown')

    def test_future_clock_is_unknown_not_zero_latency(self):
        for d in [frame(emitted_ns='999'),frame(started_ns='999'),frame(1,1,[event(at='999')])]:
            r=project(d);self.assertEqual(r['status'],'unknown')
            self.assertIsNone(r['state'])

    def test_unknown_callback_clock_is_counted(self):
        d=frame(1,1,[event(at=None)]);d['clock_faults']='1'
        r=project(d)['state']['stats']['publish_in']
        self.assertEqual(r['observed'],1);self.assertEqual(r['timed'],0)
        self.assertEqual(r['timing_unknown'],1);self.assertIsNone(r['max_source_to_reader_ns'])

    def test_null_emit_or_start_requires_actual_fault_counter(self):
        for key in ['emitted_ns','started_ns']:
            d=frame();d[key]=None;self.assertEqual(project(d)['status'],'unknown')
            d['clock_faults']='1';self.assertEqual(project(d)['status'],'accepted')

    def test_clock_fault_cannot_disappear(self):
        a=project(frame(clock_faults='1'))['state']
        self.assertEqual(project(frame(2,clock_faults='0'),a)['status'],'unknown')

    def test_clock_and_counter_reversals_fail_closed(self):
        a=project(frame(2))['state']
        for d,now in [(frame(1),300),(frame(3,emitted_ns='150'),300),(frame(3),299)]:
            self.assertEqual(project(d,a,now=now)['status'],'unknown')

    def test_event_replay_is_not_counted_twice(self):
        a=project(frame(1,1,[event()]))['state']
        self.assertEqual(project(frame(2,2,[event(1),event(2)]),a)['reason'],'event_replayed')

    def test_wrong_class_counters_cannot_cover_event(self):
        d=frame(1,1,[event(kind='publish_out')])
        self.assertEqual(project(d)['status'],'unknown')

    def test_all_safe_native_event_classes_are_accounted(self):
        for kind in KINDS:
            d=frame(1,1,[event(kind=kind)]);d['totals']['publish_in']='0';d['totals'][kind]='1'
            r=project(d);self.assertEqual(r['status'],'accepted')
            self.assertEqual(r['state']['stats'][kind]['observed'],1)

    def test_missing_heartbeat_frame_is_gap_without_fake_missing_events(self):
        a=project(frame())['state'];r=project(frame(3),a)['state']
        self.assertEqual(r['report_gaps'],1)
        self.assertEqual(r['stats']['publish_in']['missing'],0)

    def test_timestamp_and_counter_strings_preserve_large_integer_precision(self):
        n=2**54+1;d=frame(started_ns=str(n),emitted_ns=str(n+10))
        r=project(d,now=n+20);self.assertEqual(r['status'],'accepted')
        self.assertEqual(r['state']['last_emitted_ns'],n+10)

    def test_frame_and_event_bounds_are_enforced(self):
        d=frame(1,MAX_EVENTS+1,[event(i+1)for i in range(MAX_EVENTS+1)])
        self.assertEqual(project(d)['status'],'unknown')

    def test_previous_state_is_not_mutated_and_cannot_claim_completion(self):
        a=project(frame())['state'];old=copy.deepcopy(a);r=project(frame(2),a)
        self.assertEqual(a,old);self.assertFalse(r['full_goal_proven'])
        self.assertFalse(r['state']['full24h_proven'])

    def test_corrupt_persistence_stays_explicitly_unknown(self):
        r=project(frame(),{'instance':'a'*32})
        self.assertEqual(r['reason'],'accounting_state_invalid')

    def test_corrupt_private_persistence_is_not_echoed(self):
        a=project(frame())['state'];a['private']='SYNTHETIC_PRIVATE_CANARY'
        r=project(frame(2),a)
        self.assertEqual(r['reason'],'accounting_state_invalid')
        self.assertNotIn('CANARY',json.dumps(r));self.assertIsNone(r['state'])


if __name__=='__main__':
    unittest.main()
