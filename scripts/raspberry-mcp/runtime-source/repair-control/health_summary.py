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


def correct_backups(base, log, now):
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
    value['schema_version'] = '1.2.0'
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
    return correct_backups(base, log, time.time())
