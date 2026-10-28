import copy,datetime,unittest
from monotonic_cadence import assess,FactsInvalid
from cadence_window import CANDIDATE_START

def fixture():
    end=100000;wall=CANDIDATE_START+end
    rows=[{'at':CANDIDATE_START+t,'mono':float(t),'boot':'a'*16,'error':False,
           'coverage':dict.fromkeys(('enumerated','records','inaccessible','vanished','invalid','pid_reused','pid_limit','deadline'),0)}
          for t in range(end-86400-10,end,55)]
    latest=rows[-1]
    return {'schema_version':1,'source':'fixed_readonly_preserved_cadence_facts',
      'observed_at_UTC':datetime.datetime.fromtimestamp(wall,datetime.timezone.utc).isoformat(),
      'source_auditor_sha256':'b'*64,'current_boot':'a'*16,'read_started_monotonic_s':end-1,
      'read_finished_monotonic_s':end,'wall_clock_pair':{'wall_s':wall,'before_monotonic_s':end-.001,'after_monotonic_s':end},
      'health':{'status':'completed','observed_at':latest['at']},'rows':rows,'collector_invoked':False,
      'locks_acquired':False,'producer_state_changed':False,'raw_process_records_exported':False,'full_goal_accepted':False}
class Tests(unittest.TestCase):
    def test_real_duration_and_fixed_interval_contract_are_not_lowered_for_tests(self):
        r=assess(fixture());self.assertTrue(r['monotonic_cadence_24h_proven']);self.assertEqual(r['window_seconds'],86400)
        self.assertEqual(r['gap_limit_seconds'],60);self.assertTrue(r['preceding_anchor_present'])
        self.assertFalse(r['full_goal_accepted']);self.assertFalse(r['all_event_latency_proven'])
    def test_historical_wall_step_is_reported_separately_without_changing_physical_cadence(self):
        f=fixture()
        for row in f['rows'][:800]:row['at']+=43.64
        r=assess(f);self.assertTrue(r['monotonic_cadence_24h_proven']);self.assertFalse(r['historical_UTC_clock_consistent'])
        self.assertAlmostEqual(r['wall_clock_discontinuities'][0]['wall_minus_monotonic_seconds'],-43.64,places=5)
        self.assertFalse(r['legacy_UTC_acceptance_overridden'])
    def test_a_gap_that_rounds_to60_still_fails_the_exact_limit(self):
        f=fixture();index=300;old=f['rows'][index]['mono'];f['rows'][index]['mono']=old+5.0001
        r=assess(f);self.assertFalse(r['monotonic_cadence_24h_proven']);self.assertIn('sampling_gap_over_60s',r['issues'])
    def test_missing_start_anchor_or_old_latest_sample_prevents_acceptance(self):
        for trim in ('start','end'):
            f=fixture();f['rows']=f['rows'][1:]if trim=='start'else f['rows'][:-2]
            self.assertFalse(assess(f)['monotonic_cadence_24h_proven'],trim)
    def test_foreign_boot_future_or_duplicate_clock_is_not_normalized_to_success(self):
        for mutate,reason in [
         (lambda f:f['rows'][0].update(boot='c'*16),'clock_domain_mismatch'),
         (lambda f:f['rows'][-1].update(mono=100001),'future_sample'),
         (lambda f:f['rows'].insert(1,copy.deepcopy(f['rows'][0])),'duplicate_monotonic_sample')]:
            f=fixture();mutate(f);self.assertIn(reason,assess(f)['issues'])
    def test_current_health_uses_the_full_clock_bracket_and_current_correlation(self):
        f=fixture();f['health']['observed_at']=f['wall_clock_pair']['wall_s']-60
        self.assertIn('current_health_not_fresh',assess(f)['issues'])
        f=fixture();f['wall_clock_pair']['wall_s']+=40;f['health']['observed_at']+=40
        f['observed_at_UTC']=datetime.datetime.fromtimestamp(f['wall_clock_pair']['wall_s'],datetime.timezone.utc).isoformat()
        self.assertIn('current_wall_clock_correlation_unknown',assess(f)['issues'])
        f=fixture();f['health']['observed_at']=f['wall_clock_pair']['wall_s']+1
        self.assertIn('current_health_not_fresh',assess(f)['issues'])
    def test_reordering_by_monotonic_clock_does_not_drop_samples(self):
        f=fixture();f['rows'].reverse();r=assess(f)
        self.assertTrue(r['monotonic_cadence_24h_proven']);self.assertEqual(r['sample_count'],len(f['rows'])-1)
    def test_invalid_or_private_fields_fail_closed_without_echoing_values(self):
        for mutate in [lambda f:f.update(password='PRIVATE_CANARY'),lambda f:f['rows'][0].update(mono=float('nan')),
         lambda f:f.update(collector_invoked=True),lambda f:f['rows'][0]['coverage'].update(records=True),
         lambda f:f['wall_clock_pair'].update(before_monotonic_s=100001),lambda f:f['health'].update(extra='PRIVATE_CANARY')]:
            f=fixture();mutate(f)
            with self.assertRaisesRegex(FactsInvalid,'^cadence_facts_invalid$'):assess(f)
    def test_duplicate_preceding_anchor_cannot_disappear_during_boundary_selection(self):
        f=fixture();f['rows'].insert(0,copy.deepcopy(f['rows'][0]));f['rows'].reverse()
        r=assess(f);self.assertFalse(r['monotonic_cadence_24h_proven'])
        self.assertIn('duplicate_monotonic_sample',r['issues'])
    def test_civil_capture_and_paired_clock_must_describe_the_same_observation(self):
        for value in ['unused','2026-10-28T10:00:00','999999999999-01-01T00:00:00Z',None]:
            f=fixture();f['observed_at_UTC']=value
            with self.assertRaisesRegex(FactsInvalid,'^cadence_facts_invalid$'):assess(f)
    def test_collection_coverage_remains_visible_and_is_not_inferred_from_cadence(self):
        f=fixture();f['rows'][300]['coverage'].update(enumerated=5,records=4,inaccessible=1)
        r=assess(f);self.assertTrue(r['monotonic_cadence_24h_proven']);self.assertEqual(r['partial_samples'],1)
        self.assertEqual(r['summed_coverage_counts']['inaccessible'],1)
        self.assertFalse(r['all_event_latency_proven']);self.assertFalse(r['PC_off_proven'])
    def test_monotonic_pass_does_not_turn_the_legacy_wall_clock_auditor_green(self):
        from cadence_window import assess as legacy
        f=fixture()
        for row in f['rows'][:800]:row['at']+=43.64
        self.assertTrue(assess(f)['monotonic_cadence_24h_proven'])
        old=legacy(f['rows'],f['wall_clock_pair']['wall_s'],f['health'])
        self.assertFalse(old['cadence_24h_proven']);self.assertIn('clock_discontinuity',old['issues'])
if __name__=='__main__':unittest.main()
