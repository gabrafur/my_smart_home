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
