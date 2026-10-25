"""Fixed root journal audit; only aggregate allowlisted telemetry escapes."""
import collections
import json
import os
import subprocess
import time

PHASES=frozenset(('bootstrap','state_validation','cycle_validation','sample_processes',
    'write_history','write_hour','write_last','publish_snapshot','publish_health',
    'prune_history','prune_hours','preserve_interrupted'))
REASONS=frozenset(('not_regular','oversize','stat_format','negative','identity_format',
    'boot_format','output_limit','interrupted_scan_limit','unsafe_interrupted_sample',
    'interrupted_archive_full','unsafe_interrupted_archive','interrupted_sample_changed',
    'interrupted_archive_conflict','unexpected_file_count','unexpected_history_entry',
    'unsafe_history','reservation_exceeds_budget','clock_rollback','storage_budget',
    'unsafe_state','disk_pressure','duplicate_sample_no_retry','collection_interrupted','unclassified'))


def summarize(rows,window_seconds):
    accepted=[];invalid=0
    for row in rows:
        if not isinstance(row,dict) or row.get('source')!='procmon_runtime_v1':
            continue
        if (row.get('status') not in ('completed','failed') or
            any(type(row.get(k)) is not int or not 0<=row[k]<=10**18 for k in
                ('observed_at','monotonic_ms','wall_ms','cpu_us','peak_rss_bytes')) or
            (row['status']=='failed' and (row.get('phase') not in PHASES or row.get('reason') not in REASONS))):
            invalid+=1;continue
        accepted.append(row)
    gaps=[b['monotonic_ms']-a['monotonic_ms'] for a,b in zip(accepted,accepted[1:])]
    span=(accepted[-1]['monotonic_ms']-accepted[0]['monotonic_ms'])/1000 if len(accepted)>1 else 0
    failures=[r for r in accepted if r['status']=='failed']
    return {'source':'fixed_procmon_runtime_journal_audit','rows':len(accepted),
            'invalid_telemetry_rows':invalid,'failed_rows':len(failures),
            'failure_phases':dict(collections.Counter(r['phase'] for r in failures)),
            'failure_reasons':dict(collections.Counter(r['reason'] for r in failures)),
            'observed_span_seconds':round(span,3),'requested_window_seconds':window_seconds,
            'max_completion_gap_ms':max(gaps) if gaps else None,
            'nonmonotonic_pairs':sum(g<=0 for g in gaps),
            'max_wall_ms':max((r['wall_ms'] for r in accepted),default=None),
            'sum_cpu_us':sum(r['cpu_us'] for r in accepted),
            'max_peak_rss_bytes':max((r['peak_rss_bytes'] for r in accepted),default=None),
            'latest_observed_at':accepted[-1]['observed_at'] if accepted else None,
            'coverage':['emitted_invocation_completion_only','not_process_sample_cadence',
                        'missing_or_killed_invocations_may_emit_no_telemetry',
                        'no_latency_or_PC_off_acceptance','no_full_goal_acceptance']}


def audit(seconds=86400):
    now=int(time.time())
    run=subprocess.run(['/usr/bin/journalctl','--quiet','--no-pager',
        '--unit=raspberry-procmon.service','--since=@'+str(now-seconds),'--until=@'+str(now),
        '--output=json','--output-fields=__REALTIME_TIMESTAMP,__MONOTONIC_TIMESTAMP,MESSAGE',
        '--lines=8192'],capture_output=True,timeout=8)
    if len(run.stdout)>16*1048576 or len(run.stderr)>65536:
        raise ValueError('audit_output_limit')
    rows=[];lines=run.stdout.splitlines()
    for line in lines:
        envelope=json.loads(line)
        message=envelope.get('MESSAGE')
        if not isinstance(message,str) or len(message)>768:
            continue
        try:row=json.loads(message)
        except ValueError:continue
        rows.append(row)
    result=summarize(rows,seconds)
    result.update({'journal_exit':run.returncode,'journal_limit_reached':len(lines)>=8192,
                   'stderr_present':bool(run.stderr),'production_changes':False,
                   'collector_invoked':False,'raw_messages_exported':False})
    return result


if __name__=='__main__':
    try:
        if os.geteuid()!=0:raise ValueError('local_root_required')
        print(json.dumps(audit(),sort_keys=True))
    except Exception as exc:
        print(json.dumps({'diagnostic':'runtime_audit_incomplete','exception_kind':type(exc).__name__,
                          'production_changes':False,'automatic_retry':False}))
        raise SystemExit(1)
