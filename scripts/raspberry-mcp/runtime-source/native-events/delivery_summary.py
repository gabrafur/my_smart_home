"""Pure, bounded notification summaries; no transport, private text or effects."""
import datetime
import hashlib
import json
import math
import re

VERSION = 'notification_summary_v1'
MAX_GROUPS = 8
PHASES = ('added', 'updated', 'removed')


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def iso(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def group_events(rows, now, current=None):
    """All input rows must be from the same authorized subscription snapshot.

    Current state is supplied by fresh collector evidence, never inferred from
    removal, delivery outcome or an old change. Every omitted revision remains
    in the durable membership/history. Preview truncation is explicit.
    """
    if len(rows) > 256 or not finite(now):
        raise ValueError('summary_scope_unconfirmed')
    by_object = {}
    for row in rows:
        body = json.loads(row['body'])
        data = body['data']
        if (data.get('project') != '/mnt/data/docker'
                or data.get('topic') != 'ha_notification'
                or data.get('source') != 'ha_persistent_notification'
                or data.get('phase') not in PHASES
                or any(not isinstance(data.get(k), str) or not re.fullmatch('[a-f0-9]{64}', data[k])
                       for k in ('object_id', 'revision'))
                or body.get('eventId') != row['id']
                or not finite(row['created']) or not now-86400 <= row['created'] <= now+1):
            raise ValueError('summary_event_unconfirmed')
        by_object.setdefault(data['object_id'], []).append((row, data))
    groups = []
    for object_id, events in by_object.items():
        events.sort(key=lambda pair: (pair[0]['created'], pair[0]['id']))
        last_row, last_data = events[-1]
        # Equal clock times have no authoritative sequence in this old DB.
        tied = len({d['phase'] for row, d in events if row['created'] == last_row['created']}) > 1
        state = 'unknown' if current is None else 'current' if object_id in current else 'removed'
        phases = [data['phase'] for _, data in events]
        runs = [phase for index, phase in enumerate(phases) if index == 0 or phase != phases[index-1]]
        groups.append({
            'object_id': object_id, 'current_state': state,
            'current_revision': current.get(object_id) if current is not None else None,
            'latest_known_phase': None if tied else last_data['phase'],
            'historical_order_ambiguous': tied,
            'first_change_at': iso(events[0][0]['created']),
            'last_change_at': iso(last_row['created']),
            'change_count': len(events),
            'phase_counts': {phase: phases.count(phase) for phase in PHASES},
            'transition_preview': runs[:8], 'transition_preview_omitted': max(0, len(runs)-8),
            'revisions_coalesced': len(events)-1,
            'recovery_proven': False,
            # Private ledger fields are stripped from the webhook body.
            '_members': [row['id'] for row, _ in events], '_latest': last_row['created'],
        })
    groups.sort(key=lambda g: (g['current_state'] == 'current', g['_latest'], g['object_id']), reverse=True)
    return groups


def make_batch(groups, subscription, now, source_observed_at):
    selected = groups[:MAX_GROUPS]
    if not selected:
        return None
    members = sorted(member for group in selected for member in group['_members'])
    identity = hashlib.sha256(encode([VERSION, subscription, members]).encode()).hexdigest()
    public = [{k: v for k, v in group.items() if not k.startswith('_')} for group in selected]
    envelope = {'eventId': identity, 'name': 'smart_home.observation',
                'timestamp': iso(now), 'cursor': None,
                'data': {'project': '/mnt/data/docker', 'topic': 'ha_notification',
                         'source': 'ha_persistent_notification', 'delivery_kind': VERSION,
                         'source_observed_at': source_observed_at,
                         'summary_as_of': iso(now), 'notifications': public,
                         'covered_event_records': len(members),
                         'remaining_notification_groups': len(groups)-len(selected),
                         'recovery_proven': False,
                         'assistant_execution': 'unknown',
                         'history_semantics': 'transition_history_not_current_incidents'}}
    body = encode(envelope)
    if len(body.encode()) > 16384:
        raise ValueError('summary_payload_limit')
    return identity, body, members


def opportunity(attempt_times, now, expires, pending):
    if (not finite(now) or expires is not None and not finite(expires)
            or any(not finite(at) or at > now+1 for at in attempt_times)
            or type(pending) is not int or pending < 0):
        raise ValueError('delivery_opportunity_unconfirmed')
    recent = sorted(at for at in attempt_times if at > now-86400)
    budget_at = recent[-6]+86400 if len(recent) >= 6 else now
    spacing_at = recent[-1]+600 if recent else now
    next_at = max(now, budget_at, spacing_at)
    active = expires is not None and expires > now
    reason = ('subscription_inactive' if not active else 'no_eligible_events' if pending == 0
              else 'rolling_daily_attempt_limit_reached' if budget_at > now
              else 'minimum_spacing' if spacing_at > now else 'ready')
    return {'state': 'observed', 'block_reason': reason,
            'attempts_last_24h': len(recent), 'budget_available_at': iso(max(now, budget_at)),
            'spacing_available_at': iso(max(now, spacing_at)),
            'next_opportunity_at': iso(next_at) if active and pending else None,
            'subscription_expires_at': iso(expires) if expires is not None else None,
            'within_subscription_validity': next_at < expires if active and pending else False,
            'requires_subscription_renewal': bool(pending and (not active or next_at >= expires)),
            'poll_allowance_seconds': 2, 'opportunity_is_not_delivery_guarantee': True,
            'maximum_attempts_per_day': 6, 'minimum_attempt_spacing_seconds': 600}
