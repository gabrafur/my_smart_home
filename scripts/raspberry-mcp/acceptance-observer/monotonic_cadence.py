"""Offline physical cadence assessment of bounded, previously collected facts.

The legacy UTC acceptance remains separate. No collector, lock, service, file
mutation or source authentication is performed by this pure assessment.
"""
import datetime,math,re
from cadence_window import COUNTERS,CANDIDATE_START
PERIOD=86400
GAP=60
MAX_ROWS=2000
class FactsInvalid(ValueError):pass
def need(ok):
    if not ok:raise FactsInvalid('cadence_facts_invalid')
def number(v):return type(v)in(int,float)and math.isfinite(v)
def closed(v,keys):need(type(v)is dict and set(v)==set(keys))
def assess(facts):
    closed(facts,['schema_version','source','observed_at_UTC','source_auditor_sha256','current_boot',
      'read_started_monotonic_s','read_finished_monotonic_s','wall_clock_pair','health','rows',
      'collector_invoked','locks_acquired','producer_state_changed','raw_process_records_exported','full_goal_accepted'])
    need(type(facts['schema_version'])is int and facts['schema_version']==1)
    need(facts['source']=='fixed_readonly_preserved_cadence_facts')
    need(type(facts['source_auditor_sha256'])is str and re.fullmatch('[a-f0-9]{64}',facts['source_auditor_sha256'])is not None)
    boot=facts['current_boot'];need(type(boot)is str and re.fullmatch('[a-f0-9]{16}',boot)is not None)
    for key in ['collector_invoked','locks_acquired','producer_state_changed','raw_process_records_exported','full_goal_accepted']:
        need(facts[key]is False)
    pair=facts['wall_clock_pair'];closed(pair,['wall_s','before_monotonic_s','after_monotonic_s'])
    clocks=[facts['read_started_monotonic_s'],pair['before_monotonic_s'],pair['after_monotonic_s'],facts['read_finished_monotonic_s']]
    need(all(number(v)and v>=0 for v in clocks)and clocks==sorted(clocks))
    need(pair['after_monotonic_s']==facts['read_finished_monotonic_s'])
    wall=pair['wall_s'];need(number(wall)and CANDIDATE_START<=wall<=253402300799)
    try:
        observed=datetime.datetime.fromisoformat(facts['observed_at_UTC'].replace('Z','+00:00'))
        need(observed.utcoffset()==datetime.timedelta(0)and abs(observed.timestamp()-wall)<=1e-6)
    except (AttributeError,ValueError,TypeError,OverflowError):
        raise FactsInvalid('cadence_facts_invalid')from None
    rows=facts['rows'];need(type(rows)is list and len(rows)<=MAX_ROWS)
    for row in rows:
        closed(row,['at','mono','boot','error','coverage'])
        need(number(row['at'])and row['at']>=CANDIDATE_START and number(row['mono'])and row['mono']>=0)
        need(type(row['boot'])is str and re.fullmatch('[a-f0-9]{16}',row['boot'])is not None and type(row['error'])is bool)
        closed(row['coverage'],COUNTERS)
        need(all(type(v)is int and 0<=v<2**64 for v in row['coverage'].values()))
    health=facts['health'];closed(health,['status','observed_at'])
    need(type(health['status'])is str and health['status']in('completed','failed','unknown'))
    need(number(health['observed_at']))
    end=facts['read_finished_monotonic_s'];start=end-PERIOD;issues=set()
    if start<0:issues.add('insufficient_monotonic_uptime')
    if any(row['boot']!=boot for row in rows):issues.add('clock_domain_mismatch')
    ordered=sorted(rows,key=lambda r:r['mono'])
    # Validate before retaining only the latest predecessor: otherwise duplicate
    # anchors just outside the window disappear and falsely establish its start.
    if any(a['mono']==b['mono']for a,b in zip(ordered,ordered[1:])):
        issues.add('duplicate_monotonic_sample')
    if any(row['mono']>end for row in ordered):issues.add('future_sample')
    previous=[row for row in ordered if row['mono']<start]
    selected=previous[-1:]+[row for row in ordered if start<=row['mono']<=end]
    if not selected:issues.add('no_samples')
    elif selected[0]['mono']>start:issues.add('start_boundary_uncovered')
    gaps=[];steps=[]
    if selected:gaps.extend([max(0,selected[0]['mono']-start),end-selected[-1]['mono']])
    for index,(a,b)in enumerate(zip(selected,selected[1:])):
        mono=b['mono']-a['mono'];gaps.append(mono)
        if mono<=0:issues.add('duplicate_monotonic_sample')
        offset=(b['at']-a['at'])-mono
        if abs(offset)>2:
            steps.append({'pair_index':index,'from_wall_s':a['at'],'to_wall_s':b['at'],
                          'wall_minus_monotonic_seconds':offset})
    if gaps and max(gaps)>GAP:issues.add('sampling_gap_over_60s')
    if any(row['error']for row in selected):issues.add('sample_collection_error')
    if health['status']!='completed':issues.add('current_collector_not_completed')
    # The clock pair brackets the wall read. Its width contributes to the
    # conservative age bound; it is not silently treated as instantaneous.
    width=pair['after_monotonic_s']-pair['before_monotonic_s']
    age=wall-health['observed_at']
    if not 0<=age or age+width>GAP:issues.add('current_health_not_fresh')
    if selected:
        current_offset=(wall-selected[-1]['at'])-(pair['before_monotonic_s']-selected[-1]['mono'])
        if not -2<=current_offset<=2:issues.add('current_wall_clock_correlation_unknown')
    maximum=max(gaps)if gaps else None
    window_rows=[row for row in selected if row['mono']>=start]
    counts={key:sum(row['coverage'][key]for row in window_rows)for key in COUNTERS}
    partial=sum(any(row['coverage'][key]for key in COUNTERS[2:])for row in window_rows)
    return {'schema_version':1,'source':'offline_monotonic_cadence_assessment',
      'observed_at_UTC':datetime.datetime.fromtimestamp(wall,datetime.timezone.utc).isoformat(),
      'window_monotonic_start':start,'window_monotonic_end':end,'window_seconds':PERIOD,
      'gap_limit_seconds':GAP,'sample_count':sum(row['mono']>=start for row in selected),
      'partial_samples':partial,'summed_coverage_counts':counts,
      'preceding_anchor_present':bool(previous),'max_monotonic_gap_seconds':maximum,
      'current_health_age_upper_seconds':age+width,'wall_clock_discontinuities':steps,
      'historical_UTC_clock_consistent':not steps,'monotonic_cadence_24h_proven':not issues,
      'issues':sorted(issues),'legacy_UTC_acceptance_overridden':False,
      'all_event_latency_proven':False,'PC_off_proven':False,'full_goal_accepted':False,
      'collector_invoked':False,'locks_acquired':False,'state_changed':False,
      'coverage':['provided_sample_clock_facts_only','single_boot_physical_intervals_and_boundary_anchors',
                  'current_health_clock_pair','not_source_authentication_or_historical_UTC_continuity',
                  'not_all_processes_event_latency_provider_recovery_or_PC_off']}
