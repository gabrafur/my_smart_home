"""Read-only catalog of explicitly authorized IDs; never discovers other threads."""
import base64
import hashlib
import json
import math
import re
import time


def catalog(entries, invoke, limit, cursor, clock=time.time):
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError('invalid_thread_limit')
    scope = hashlib.sha256(json.dumps(sorted(e['thread_id'] for e in entries)).encode()).hexdigest()
    after = None
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or len(cursor) > 512:
                raise ValueError()
            value = json.loads(base64.b64decode(cursor, validate=True))
            if (set(value) != {'scope', 'activity', 'id'} or value['scope'] != scope or
                not isinstance(value['id'], str) or
                not re.fullmatch(r'[a-f0-9-]{36}', value['id']) or
                type(value['activity']) not in (int, float) or
                not math.isfinite(value['activity'])):
                raise ValueError()
            after = (-value['activity'], value['id'])
        except Exception:
            raise ValueError('invalid_thread_cursor') from None
    observed = clock()
    deadline = time.monotonic() + 20
    rows = []
    for entry in entries:
        row = {**entry, 'safe_title': None, 'open_link': None, 'state': 'unknown',
               'can_accept_input': None, 'source': 'unknown', 'last_execution': None,
               'last_activity': entry.get('created_at'), 'observed_at': observed,
               'collection_error': None, 'input_capability_source': 'daemon_metadata_only',
               'adapter_send_requires_fresh_profile_validation': True}
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError('catalog_observation_budget')
            meta = invoke({'mode': 'metadata', 'thread_id': entry['thread_id']})
            if meta.get('thread_id') != entry['thread_id']:
                raise ValueError('identity_changed')
            # The sealed RPC has already projected an exact metadata allowlist.
            for key in ('state', 'can_accept_input', 'source', 'created_at',
                        'last_activity', 'last_execution', 'collection_error'):
                row[key] = meta[key]
        except Exception:
            row['collection_error'] = 'thread_collection_failed'
        # No native title is exported: only fixed adapter labels are permitted.
        if entry['origin'] == 'adapter':
            row['safe_title'] = 'Raspberry task ' + entry['task_id'][:8]
        rows.append(row)
    key = lambda r: (-(r['last_activity'] or 0), r['thread_id'])
    rows.sort(key=key)
    created = [r for r in rows if r['origin'] == 'adapter']
    executed = [r for r in rows if r['last_execution'] and
                r['last_execution']['started_at'] is not None]
    latest_adapter_created = max(created, key=lambda r: (r['created_at'] or 0, r['thread_id']), default=None)
    latest_created = max(rows, key=lambda r: (r['created_at'] or 0, r['thread_id']), default=None)
    latest_executed = max(executed, key=lambda r: (r['last_execution']['started_at'], r['thread_id']), default=None)
    remaining = [r for r in rows if after is None or key(r) > after]
    page = remaining[:limit]
    next_cursor = None
    if len(remaining) > limit:
        last = page[-1]
        next_cursor = base64.b64encode(json.dumps({'scope': scope,
            'activity': last['last_activity'] or 0, 'id': last['thread_id']}).encode()).decode()
    return {'observed_at': observed, 'collection_error':
            'partial_collection' if any(r['collection_error'] for r in rows) else None,
            'coverage': 'partial_host_authorized_scope_only',
            'scope': 'legacy_allowlist_and_adapter_registry',
            'ordering': 'last_activity_desc_thread_id_asc',
            'pagination_consistency': 'live_keyset_not_snapshot',
            'data': page, 'next_cursor': next_cursor, 'authorized_count': len(rows),
            'latest_created_thread_id': latest_created['thread_id'] if latest_created else None,
            'latest_adapter_created_thread_id': latest_adapter_created['thread_id'] if latest_adapter_created else None,
            'latest_executed_thread_id': latest_executed['thread_id'] if latest_executed else None,
            'latest_execution_coverage': 'authorized_threads_latest_turn_only',
            'automatic_retry': False}
