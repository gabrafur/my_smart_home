"""Read-only producer overlay. Never infer remote backup or restore from Git."""
import copy
import datetime as dt
import re


def stamp(value):
    if not isinstance(value, str) or not re.fullmatch(
            r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)', value):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def read_metadata(path, owner):
    """Only called with fixed paths; never export source content or errors."""
    import json
    import os
    import stat
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner
                    or info.st_mode & 0o022 or info.st_size > 16384):
                raise ValueError('unsafe_metadata')
            raw = os.read(fd, 16385)
            if len(raw) > 16384:
                raise ValueError('oversized_metadata')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('invalid_metadata')
            return value, None
        finally:
            os.close(fd)
    except FileNotFoundError:
        return None, 'source_missing'
    except (OSError, ValueError, UnicodeError):
        return None, 'source_invalid_or_unavailable'


def safe_cycle(value):
    import hashlib
    if not isinstance(value, dict):
        return None
    request = value.get('request_id')
    request = request if isinstance(request, str) and re.fullmatch(r'\d{8}T\d{6}Z-\d{1,12}', request) else None
    status = value.get('status')
    reason = value.get('reason')
    return {
        'status': status if status in ('success', 'failed', 'deferred', 'invalid') else 'unknown',
        'reason': reason if isinstance(reason, str) and re.fullmatch(r'[a-z0-9_]{1,80}', reason) else 'unknown',
        'finished_at': value.get('finished_at') if stamp(value.get('finished_at')) is not None else None,
        'operation_id': hashlib.sha256(request.encode()).hexdigest()[:32] if request else None,
        'origin': value.get('origin') if value.get('origin') in ('scheduled', 'manual') else 'unknown',
    }


def apply_cycle_projection(git, projection, collection_error, historical, now, worker_error):
    """Canonical topic is provenance, not cryptographic scheduler attestation."""
    failures = []
    if isinstance(historical, dict):
        item = safe_cycle(historical.get('worker_cycle'))
        if item and item['status'] == 'failed':
            # Baseline is collected from an already sanitized worker response.
            op = historical['worker_cycle'].get('operation_id')
            item['operation_id'] = op if isinstance(op, str) and re.fullmatch(r'[a-f0-9]{32}', op) else None
            item['source'] = 'sealed_pre_change_worker_observation'
            failures.append(item)
    valid = isinstance(projection, dict) and projection.get('schema_version') == 1 and projection.get('source') == 'canonical_nodered_git_backup_result'
    if valid and isinstance(projection.get('failure_history'), list):
        for row in projection['failure_history'][-16:]:
            item = safe_cycle(row)
            if item and item['status'] == 'failed' and not any(old.get('operation_id') == item['operation_id'] and old.get('finished_at') == item['finished_at'] and old.get('reason') == item['reason'] for old in failures):
                failures.append(item)
    git['known_failure_history'] = failures
    git['known_failure_history_coverage'] = 'sealed_pre_change_worker_observation_and_last_16_canonical_failures;not_complete_history'
    if not valid:
        git['last_scheduled_cycle']['collection_error'] = collection_error or 'canonical_metadata_missing_or_invalid'
        return
    raw = projection.get('last_scheduled_cycle')
    item = safe_cycle(raw)
    observed = stamp(projection.get('observed_at'))
    finished = stamp(item.get('finished_at')) if item else None
    worker = git['last_worker_cycle']
    worker_finished = stamp(worker.get('finished_at'))
    reason = None
    if collection_error or worker_error:
        reason = 'collection_failed'
    elif observed is None or observed > now + 1 or finished is None or finished > observed or finished > now + 1:
        reason = 'scheduled_dates_missing_or_conflicting'
    elif ((worker.get('status') == 'success' and worker.get('exit_code') not in (None, 0))
          or (worker.get('status') == 'failed' and worker.get('exit_code') == 0)
          or (stamp(worker.get('started_at')) is not None and (worker_finished is None or stamp(worker['started_at']) > worker_finished))):
        reason = 'worker_status_or_dates_conflicting'
    elif not item or item['origin'] != 'scheduled' or not item['operation_id'] or item['status'] not in ('success', 'failed', 'deferred'):
        reason = 'scheduled_origin_or_identity_missing'
    else:
        try:
            started = dt.datetime.strptime(raw['request_id'].split('-')[0], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc).timestamp()
        except (KeyError, ValueError, TypeError):
            started = None
        if started is None or started > finished or worker_finished is None or worker_finished < finished:
            reason = 'scheduled_worker_dates_missing_or_conflicting'
        elif worker.get('operation_id') == item['operation_id']:
            if worker.get('status') != item['status'] or worker_finished != finished:
                reason = 'scheduled_worker_result_conflicting'
        elif worker_finished == finished:
            reason = 'scheduled_worker_identity_conflicting'
    if reason:
        git['last_scheduled_cycle'] = {'state': 'unknown', 'status': 'unknown', 'reason': reason, 'finished_at': None, 'collection_error': collection_error}
        return
    item.update(state='observed', source='canonical_nodered_git_backup_result', observed_at=projection['observed_at'],
                worker_relation='same_current_worker' if worker.get('operation_id') == item['operation_id'] else 'older_than_current_worker',
                coverage=['canonical_message_topic_and_helper_request_id', 'not_cryptographic_scheduler_attestation', 'not_offsite_or_restoration'])
    git['last_scheduled_cycle'] = item
    git['summary']['scheduled_success_proven'] = item['status'] == 'success'


def publication(log, now):
    """A no-changes cycle is not publication. Clock/order ambiguity stays unknown."""
    if not isinstance(log, str) or len(log.encode()) > 524288:
        return {'state': 'unknown', 'reason': 'bounded_log_unavailable', 'finished_at': None}
    found = []
    malformed = False
    for line in log.splitlines():
        if 'backup finished: pushed ' not in line:
            continue
        match = re.fullmatch(r'\[([^\]]+)\] backup finished: pushed [a-f0-9]{7,40}', line)
        when = stamp(match[1]) if match else None
        if when is None or when > now + 1:
            malformed = True
        else:
            found.append((when, match[1]))
    conflict = any(b[0] < a[0] for a, b in zip(found, found[1:]))
    if malformed or conflict:
        return {'state': 'unknown', 'reason': 'publication_time_missing_or_conflicting',
                'finished_at': None, 'valid_observations_in_tail': len(found)}
    if not found:
        return {'state': 'unknown', 'reason': 'no_publication_in_bounded_log', 'finished_at': None}
    return {'state': 'observed', 'reason': 'pushed_in_bounded_log',
            'finished_at': found[-1][1], 'valid_observations_in_tail': len(found),
            'coverage': ['bounded_log_only', 'not_remote_HEAD_verification',
                         'not_scheduled_cycle', 'not_offsite_or_restoration']}


def correct_backups(base, log, now, projection=None, projection_error=None, historical=None):
    """Keep original fields/receipts; add explicitly scoped, conservative views."""
    value = copy.deepcopy(base)
    git = value['data']['git']
    cycle = {k: copy.deepcopy(git.get(k)) for k in
             ('status', 'reason', 'finished_at', 'started_at', 'exit_code', 'operation_id', 'evidence')}
    pub = publication(log, now)
    cycle_error = (cycle.get('evidence') or {}).get('collection_error')
    when = stamp(cycle.get('finished_at'))
    began = stamp(cycle.get('started_at'))
    pushed = stamp(pub.get('finished_at'))
    relation = 'unknown'
    reason = 'chronology_not_proven'
    if base.get('collection_error') or cycle_error:
        reason = 'worker_collection_failed'
    elif began is not None and (when is None or began > when):
        reason = 'worker_dates_conflicting'
    elif ((cycle.get('status') == 'success' and cycle.get('exit_code') not in (None, 0))
          or (cycle.get('status') == 'failed' and cycle.get('exit_code') == 0)):
        reason = 'worker_status_exit_code_conflicting'
    elif when is None or when > now + 1:
        reason = 'worker_timestamp_missing_or_invalid'
    elif pushed is not None:
        if when == pushed and cycle.get('status') == 'failed':
            reason = 'simultaneous_conflicting_observations'
        elif cycle.get('status') == 'failed':
            relation = ('publication_after_worker_failure' if pushed > when
                        else 'worker_failure_after_publication')
            reason = 'separate_timestamped_observations'
        elif cycle.get('status') == 'success':
            relation = ('publication_after_worker_success' if pushed > when
                        else 'worker_success_at_or_after_publication')
            reason = 'separate_timestamped_observations'
    git['last_worker_cycle'] = cycle
    # Existing producer has no durable trigger-origin field. 01h coincidence
    # and a later manual push cannot prove which invocation was scheduled.
    git['last_scheduled_cycle'] = {
        'state': 'unknown', 'reason': 'scheduled_trigger_provenance_not_recorded',
        'status': 'unknown', 'finished_at': None,
        'candidate_source': 'git_backup.result', 'candidate_is_last_worker_cycle': True}
    git['last_observed_publication'] = pub
    git['summary'] = {'state': relation, 'reason': reason,
                      'overall_health': 'unknown',
                      'scheduled_success_proven': False,
                      'offsite_success_inferred': False, 'restoration_inferred': False}
    git['history_coverage'] = ['original_latest_worker_result_preserved',
                               'original_sources_not_modified',
                               'bounded_log_not_complete_failure_history']
    apply_cycle_projection(git, projection, projection_error, historical, now, bool(base.get('collection_error') or cycle_error))
    value['schema_version'] = '1.3.0'
    value['coverage'] = list(dict.fromkeys([*value.get('coverage', []),
        'worker_cycle_separate_from_publication', 'scheduled_origin_not_inferred',
        'chronology_unknown_on_missing_conflicting_or_unavailable_evidence']))
    return value


def static_capabilities(base):
    result = copy.deepcopy(base)
    data = result['evidence']['data']
    observer = data.get('ha_notification_observer', {})
    observer.pop('events_discovery_only', None)
    observer.pop('events_subscription_enabled', None)
    observer['event_subscription_interface_implemented'] = True
    data['ha_notification_observer'] = observer
    data.pop('native_events', None)
    data.pop('autonomous_repairs', None)
    data['repair_capability_static'] = {'kind': 'approved_fixed_catalogue',
                                       'general_shell_or_root': False}
    data['events'] = {
        'capability_static': {'implemented': True, 'sanitized_HA_notifications_only': True,
                              'verified_callback_required': True, 'automatic_retry': False},
        'current_observation': {'state': 'unknown', 'reason': 'frontend_live_status_required',
                                'assistant_execution': 'unknown'}}
    data['capability_semantics'] = 'static_interfaces_are_not_current_health_or_approval'
    return result


def project_invocation_correlation(value, observed):
    """Strict cost scopes: whole-unit CPU is distinct from emitted-process RSS."""
    base = {'state': 'unknown', 'collection_error': 'correlation_missing_or_invalid',
        'unit_CPU_24h_window_proven': False, 'all_started_process_peak_RSS_observed': False,
        'missing_or_killed_invocation_cost_proven': False, 'full_goal_accepted': False}
    if not isinstance(value, dict) or value.get('source') != 'fixed_manager_native_and_unit_CPU_correlation':
        return base
    names = ('observed_at', 'window_start', 'window_end', 'window_seconds',
        'started_invocations', 'failed_correlated_invocations', 'missing_runtime_invocations',
        'duplicate_runtime_invocations', 'missing_or_duplicate_terminal_invocations',
        'orphan_native_invocations', 'orphan_terminal_invocations', 'in_flight_invocations',
        'temporal_or_state_conflicts', 'invalid_manager_rows', 'invalid_runtime_rows',
        'invalid_accounting_rows', 'duplicate_start_rows', 'native_process_total_CPU_rows',
        'legacy_observer_CPU_rows', 'sum_process_CPU_us_to_telemetry', 'sum_legacy_observer_CPU_us',
        'native_unit_cgroup_CPU_rows', 'sum_native_unit_CPU_ns', 'observed_peak_rss_rows',
        'invocations_without_observed_peak_rss', 'max_observed_peak_rss_bytes')
    def integer(v):return type(v) is int and 0 <= v <= 10**18
    safe = {name: value.get(name) if integer(value.get(name)) else None for name in names}
    if (safe['window_seconds'] != 86400 or safe['window_start'] is None
            or safe['window_end'] is None or safe['observed_at'] is None
            or abs(safe['observed_at']-observed) > 1
            or safe['window_end'] != safe['observed_at']
            or safe['window_end']-safe['window_start'] != 86400):
        return base
    counts = ('started_invocations', 'missing_or_duplicate_terminal_invocations',
        'orphan_native_invocations', 'orphan_terminal_invocations', 'in_flight_invocations',
        'invalid_manager_rows', 'invalid_runtime_rows', 'invalid_accounting_rows', 'duplicate_start_rows')
    if any(safe[name] is None for name in counts):return base
    error = 'correlation_collection_unconfirmed' if value.get('journal_collection_error') is not None else None
    manager = (not error and safe['started_invocations'] > 0 and value.get('one_boot') is True
        and value.get('manager_start_window_coverage_proven') is True
        and not any(safe[name] for name in counts[1:]))
    cpu = (manager and value.get('all_started_invocation_unit_CPU_observed') is True
        and safe['native_unit_cgroup_CPU_rows'] == safe['started_invocations']
        and safe['sum_native_unit_CPU_ns'] is not None)
    rss = (manager and safe['observed_peak_rss_rows'] == safe['started_invocations']
        and safe['invocations_without_observed_peak_rss'] == 0 and safe['max_observed_peak_rss_bytes'] is not None
        and all(safe[name] == 0 for name in ('missing_runtime_invocations', 'duplicate_runtime_invocations', 'temporal_or_state_conflicts'))
        and value.get('all_starts_have_correlated_runtime_in_window') is True)
    signals = value.get('observed_signals')
    safe_signals = {name: signals[name] for name in ('SIGALRM', 'SIGTERM') if isinstance(signals, dict) and integer(signals.get(name))}
    return {**base, **safe, 'state': 'observed' if not error else 'unknown', 'collection_error': error,
        'observed_signals': safe_signals, 'unit_CPU_24h_window_proven': bool(cpu),
        'all_started_process_peak_RSS_observed': bool(rss),
        'missing_or_killed_invocation_cost_proven': bool(cpu and rss),
        'coverage': ['fixed_native_invocation_identity_correlation', 'complete_unit_CPU_separate_from_emitted_process_peak_RSS',
            'missing_killed_or_inflight_observations_not_zero_cost', 'signals_are_bounded_receipts_not_total_signal_count',
            'no_raw_journal_messages_or_invocation_identifiers', 'not_full_goal_or_PC_off_or_event_latency_acceptance']}


def project_acceptance_report(raw, now, collection_error=None):
    """Observation of a fixed report, kept separate from administrative powers."""
    import math
    missing = {'state': 'unknown', 'source': 'fixed_readonly_procmon_acceptance_capture',
               'collection_error': collection_error or 'report_missing_or_invalid',
               'full_goal_accepted': False, 'administrative_admission_extended': False}
    if not isinstance(raw, dict) or raw.get('schema_version') != 1 or raw.get('source') != missing['source']:
        return missing
    observed = stamp(raw.get('observed_at'))
    scheduled = raw.get('scheduled_for')
    if (observed is None or observed > now+1 or scheduled not in
            ('2026-10-25T04:30:00Z', '2026-10-25T15:20:00Z', '2026-10-25T20:33:00Z', '2026-10-26T11:00:00Z', '2026-10-26T16:00:00Z', '2026-10-26T20:00:00Z', '2026-10-27T23:00:00Z', '2026-10-28T10:00:00Z')
            or stamp(scheduled) > observed):
        return missing
    def number(value):
        return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10**18 else None
    def fields(value, names):
        value = value if isinstance(value, dict) else {}
        return {key: number(value.get(key)) for key in names}
    source = raw.get('cadence') if isinstance(raw.get('cadence'), dict) else {}
    cadence = fields(source, ('window_start', 'window_end', 'window_seconds', 'samples_in_window',
        'max_sample_gap_seconds', 'partial_samples'))
    issues = {'no_samples', 'future_sample', 'duplicate_or_nonmonotonic', 'boot_changed',
        'clock_discontinuity', 'sampling_gap_over_60s', 'sample_collection_error',
        'current_collector_not_completed', 'current_health_not_fresh'}
    seen = source.get('issues')
    known_issues = isinstance(seen, list) and all(isinstance(item, str) and item in issues for item in seen)
    cadence['issues'] = sorted(set(seen)) if known_issues else ['collection_scope_unknown']
    cadence['cadence_24h_proven'] = (source.get('cadence_24h_proven') is True
        and known_issues and not seen and (cadence['window_seconds'] or 0) >= 86400
        and cadence['window_start'] is not None and cadence['window_end'] is not None
        and cadence['window_end'] - cadence['window_start'] >= 86400
        and cadence['window_end'] <= observed+1
        and abs(cadence['window_seconds'] - (cadence['window_end'] - cadence['window_start'])) <= 1
        and cadence['max_sample_gap_seconds'] is not None and cadence['max_sample_gap_seconds'] <= 60)
    source = raw.get('runtime') if isinstance(raw.get('runtime'), dict) else {}
    runtime = fields(source, ('rows', 'failed_rows', 'invalid_telemetry_rows', 'observed_span_seconds',
        'max_completion_gap_ms', 'nonmonotonic_pairs', 'max_wall_ms', 'sum_cpu_us',
        'max_peak_rss_bytes', 'latest_observed_at', 'distinct_boot_count', 'journal_exit'))
    runtime['journal_limit_reached'] = source.get('journal_limit_reached') if type(source.get('journal_limit_reached')) is bool else None
    diagnostic = source.get('journal_diagnostic_category')
    runtime['journal_diagnostic_category'] = diagnostic if diagnostic in ('none', 'implicit_reverse_order',
        'reader_address_space_insufficient', 'journal_integrity_warning', 'access_scope_warning', 'unclassified_diagnostic') else 'unclassified_diagnostic'
    runtime_window = ((runtime['observed_span_seconds'] or 0) >= 86400
        and runtime['nonmonotonic_pairs'] == 0 and runtime['invalid_telemetry_rows'] == 0
        and runtime['distinct_boot_count'] == 1 and runtime['journal_exit'] == 0
        and runtime['journal_limit_reached'] is False
        and runtime['journal_diagnostic_category'] in ('none', 'implicit_reverse_order'))
    correlation = project_invocation_correlation(raw.get('invocation_correlation'), observed)
    error = 'capture_incomplete' if raw.get('collection_error') is not None else collection_error
    return {'state': 'observed' if not error else 'unknown', 'source': missing['source'],
        'observed_at': raw['observed_at'], 'scheduled_for': scheduled, 'age_seconds': round(now-observed, 3),
        'collection_error': error, 'cadence': cadence, 'runtime': runtime,
        'invocation_correlation': correlation,
        'unit_CPU_24h_window_proven': not error and correlation['unit_CPU_24h_window_proven'],
        'cadence_and_emitted_runtime_window_proven': not error and cadence['cadence_24h_proven'] and runtime_window,
        'PC_off_proven': False, 'all_event_latency_proven': False,
        'missing_or_killed_invocation_cost_proven': not error and correlation['missing_or_killed_invocation_cost_proven'], 'full_goal_accepted': False,
        'administrative_admission_extended': False,
        'coverage': ['fixed_readonly_report_only', 'not_current_service_health', 'not_full_goal_acceptance',
                     'no_raw_process_or_journal_messages']}


def procmon_acceptance_observation():
    import time
    now = time.time()
    for scheduled, filename in [('2026-10-28T10:00:00Z', 'window-1000.json'),
            ('2026-10-27T23:00:00Z', 'window-2300.json'),
            ('2026-10-26T20:00:00Z', 'window-2000.json'),
            ('2026-10-26T16:00:00Z', 'window-1600.json'),
            ('2026-10-26T11:00:00Z', 'window-1100.json'),
            ('2026-10-25T20:33:00Z', 'window-2033.json'),
            ('2026-10-25T15:20:00Z', 'window-1520.json'), ('2026-10-25T04:30:00Z', 'window-0430.json')]:
        if stamp(scheduled) <= now:
            report, error = read_metadata('/var/lib/raspberry-procmon-acceptance/' + filename, 0)
            return project_acceptance_report(report, now, error)
    return project_acceptance_report(None, now, 'source_missing')


def backups():
    import time
    import maintenance_evidence as existing
    base = existing.backups()
    try:
        log = existing.fixed_tail(existing.ROOT / '.git-backup.log')
    except (OSError, ValueError):
        log = None
    projection, error = read_metadata('/mnt/data/docker/nodered/.git-backup-health.json', 1000)
    history, history_error = read_metadata('/usr/local/lib/raspberry-repair-control/git-worker-baseline.json', 0)
    result = correct_backups(base, log, time.time(), projection, error, history)
    result['data']['git']['historical_baseline_collection_error'] = history_error
    return result


HOST_CONTAINERS = ('homeassistant', 'nodered', 'mosquitto', 'portainer', 'appdaemon',
    'matter_server', 'zigbee2mqtt', 'ai-bridge', 'docs-review-scheduler', 'kia-uvo-codex-merge')
HOST_UNITS = ('docker', 'procmon', 'mcp_collection', 'external_heartbeat', 'events',
    'ha_notices', 'host_observation')
HOST_METRICS = ('memory_available_bytes', 'memory_total_bytes', 'disk_used_percent',
    'inodes_used_percent', 'temperature_celsius', 'oom_kill_count', 'cpu_busy_percent')
HOST_POLICY_BOUNDS = {'max_report_age_ms': (10000, 60000), 'max_resource_age_ms': (20000, 60000),
    'event_confirm_ms': (1000, 60000), 'resource_confirm_ms': (20000, 120000),
    'observation_confirm_ms': (10000, 120000), 'cpu_busy_percent': (50, 100),
    'memory_available_mib': (128, 2048), 'disk_used_percent': (70, 95),
    'inodes_used_percent': (70, 95), 'temperature_celsius': (60, 90)}


def _observer_json(directory, filename, owner):
    """Internal bounded reader; caller uses two fixed directories, never RPC input."""
    import json
    import os
    import stat
    parent = fd = None
    try:
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(parent)
        if info.st_uid != owner or info.st_gid != owner or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError('unsafe_directory')
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_gid != owner
                or stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1 or info.st_size > 65536):
            raise ValueError('unsafe_file')
        raw = os.read(fd, 65537)
        after = os.fstat(fd)
        if len(raw) > 65536 or (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('changed_or_oversized')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('invalid_json_object')
        return value, None
    except FileNotFoundError:
        return None, 'source_missing'
    except (OSError, ValueError, UnicodeError):
        return None, 'source_invalid_or_unavailable'
    finally:
        if fd is not None:
            os.close(fd)
        if parent is not None:
            os.close(parent)


HOST_TIMING_SOURCES = ('docker', 'systemd', 'resources')
HOST_TIMING_FIELDS = ('expected', 'observed', 'unknown', 'over_contract', 'missing')
HOST_TIMING_COUNTERS = tuple(source+'.'+field for source in HOST_TIMING_SOURCES for field in HOST_TIMING_FIELDS) + (
    'report_gaps', 'source_unavailable', 'source_faults', 'clock_conflicts', 'invalid_observations')
HOST_TIMING_ERRORS = frozenset(('measurement_policy_unavailable', 'report_unavailable_or_stale',
    'producer_timing_unavailable', 'producer_clock_unstable', 'reader_clock_unavailable',
    'clock_alignment_unconfirmed', 'producer_counter_reversed', 'producer_counter_mismatch',
    'accounting_counter_exhausted', 'accounting_state_invalid', 'reason_history_invalid'))


def project_passive_invalid_history(value):
    """Project bounded canonical reasons; never infer a past failure's cause."""
    result = {'version': 1, 'state': 'unknown', 'collection_error': 'reason_history_not_recorded',
              'covered_total': None,
              'unattributed_prior_count': None, 'counts': None, 'recent': []}
    def count(x):return type(x) is int and 0 <= x <= 2*10**12
    if not isinstance(value,dict):return result
    current,past=value.get('invalid_observations'),value.get('past_counters')
    if (not count(current) or not isinstance(past,list) or len(past)!=20 or not count(past[19])):
        return result
    total=current+past[19]
    if not count(total):return result
    if 'invalid_reason_history' not in value:
        result['unattributed_prior_count']=total
        return result
    result['collection_error']='passive_reason_history_invalid'
    history=value['invalid_reason_history']
    reasons=HOST_TIMING_ERRORS-{'reason_history_invalid'}
    if (not isinstance(history,dict) or set(history)!={'version','covered_total','unattributed_prior_count','counts','recent'}
            or type(history['version'])is not int or history['version']!=1
            or not count(history['unattributed_prior_count']) or not isinstance(history['counts'],dict)
            or set(history['counts'])!=reasons or not all(count(n)for n in history['counts'].values())
            or not count(history['covered_total']) or history['covered_total']!=total
            or history['unattributed_prior_count']+sum(history['counts'].values())!=history['covered_total']
            or not isinstance(history['recent'],list) or len(history['recent'])>16):
        return result
    retained={reason:0 for reason in reasons}
    for row in history['recent']:
        if (not isinstance(row,dict) or set(row)!={'reason','observed_at','epoch'}
                or type(row['reason'])is not str or row['reason']not in reasons
                or not count(row['epoch']) or not count(value.get('epoch'))
                or row['epoch']>value['epoch']
                or not(row['observed_at']is None or stamp(row['observed_at'])is not None)):
            return result
        retained[row['reason']]+=1
    if any(retained[reason]>history['counts'][reason]for reason in reasons):return result
    result.update(state='observed',collection_error=None,
        covered_total=history['covered_total'],
        unattributed_prior_count=history['unattributed_prior_count'],counts=dict(history['counts']),
        recent=[dict(row)for row in history['recent']])
    return result


def project_passive_host_timing(context, report, now):
    """Closed view of canonical counters, never administrative or whole-goal authority."""
    import math
    result = {'version': 1, 'state': 'unknown', 'collection_error': 'passive_timing_not_recorded',
        'observed_at': None, 'age_seconds': None, 'epoch': None, 'sources': None,
        'window24h': None, 'full24h_proven': False, 'all_event_latency_proven': False,
        'coverage': ['producer_sequence_deltas_not_events_lost_before_the_producer',
            'first_reader_and_canvas_observation_includes_healthy_samples',
            'canvas_monotonic_window_and_declared_clock_alignment_bound',
            'hourly_cumulative_anchors_not_raw_event_archive',
            'historical_unknown_epochs_and_missing_records_preserved',
            'no_home_assistant_or_MQTT_source_timing_in_this_contract',
            'not_notification_delivery_assistant_execution_or_whole_goal_acceptance']}
    def number(x, minimum=0, maximum=1e15):
        return type(x) in (int, float) and math.isfinite(x) and minimum <= x <= maximum
    def count(x):return type(x) is int and 0 <= x <= 10**12
    def counters(x):return isinstance(x, list) and len(x)==len(HOST_TIMING_COUNTERS) and all(count(v)for v in x)
    def need(value):
        if not value:raise ValueError('invalid_passive_timing')
    value = context.get('host_observer_timing_v1') if isinstance(context, dict) else None
    result['invalid_reason_history']=project_passive_invalid_history(value)
    if not isinstance(value, dict):return result
    if result['invalid_reason_history']['collection_error']=='passive_reason_history_invalid':
        result['collection_error']='passive_timing_invalid';return result
    if value.get('state') == 'unknown':
        error = value.get('collection_error')
        result['collection_error'] = error if error in HOST_TIMING_ERRORS else 'passive_timing_invalid'
        return result
    try:
        need(value.get('version')==1 and value.get('state')=='observed' and value.get('collection_error')is None)
        observed, started = stamp(value.get('observed_at')), stamp(value.get('started_at'))
        need(observed is not None and started is not None and started<=observed<=now+1)
        need(isinstance(report,dict)and isinstance(report.get('instance_id'),str)and re.fullmatch('[a-f0-9]{64}',report['instance_id'])and isinstance(report.get('boot_id_sha256'),str)and re.fullmatch('[a-f0-9]{64}',report['boot_id_sha256'])and value.get('instance')==report.get('instance_id')and value.get('boot')==report.get('boot_id_sha256'))
        need(count(value.get('epoch'))and value['epoch']>0 and count(value.get('previous_epochs'))and count(value.get('historical_unknown_epochs')))
        need(value.get('epoch_reason')in('initial_baseline','consumer_runtime_restart','producer_epoch_changed',
            'measurement_policy_changed','civil_clock_changed','consumer_monotonic_changed','producer_clock_changed'))
        limits=value.get('limits');policy=context.get('host_observer_timing_policy_v1')
        need(isinstance(limits,dict)and set(limits)=={'event_latency_ms','resource_latency_ms'}and limits==policy and
            number(limits['event_latency_ms'],1000,60000)and number(limits['resource_latency_ms'],20000,120000))
        need(number(value.get('started_canvas_monotonic_ms'))and number(value.get('last_canvas_monotonic_ms'))and
            value['last_canvas_monotonic_ms']>=value['started_canvas_monotonic_ms'])
        source_rows=value.get('sources');need(isinstance(source_rows,dict)and set(source_rows)==set(HOST_TIMING_SOURCES))
        sources={};current=[]
        for source in HOST_TIMING_SOURCES:
            row=source_rows[source];need(isinstance(row,dict)and all(count(row.get(key))for key in HOST_TIMING_FIELDS))
            need(row['observed']<=row['expected']and row['missing']==row['expected']-row['observed']and
                row['unknown']<=row['observed']and row['over_contract']<=row['observed']-row['unknown'])
            current.extend(row[key]for key in HOST_TIMING_FIELDS)
            sources[source]={key:row[key]for key in HOST_TIMING_FIELDS}
            for key in ('max_source_to_reader_ms','max_reader_to_canvas_ms','max_source_to_canvas_upper_ms'):
                need(row.get(key)is None or number(row[key]));sources[source][key]=row.get(key)
        for key in HOST_TIMING_COUNTERS[15:]:need(count(value.get(key)));current.append(value[key])
        need(counters(value.get('past_counters')))
        anchors=value.get('anchors');need(isinstance(anchors,list)and len(anchors)<=25)
        previous_mono=None;previous_counters=None
        for anchor in anchors:
            need(isinstance(anchor,list)and len(anchor)==22 and number(anchor[0])and stamp(anchor[1])is not None and
                anchor[0]<=value['last_canvas_monotonic_ms']and counters(anchor[2:])and
                all(v<=current[i]for i,v in enumerate(anchor[2:])))
            need(previous_mono is None or anchor[0]>previous_mono)
            need(previous_counters is None or all(v>=previous_counters[i]for i,v in enumerate(anchor[2:])))
            previous_mono,previous_counters=anchor[0],anchor[2:]
        window=value.get('window24h');need(isinstance(window,dict)and window.get('state')in('collecting','candidate')and number(window.get('minimum_span_seconds')))
        projected_window={'state':window['state'],'minimum_span_seconds':window['minimum_span_seconds'],'counters':None}
        if window['state']=='candidate':
            need(window['minimum_span_seconds']>=86400 and counters(window.get('counters'))and
                all(v<=current[i]for i,v in enumerate(window['counters']))and
                stamp(window.get('started_at'))is not None and stamp(window.get('ended_at'))is not None)
            eligible=[anchor for anchor in anchors if value['last_canvas_monotonic_ms']-anchor[0]>=86400000]
            need(bool(eligible))
            anchor=eligible[-1]
            need(window['started_at']==anchor[1]and window['ended_at']==value['observed_at']and
                window['minimum_span_seconds']==(value['last_canvas_monotonic_ms']-anchor[0])/1000 and
                window['counters']==[v-anchor[i+2]for i,v in enumerate(current)])
            projected_window.update(started_at=window['started_at'],ended_at=window['ended_at'],
                counters=dict(zip(HOST_TIMING_COUNTERS,window['counters'])))
        else:need(window.get('counters')is None)
        result.update(state='observed',collection_error=None,observed_at=value['observed_at'],
            age_seconds=round(max(0,now-observed),3),epoch=value['epoch'],epoch_reason=value['epoch_reason'],
            started_at=value['started_at'],elapsed_canvas_monotonic_seconds=(value['last_canvas_monotonic_ms']-value['started_canvas_monotonic_ms'])/1000,
            sources=sources,limits=dict(limits),anchor_count=len(anchors),window24h=projected_window,
            current_counters=dict(zip(HOST_TIMING_COUNTERS,current)),previous_epochs=value['previous_epochs'],
            historical_unknown_epochs=value['historical_unknown_epochs'],past_counters=dict(zip(HOST_TIMING_COUNTERS,value['past_counters'])),
            alignment_upper_bound_allowance_ms=1000,application_context_flush_allowance_seconds=30)
        return result
    except (ValueError,TypeError,KeyError,OverflowError,IndexError):
        result['collection_error']='passive_timing_invalid';return result


def project_host_legacy_history(value, known, now):
    """Project quarantined chronology as unknown history, never as recovery."""
    import math
    if value is None:
        return [], None
    def number(v):
        return type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 10**18
    fields = {'first_seen_at', 'last_seen_at', 'notified_at', 'kind', 'source_first_observed_at',
              'source_time_kind', 'current_evidence', 'sample_count', 'last_sample_at', 'clock_conflict'}
    rows, seen = [], set()
    try:
        if (type(value) is not dict or set(value) != {'version', 'records'} or type(value['version']) is not int
                or value['version'] != 1 or type(value['records']) is not list or len(value['records']) > 64):
            raise ValueError('invalid_history')
        for record in value['records']:
            if (type(record) is not dict or set(record) != {'role', 'reason', 'quarantined_at', 'original'}
                    or record['role'] not in known or not record['role'].startswith('native_')
                    or record['role'] in seen or record['reason'] != 'legacy_notified_before_first_seen'
                    or not number(record['quarantined_at']) or record['quarantined_at']/1000 > now+1):
                raise ValueError('invalid_history')
            row = record['original']
            if (type(row) is not dict or not set(row) <= fields or row.get('kind') != 'native'
                    or not all(number(row.get(k)) for k in ('first_seen_at', 'last_seen_at', 'notified_at'))
                    or not row['notified_at'] < row['first_seen_at'] <= row['last_seen_at'] <= record['quarantined_at']
                    or row.get('current_evidence') not in ('failed', 'unknown')
                    or row.get('source_first_observed_at') is not None and stamp(row['source_first_observed_at']) is None
                    or 'source_time_kind' in row and row['source_time_kind'] not in ('producer_occurrence', 'producer_observation', 'unknown')
                    or 'sample_count' in row and (type(row['sample_count']) is not int or row['sample_count'] < 0)
                    or row.get('last_sample_at') is not None and stamp(row['last_sample_at']) is None
                    or 'clock_conflict' in row and type(row['clock_conflict']) is not bool):
                raise ValueError('invalid_history')
            seen.add(record['role'])
            rows.append({'role': record['role'], 'historical_evidence': 'unknown', 'reason': record['reason'],
                         'quarantined_at': dt.datetime.fromtimestamp(record['quarantined_at']/1000, dt.timezone.utc).isoformat(),
                         'original_chronology_retained': True, 'original_notification_intent_recorded': True,
                         'not_current_failure_proof': True, 'recovery_proven': False})
        return rows, None
    except (ValueError, TypeError, KeyError, OverflowError):
        return [], 'legacy_incident_metadata_invalid'


def project_host_observation(report, context, now, report_error=None, context_error=None):
    """Metadata observation only. Never derive administrative authority or whole-host health."""
    import math
    def number(value, minimum=0, maximum=10**18):
        return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum
    def count(value):
        return type(value) is int and 0 <= value <= 10**12
    def hashed(value):
        return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None
    def source_error(value):
        return value if value in ('source_missing', 'source_invalid_or_unavailable') else 'source_invalid_or_unavailable'
    result = {'source': 'fixed_protected_host_report_and_nodered_context',
        'observed_at': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec='seconds'),
        'state': 'unknown', 'collection_error': None, 'producer': None, 'NodeRED': None,
        'operational_health': 'unknown', 'all_event_resource_latency_proven': False,
        'PC_off_proven': False, 'full24h_proven': False, 'Eva_execution_proven': False,
        'coverage': ['fixed_root_owned_report_and_application_owned_context_only',
            'allowlisted_roles_metrics_and_policy_metadata', 'partial_stream_reconnect_and_ring_history',
            'no_initial_inventory_or_universal_application_readiness',
            'intention_not_notification_delivery_or_assistant_execution', 'no_private_messages_prompts_logs_or_credentials']}
    errors = []
    if report_error:
        errors.append('producer_' + source_error(report_error))
    if context_error:
        errors.append('context_' + source_error(context_error))
    policy = context.get('host_observer_policy_v1') if isinstance(context, dict) else None
    policy_valid = isinstance(policy, dict) and set(policy) == set(HOST_POLICY_BOUNDS) and all(
        number(policy.get(key), *bounds) for key, bounds in HOST_POLICY_BOUNDS.items())
    if not policy_valid:
        errors.append('visual_policy_unavailable_or_invalid')
    if isinstance(report, dict):
        observed = stamp(report.get('observed_at'))
        resource = report.get('resources')
        resource = resource if isinstance(resource, dict) else {}
        sampled = stamp(resource.get('observed_at'))
        valid = (report.get('schema_version') == 1 and report.get('source') == 'fixed_readonly_host_observer'
            and hashed(report.get('instance_id')) and hashed(report.get('boot_id_sha256'))
            and count(report.get('sequence')) and count(report.get('evicted_event_records'))
            and report['evicted_event_records'] <= report['sequence']
            and observed is not None and observed <= now+1 and sampled is not None and sampled <= observed+1)
        if valid:
            channels = {}
            sources = report.get('sources') if isinstance(report.get('sources'), dict) else {}
            for name in ('docker', 'systemd'):
                row = sources.get(name) if isinstance(sources.get(name), dict) else {}
                good = row.get('state') in ('connected', 'unknown') and row.get('collection_error') in (None, 'starting', 'stream_unavailable_or_invalid')
                if not good or row.get('state') == 'connected' and row.get('collection_error') is not None:
                    errors.append('stream_metadata_invalid')
                    channels[name] = {'state': 'unknown', 'collection_error': 'source_invalid_or_unavailable'}
                else:
                    channels[name] = {'state': row['state'], 'collection_error': row.get('collection_error')}
            metrics = resource.get('data') if isinstance(resource.get('data'), dict) else {}
            data = {}
            for key in HOST_METRICS:
                value = metrics.get(key)
                maximum = 100 if key.endswith('_percent') else 150 if key == 'temperature_celsius' else 10**18
                data[key] = value if number(value, 0, maximum) else None
                if value is not None and data[key] is None:
                    errors.append('metric_invalid')
            raw_errors = resource.get('collection_errors')
            valid_errors = isinstance(raw_errors, list) and len(raw_errors) <= 8 and all(x in (*HOST_METRICS, 'cpu_ticks') for x in raw_errors)
            if not valid_errors:
                errors.append('metric_collection_metadata_invalid')
            cost = report.get('producer_cost') if isinstance(report.get('producer_cost'), dict) else {}
            result['producer'] = {'observed_at': report['observed_at'], 'age_seconds': round(max(0, now-observed), 3),
                'sequence': report['sequence'], 'evicted_event_records': report['evicted_event_records'], 'streams': channels,
                'within_visual_report_validity': policy_valid and (now-observed)*1000 <= policy['max_report_age_ms'],
                'resources': {'observed_at': resource['observed_at'], 'age_seconds': round(max(0, now-sampled), 3), 'data': data,
                    'within_visual_resource_validity': policy_valid and (now-sampled)*1000 <= policy['max_resource_age_ms'],
                    'collection_errors': raw_errors if valid_errors else ['source_invalid_or_unavailable']},
                'producer_cost': {'self_cpu_seconds': cost.get('self_cpu_seconds') if number(cost.get('self_cpu_seconds')) else None,
                    'self_peak_rss_bytes': cost.get('self_peak_rss_bytes') if count(cost.get('self_peak_rss_bytes')) else None,
                    'scope': 'producer_self_only_not_journal_child_or_24h'}}
            if not result['producer']['within_visual_report_validity']:
                errors.append('producer_outside_visual_validity_or_policy_unknown')
        else:
            errors.append('producer_schema_or_dates_invalid')
    elif not report_error:
        errors.append('producer_source_missing')
    cursor = context.get('host_observer_cursor_v1') if isinstance(context, dict) else None
    if isinstance(cursor, dict):
        last = cursor.get('last_report_at')
        valid = (number(last) and last/1000 <= now+1 and hashed(cursor.get('instance')) and count(cursor.get('sequence')))
        if valid:
            native = cursor.get('states') if isinstance(cursor.get('states'), dict) else {}
            rows = []
            for source, roles, actions in [('docker', HOST_CONTAINERS, ('start', 'die', 'restart', 'destroy', 'health_status: healthy', 'health_status: unhealthy', 'health_status: starting', 'unknown')),
                                          ('systemd', HOST_UNITS, ('started', 'stopped', 'failed', 'unknown'))]:
                for role in roles:
                    value = native.get(source+':'+role)
                    if not isinstance(value, dict):
                        continue
                    occurred = stamp(value.get('occurred_at'))
                    if (value.get('kind') == 'native' and value.get('source') == source and value.get('name') == role
                            and value.get('action') in actions and occurred is not None and occurred <= last/1000+1):
                        rows.append({'source': source, 'role': role, 'action': value['action'], 'occurred_at': value['occurred_at']})
                    else:
                        errors.append('native_role_metadata_invalid')
            known = {'resource_host_'+x for x in ('cpu', 'memory', 'disk', 'inodes', 'temperature')}
            known.update('observation_host_'+x for x in ('report', 'docker', 'systemd', 'resources'))
            known.update('native_docker_'+x for x in HOST_CONTAINERS)
            known.update('native_systemd_'+x for x in HOST_UNITS)
            known.add('native_kernel_counter_host_oom')
            state = context.get('host_observer_incidents_v1')
            state = state.get('incidents') if isinstance(state, dict) and state.get('version') == 1 else None
            incidents = []
            if not isinstance(state, dict) or len(state) > len(known):
                errors.append('incident_metadata_unavailable_or_invalid')
            else:
                for key, row in state.items():
                    if key not in known or not isinstance(row, dict):
                        errors.append('incident_metadata_unavailable_or_invalid')
                        continue
                    first, seen, notified = row.get('first_seen_at'), row.get('last_seen_at'), row.get('notified_at')
                    if (not number(first) or not number(seen) or first > seen or seen/1000 > now+1
                            or notified is not None and (not number(notified) or not first <= notified <= seen)
                            or row.get('current_evidence') not in ('failed', 'unknown')):
                        errors.append('incident_dates_or_state_invalid')
                        continue
                    incidents.append({'role': key, 'evidence': row['current_evidence'],
                        'notification_intent_recorded': notified is not None,
                        'clock_conflict': row.get('clock_conflict') is True})
            ledger = context.get('host_observer_incidents_v1')
            legacy, legacy_error = project_host_legacy_history(ledger.get('legacy_history_v1') if isinstance(ledger, dict) else None, known, now)
            if legacy_error:
                errors.append(legacy_error)
            result['NodeRED'] = {'last_report_at': dt.datetime.fromtimestamp(last/1000, dt.timezone.utc).isoformat(timespec='milliseconds'),
                'age_seconds': round(max(0, now-last/1000), 3), 'sequence': cursor['sequence'],
                'native_role_observations': sorted(rows, key=lambda x: stamp(x['occurred_at']), reverse=True),
                'incident_observations': incidents, 'legacy_incident_observations': legacy,
                'visual_policy': dict(policy) if policy_valid else None,
                'application_context_persistence_flush_allowance_seconds': 30}
            if now-last/1000 > 60:
                errors.append('NodeRED_observation_stale')
            if result['producer'] is not None and (cursor['instance'] != report['instance_id'] or cursor['sequence'] > report['sequence']):
                errors.append('producer_context_identity_or_sequence_conflict')
        else:
            errors.append('NodeRED_schema_or_dates_invalid')
    elif not context_error:
        errors.append('NodeRED_cursor_missing')
    result['collection_error'] = ';'.join(dict.fromkeys(errors)) if errors else None
    if not errors and result['producer'] is not None and result['NodeRED'] is not None:
        result['state'] = 'observed'
    result['passive_timing'] = project_passive_host_timing(context, report, now)
    return result


def host_observation():
    import time
    report, report_error = _observer_json('/mnt/data/docker/nodered/.host-health-observer', 'report.json', 0)
    context, context_error = _observer_json('/mnt/data/docker/nodered/context/host_observer_tab', 'flow.json', 1000)
    return project_host_observation(report, context, time.time(), report_error, context_error)
