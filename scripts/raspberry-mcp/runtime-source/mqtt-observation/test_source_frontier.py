"""A send timestamp is not a proof that earlier callbacks were accounted."""
import copy,unittest
from protocol import Invalid,validate_state
from test_protocol import frame,event,project

def modern(*args,before='200',final=False,**kwargs):return frame(*args,v=3,final=final,covered_before_ns=before,**kwargs)

class Tests(unittest.TestCase):
    def test_explicit_frontier_is_distinct_from_send_time(self):
        result=project(modern(before='190'))
        self.assertEqual(result['status'],'accepted');self.assertEqual(result['state']['version'],4)
        self.assertEqual(result['state']['last_emitted_ns'],201)
        self.assertEqual(result['state']['last_covered_before_ns'],190)
    def test_no_quiescence_does_not_advance_coverage_to_emission_time(self):
        first=project(modern(before='190'))['state']
        pending=project(modern(2,before=None),first)['state']
        self.assertEqual(pending['last_emitted_ns'],202);self.assertEqual(pending['last_covered_before_ns'],190)
        done=project(modern(3,1,[event(at='195')],before='203'),pending)['state']
        self.assertEqual(done['last_covered_before_ns'],203)
        self.assertEqual(done['stats']['publish_in']['observed'],1)
    def test_legacy_closure_cannot_invent_frontier(self):
        a=project(frame(v=2,final=True))['state']
        self.assertNotIn('last_covered_before_ns',a)
        b=project(modern(instance='b'*32,before='200'),a,now=400)['state']
        self.assertEqual(b['unknown_epoch_tails'],0);self.assertEqual(b['last_covered_before_ns'],200)
        c=project(frame(instance='c'*32),b,now=500)['state']
        self.assertEqual(c['version'],4);self.assertIsNone(c['last_covered_before_ns'])
    def test_clock_unknown_frame_preserves_prior_known_frontier_without_resetting_faults(self):
        a=project(modern(before='190'))['state']
        b=project(modern(2,before=None,emitted_ns=None,clock_faults='1'),a)['state']
        self.assertEqual(b['last_covered_before_ns'],190);self.assertEqual(b['clock_faults'],1)
        result=project(modern(3,before='180',clock_faults='1'),b)
        self.assertEqual(result['reason'],'source_coverage_reversed');self.assertEqual(result['state'],b)
    def test_frontier_must_be_bounded_and_never_reversed(self):
        a=project(modern(before='190'))['state']
        for f in [modern(2,before='99'),modern(2,before='203'),modern(2,before='189'),
                  modern(2,before=200),modern(2,before='18446744073709551616')]:
            self.assertEqual(project(f,a)['status'],'unknown')
        bad=copy.deepcopy(a);bad['last_covered_before_ns']=202
        with self.assertRaises(Invalid):validate_state(bad)
    def test_final_frontier_may_precede_emission_and_stays_idempotent(self):
        value=modern(before='180',final=True);a=project(value)['state']
        self.assertTrue(a['source_closed']);self.assertEqual(a['last_covered_before_ns'],180)
        self.assertEqual(project(value,a)['status'],'duplicate')
        self.assertEqual(project(modern(2),a)['reason'],'source_already_closed')
    def test_frontier_never_crosses_an_instance_boundary(self):
        a=project(modern(before='200'))['state']
        b=project(modern(instance='b'*32,before=None),a,now=400)['state']
        self.assertIsNone(b['last_covered_before_ns']);self.assertEqual(b['unknown_epoch_tails'],1)
        self.assertFalse(b['full24h_proven'])

if __name__=='__main__':unittest.main()
