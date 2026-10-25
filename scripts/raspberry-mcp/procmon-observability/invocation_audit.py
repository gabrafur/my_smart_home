"""Fixed read-only invocation correlation. No collector call, state write or free query."""
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import time

START = '7d4958e842da4a758f6c1cdc7b36dcc5'
SUCCESS = '39f53479d3a045ac8e11786248231fbf'
FAILURE = 'be02cf6855d2428ba40df7e9d022f03d'


def token(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value) is not None


def integer(value):
    return type(value) is int and 0 <= value <= 10**18


def clocks(row):
    for name in ('__REALTIME_TIMESTAMP', '__MONOTONIC_TIMESTAMP'):
        if not isinstance(row.get(name), str) or re.fullmatch('[0-9]{1,18}', row[name]) is None:
            raise ValueError('journal_clock_missing')
    return int(row['__REALTIME_TIMESTAMP']) / 1000000, int(row['__MONOTONIC_TIMESTAMP'])


def correlate(manager, native, accounting, now):
    starts, ends, runtimes, costs = {}, collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    invalid_manager = invalid_runtime = invalid_accounting = duplicate_starts = 0
    for row in manager:
        if not isinstance(row, dict) or row.get('MESSAGE_ID') not in (START, SUCCESS, FAILURE):
            continue
        try:
            at, mono = clocks(row)
            if not token(row.get('_BOOT_ID')) or not token(row.get('INVOCATION_ID')) or at > now+1:
                raise ValueError('identity_or_time')
            key = (row['_BOOT_ID'], row['INVOCATION_ID'])
            if row['MESSAGE_ID'] == START:
                if key in starts:
                    duplicate_starts += 1
                starts[key] = {'at': at, 'mono': mono}
            else:
                ends[key].append({'at': at, 'mono': mono, 'state': 'completed' if row['MESSAGE_ID'] == SUCCESS else 'failed'})
        except (ValueError, TypeError, KeyError):
            invalid_manager += 1
    for row in native:
        try:
            at, mono = clocks(row)
            value = json.loads(row['MESSAGE'])
            if (not token(row.get('_BOOT_ID')) or not token(row.get('_SYSTEMD_INVOCATION_ID'))
                    or not isinstance(value, dict) or value.get('source') != 'procmon_runtime_v1'
                    or value.get('status') not in ('completed', 'failed') or at > now+1
                    or not all(integer(value.get(k)) for k in ('observed_at','monotonic_ms','wall_ms','cpu_us','peak_rss_bytes'))):
                raise ValueError('native_invalid')
            runtimes[(row['_BOOT_ID'], row['_SYSTEMD_INVOCATION_ID'])].append(value)
        except (ValueError, TypeError, KeyError):
            invalid_runtime += 1
    for row in accounting:
        try:
            at, _ = clocks(row)
            value = json.loads(row['MESSAGE'])
            identity = value.get('collector_invocation_id_sha256')
            if (not token(row.get('_BOOT_ID')) or not isinstance(identity, str)
                    or re.fullmatch('[a-f0-9]{64}', identity) is None
                    or value.get('source') != 'procmon_unit_accounting_v1' or at > now+1):
                raise ValueError('accounting_invalid')
            if value.get('state') != 'observed' or value.get('collection_error') is not None:
                continue
            if not all(integer(value.get(k)) for k in ('cpu_usage_ns','started_monotonic_us','exited_monotonic_us')):
                raise ValueError('accounting_invalid')
            costs[(row['_BOOT_ID'], identity)].append(value)
        except (ValueError, TypeError, KeyError, AttributeError):
            invalid_accounting += 1
    selected = {key: value for key, value in starts.items() if now-86400 <= value['at'] <= now}
    missing = duplicate_runtime = missing_terminal = temporal_or_state_conflicts = in_flight = 0
    process_full = process_legacy = cgroup_count = rss_count = failed = 0
    sum_total = sum_legacy = sum_cgroup = 0
    max_rss = None
    signals = collections.Counter()
    for key, start in selected.items():
        runtime, terminal = runtimes[key], ends[key]
        if not terminal:
            missing_terminal += 1
            if now-start['at'] <= 7:
                in_flight += 1
        digest = hashlib.sha256(key[1].encode()).hexdigest()
        candidates = costs.get((key[0], digest), [])
        if len(candidates) == 1 and len(terminal) == 1:
            account = candidates[0]
            if (start['mono']-1000000 <= account['started_monotonic_us'] <= account['exited_monotonic_us']
                    <= terminal[0]['mono']+1000000):
                cgroup_count += 1;sum_cgroup += account['cpu_usage_ns']
        if not runtime:
            missing += 1
        elif len(runtime) > 1:
            duplicate_runtime += 1
        if len(runtime) != 1 or len(terminal) != 1:
            continue
        value, end = runtime[0], terminal[0]
        if (end['state'] != value['status'] or end['mono'] < start['mono']
                or value['monotonic_ms']*1000 < start['mono']-1000000
                or value['monotonic_ms']*1000 > end['mono']+1000000):
            temporal_or_state_conflicts += 1
            continue
        failed += value['status'] == 'failed'
        rss_count += 1
        max_rss = max(max_rss or 0, value['peak_rss_bytes'])
        total = value.get('process_total_cpu_us')
        if integer(total) and total >= value['cpu_us']:
            process_full += 1;sum_total += total
        else:
            process_legacy += 1;sum_legacy += value['cpu_us']
        for signal in value.get('signals_observed', [])[:2] if isinstance(value.get('signals_observed'), list) else []:
            if isinstance(signal, dict) and signal.get('signal') in ('SIGALRM', 'SIGTERM'):
                signals[signal['signal']] += 1
    times = sorted(value['at'] for value in selected.values())
    boots = {key[0] for key in selected}
    gaps = [b-a for a,b in zip(times,times[1:])]
    covered = bool(times) and times[0] <= now-86400+60 and times[-1] >= now-60 and (not gaps or max(gaps) <= 60) and len(boots) == 1
    duplicate_terminals = sum(len(ends[k])>1 for k in selected)
    orphan_native = sum(1 for key, rows in runtimes.items() if key not in starts and any(row['observed_at']>=now-86400 for row in rows))
    orphan_terminal = sum(1 for key, rows in ends.items() if key not in starts and any(row['at']>=now-86400 for row in rows))
    manager_complete = covered and not any((invalid_manager, duplicate_starts, missing_terminal, duplicate_terminals, orphan_native, orphan_terminal))
    paired = manager_complete and not any((invalid_runtime, missing, duplicate_runtime, temporal_or_state_conflicts))
    return {'source':'fixed_manager_native_and_unit_CPU_correlation', 'observed_at':int(now),
        'window_start':int(now-86400), 'window_end':int(now), 'window_seconds':86400,
        'started_invocations':len(selected), 'failed_correlated_invocations':failed,
        'missing_runtime_invocations':missing, 'duplicate_runtime_invocations':duplicate_runtime,
        'missing_or_duplicate_terminal_invocations':missing_terminal+duplicate_terminals,
        'orphan_native_invocations':orphan_native,'orphan_terminal_invocations':orphan_terminal,
        'in_flight_invocations':in_flight, 'temporal_or_state_conflicts':temporal_or_state_conflicts,
        'invalid_manager_rows':invalid_manager, 'invalid_runtime_rows':invalid_runtime,
        'invalid_accounting_rows':invalid_accounting, 'duplicate_start_rows':duplicate_starts,
        'native_process_total_CPU_rows':process_full, 'legacy_observer_CPU_rows':process_legacy,
        'sum_process_CPU_us_to_telemetry':sum_total if process_full else None,
        'sum_legacy_observer_CPU_us':sum_legacy if process_legacy else None,
        'native_unit_cgroup_CPU_rows':cgroup_count, 'sum_native_unit_CPU_ns':sum_cgroup if cgroup_count else None,
        'observed_peak_rss_rows':rss_count,'invocations_without_observed_peak_rss':len(selected)-rss_count, 'max_observed_peak_rss_bytes':max_rss,
        'observed_signals':dict(signals), 'one_boot':len(boots)==1,
        'manager_start_window_coverage_proven':covered,
        'all_starts_have_correlated_runtime_in_window':paired,
        'all_started_invocation_unit_CPU_observed':manager_complete and not invalid_accounting and cgroup_count==len(selected),
        'full_goal_accepted':False, 'PC_off_proven':False,
        'coverage':['native_invocation_identity_and_clock_correlation',
            'CPU_scope_explicit_legacy_vs_process_to_telemetry_vs_complete_unit',
            'missing_killed_or_inflight_invocations_are_not_zero_cost',
            'signal_receipt_does_not_identify_sender_or_historical_RCA',
            'not_durable_sample_cadence_or_event_latency_or_24h_goal_acceptance']}


def journal_limits():
    resource.setrlimit(resource.RLIMIT_AS, (512*1048576,512*1048576))


def read_fixed(args):
    result = subprocess.run(['/usr/bin/journalctl','--quiet','--no-pager',*args],
        capture_output=True,timeout=12,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},preexec_fn=journal_limits)
    # journalctl --grep returns 1 with empty output when no entry matches.
    # Only that exact bounded case is empty evidence, never a failed collection.
    no_matches = result.returncode == 1 and not result.stdout and not result.stderr and any(arg.startswith('--grep=') for arg in args)
    if (result.returncode and not no_matches) or len(result.stdout)>4194304 or len(result.stderr)>65536:
        raise ValueError('journal_collection_unconfirmed')
    return [json.loads(line) for line in result.stdout.splitlines()], bool(result.stderr)


def audit(now=None):
    now = time.time() if now is None else now
    window = ['--since=@'+str(int(now)-90000),'--until=@'+str(int(now)),'--output=json']
    manager, a = read_fixed(['_PID=1','UNIT=raspberry-procmon.service',*window,
        '--output-fields=__REALTIME_TIMESTAMP,__MONOTONIC_TIMESTAMP,_BOOT_ID,MESSAGE_ID,INVOCATION_ID','--lines=8192'])
    native, b = read_fixed(['--unit=raspberry-procmon.service',*window,
        '--grep="source":[[:space:]]*"procmon_runtime_v1"',
        '--output-fields=MESSAGE,_BOOT_ID,_SYSTEMD_INVOCATION_ID,__REALTIME_TIMESTAMP,__MONOTONIC_TIMESTAMP','--lines=2048'])
    accounting, c = read_fixed(['--unit=raspberry-host-observation.service',*window,
        '--grep="source":[[:space:]]*"procmon_unit_accounting_v1"',
        '--output-fields=MESSAGE,_BOOT_ID,__REALTIME_TIMESTAMP,__MONOTONIC_TIMESTAMP','--lines=2048'])
    value = correlate(manager,native,accounting,now)
    value['journal_collection_error'] = 'journal_limit_or_diagnostic_present' if len(manager)>=8192 or len(native)>=2048 or len(accounting)>=2048 or a or b or c else None
    if value['journal_collection_error']:
        value['manager_start_window_coverage_proven']=False
        value['all_starts_have_correlated_runtime_in_window']=False
        value['all_started_invocation_unit_CPU_observed']=False
    value.update(collector_invoked=False,state_changed=False,raw_messages_exported=False)
    return value


if __name__=='__main__':
    try:
        if os.geteuid()!=0 or sys.argv[1:] or Path(__file__).absolute()!=Path('/usr/local/lib/raspberry-procmon-observability/invocation_audit.py'):
            raise ValueError('fixed_readonly_entrypoint_required')
        resource.setrlimit(resource.RLIMIT_AS,(128*1048576,512*1048576))
        resource.setrlimit(resource.RLIMIT_CPU,(10,10))
        print(json.dumps(audit(),sort_keys=True))
    except Exception as exc:
        print(json.dumps({'state':'unknown','collection_error':'invocation_audit_incomplete','exception_kind':type(exc).__name__,'raw_error_withheld':True,'automatic_retry':False}))
        raise SystemExit(1)
