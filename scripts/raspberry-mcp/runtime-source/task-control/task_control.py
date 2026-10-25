"""Fixed unprivileged task admission for the existing private Codex daemon.

Installed code/policy must be root owned. No root RPC, arbitrary path/command,
credentials, policy overrides or subscription mutation are exposed here.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import time

from task_store import Store, BUSY, need, fingerprint

ROOT = Path('/usr/local/lib/raspberry-task-control')
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
POLICY = ROOT / 'policy.json'
LEGACY_POLICY = Path('/usr/local/lib/raspberry-mcp/codex-control-approval.json')
LEGACY_DB = Path('/var/lib/raspberry-mcp-operations/codex-control/jobs.sqlite3')
UID = 1001
TOOLS = ('codex_task_create', 'codex_task_send', 'codex_task_status',
         'codex_task_reconcile', 'codex_task_revoke', 'codex_task_list')
FIELDS = {
    'codex_task_create': ('operation_id', 'task_key', 'objective', 'acceptance'),
    'codex_task_send': ('operation_id', 'task_id', 'text'),
    'codex_task_status': ('operation_id', 'kind'),
    'codex_task_reconcile': ('operation_id', 'result_hash'),
    'codex_task_revoke': (),
    'codex_task_list': ('page_size', 'cursor'),
}


def read(path, uid, mode, limit=1048576):
    # Fixed paths only; reject symlink ancestors as well as the leaf.
    directory = os.open('/', os.O_PATH | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = nxt
        fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == uid and
                 stat.S_IMODE(s.st_mode) == mode and s.st_nlink == 1 and
                 s.st_size <= limit, 'unsafe_task_file')
            raw = os.read(fd, limit + 1)
            need(len(raw) <= limit, 'task_file_limit')
            return raw
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def observation_legacy(old):
    """Retain observation without extending admission or fabricating a clock.

    The root policy and both legacy source digests remain mandatory. Only a
    temporal/boot lease failure permits this fallback; every effect still uses
    old.plan() immediately before dispatch.
    """
    try:
        return old.plan()
    except ValueError as error:
        need(str(error) == 'control_lease_expired', 'control_observation_refused')
    legacy = json.loads(read(LEGACY_POLICY, 0, 0o644))
    need(legacy.get('enabled') is True and legacy.get('threads') == list(old.THREADS)
         and legacy.get('project') == '/mnt/data/docker' and
         legacy.get('max_sends') == 6, 'control_observation_scope_changed')
    need(set(legacy.get('source_hashes', {})) ==
         {'codex_control.py', 'codex_control_rpc.cjs'}, 'control_observation_code_scope')
    for name, digest in legacy['source_hashes'].items():
        need(hashlib.sha256(read(old.ROOT/name, 0, 0o644)).hexdigest() == digest,
             'control_observation_code_changed')
    return {**legacy, '_observation_only': True}


def policy(old, observation=False):
    legacy = observation_legacy(old) if observation else old.plan()
    p = json.loads(read(POLICY, 0, 0o644))
    need(isinstance(p.get('enabled'), bool) and
         p.get('legacy_policy_sha256') == hashlib.sha256(read(LEGACY_POLICY, 0, 0o644)).hexdigest()
         and p.get('expires_at') == legacy['expires_at'] and
         p.get('boot_id') == legacy['boot_id'], 'task_admission_changed')
    need(p.get('max_sends_per_24h') == 48 and p.get('minimum_spacing_seconds') == 60
         and p.get('maximum_database_bytes') == 1048576, 'task_limits_changed')
    need(set(p.get('source_hashes', {})) == {
        'task_control.py', 'task_store.py', 'task_rpc.cjs', 'task-broker.py', 'task_list.py'},
        'task_code_scope_changed')
    for name, digest in p['source_hashes'].items():
        need(hashlib.sha256(read(ROOT / name, 0, 0o644)).hexdigest() == digest,
             'sealed_task_code_changed')
    for path, digest in p['dependencies'].items():
        # Dependency list itself is in the sealed root policy, not MCP input.
        need(hashlib.sha256(read(Path(path), 0, 0o644)).hexdigest() == digest,
             'sealed_dependency_changed')
    return p, legacy


def validate(name, args):
    need(name in TOOLS and isinstance(args, dict) and
         set(args) == {'host', *FIELDS[name]} and args.get('host') == 'raspberry',
         'task_scope_refused')
    need(len(json.dumps(args, ensure_ascii=False).encode()) <= 12000, 'task_request_byte_limit')
    for field in ('operation_id', 'task_id', 'result_hash'):
        if field in args:
            length = 64 if field == 'result_hash' else 32
            need(isinstance(args[field], str) and
                 re.fullmatch('[a-f0-9]{' + str(length) + '}', args[field]), 'invalid_task_identifier')
    if name == 'codex_task_status':
        need(args['kind'] in ('creation', 'turn'), 'invalid_task_kind')
    if name == 'codex_task_list':
        import task_list
        task_list.validate(args)


def resources():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key == 'MemAvailable':
            memory[key] = int(value.strip().split()[0]) * 1024
    need(memory.get('MemAvailable', 0) >= 2 * 1024 ** 3, 'task_memory_pressure')
    disk = os.statvfs('/mnt/data/docker')
    need(disk.f_blocks > 0 and disk.f_bavail / disk.f_blocks >= .15, 'task_disk_pressure')
    need(os.getloadavg()[0] <= (os.cpu_count() or 1), 'task_cpu_pressure')


@contextlib.contextmanager
def locked(read_only=False):
    s = STATE.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == UID and
         stat.S_IMODE(s.st_mode) == 0o700, 'unsafe_task_state')
    flags = os.O_RDONLY if read_only else os.O_RDWR | os.O_CREAT
    fd = os.open(STATE / 'coordinator.lock', flags | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        need(s.st_uid == UID and stat.S_ISREG(s.st_mode) and s.st_nlink == 1
             and stat.S_IMODE(s.st_mode) == 0o600, 'unsafe_task_lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('task_coordinator_busy') from None
        yield
    finally:
        os.close(fd)


def legacy_summary():
    # Read-only DB: never instantiate the legacy mutable Store for this check.
    read(LEGACY_DB, UID, 0o600)
    db = sqlite3.connect('file:' + str(LEGACY_DB) + '?mode=ro', uri=True, timeout=2)
    try:
        busy = db.execute("SELECT count(*) FROM jobs WHERE state IN "
                          "('dispatch_intent','outcome_unknown','accepted','inProgress')").fetchone()[0]
        count, latest = db.execute('SELECT count(*),max(created) FROM jobs '
                                  'WHERE attempts>0 AND created>?', (time.time()-86400,)).fetchone()
        return {'busy': busy, 'count': count, 'latest': latest}
    finally:
        db.close()


def legacy_idle(old, legacy):
    need(legacy_summary()['busy'] == 0, 'legacy_operation_requires_reconciliation')
    for thread in legacy['threads']:
        t = old.rpc({'mode': 'metadata', 'thread_id': thread}, legacy)
        need(t.get('status') in ('idle', 'notLoaded'), 'legacy_thread_busy')
    # Status is a point-in-time check. Other native clients are not globally
    # locked by this adapter; the review/acceptance must retain this limitation.


def admission(count, latest, p):
    need(p.get('enabled', True) is True, 'root_task_admission_disabled')
    need(not (STATE / 'revoked').exists(), 'task_admission_revoked')
    prior = legacy_summary()
    need(count + prior['count'] < p['max_sends_per_24h'], 'task_send_budget_exhausted')
    last = max(latest or 0, prior['latest'] or 0)
    need(time.time() - last >= p['minimum_spacing_seconds'], 'task_send_spacing')
    resources()


def rpc(q, legacy, old):
    if legacy.get('_observation_only'):
        need(q['mode'] in ('metadata_batch', 'observe'), 'expired_observation_only')
        need(legacy['boot_id'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
             'observation_peer_boot_unconfirmed')
    if q['mode'] in ('create_preflight', 'create', 'creation_probe', 'send_preflight', 'send'):
        fresh = old.plan()
        need(fresh['expires_at'] == legacy['expires_at'] and
             time.time() < fresh['expires_at'], 'task_admission_expired')
        current, _ = policy(old)
        need(current['enabled'] is True, 'root_task_admission_disabled')
        need(not (STATE / 'revoked').exists(), 'task_admission_revoked')
    old.peer(legacy)  # Same pinned Unix socket inode and SO_PEERCRED identity.
    p = subprocess.run(['/usr/bin/node', '--jitless', '--no-expose-wasm',
                        '--max-old-space-size=24', str(ROOT / 'task_rpc.cjs')],
                       input=json.dumps(q, ensure_ascii=False).encode(), capture_output=True, timeout=15,
                       env={'PATH': '/usr/bin:/bin', 'WS_NO_BUFFER_UTIL': '1',
                            'WS_NO_UTF_8_VALIDATE': '1'})
    need(len(p.stdout) <= 16384, 'task_response_limit')
    reply = json.loads(p.stdout)
    reason = reply.get('error') if reply.get('error') in ('thread_not_ready', 'thread_profile_changed', 'invalid_metadata_scope') else 'task_rpc_unconfirmed'
    need(p.returncode == 0 and reply.get('ok') is True, reason)
    return reply['result']


def store(p):
    path = STATE / 'jobs.sqlite3'
    if os.path.lexists(path):
        read(path, UID, 0o600, p['maximum_database_bytes'])
    else:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    db = Store(path)
    need(db.db.execute('PRAGMA page_size').fetchone()[0] == 4096, 'task_database_page_size')
    db.db.execute('PRAGMA max_page_count=256')  # One MiB, default 4096-byte pages.
    return db


def response(row):
    # API returns only registry metadata and already-sanitized final response.
    if row is None:
        return {'found': False, 'automatic_retry': False}
    result = dict(row)
    result.pop('input_hash', None)
    result['automatic_retry'] = False
    if isinstance(result.get('result'), str):
        result['result'] = json.loads(result['result'])
        result['result_hash'] = fingerprint(result['result'])
    return result


ADMIN_DELEGATION = {
    'enabled': True,
    'task_key_prefix': 'eva-admin-',
    'executor_uid': 1001,
    'dedicated_user': 'codex-house-01a16f9f',
    'dedicated_uid': 977,
    'expires_at': (1792941922 + 2443945 / 10000000),
    'authorization': 'eva-equal-administrative-delegation-20261025',
}


def bind_profile(q, db, p, payload=None):
    """Only sealed policy and the durable task identity select admin authority.

    A caller cannot submit an internal profile/configuration/thread override.
    Ordinary tasks keep the original restricted-profile check unchanged.
    """
    if q.get('mode') not in ('create_preflight', 'create', 'creation_probe',
                             'send_preflight', 'send'):
        return q
    task = None
    if q['mode'] in ('create_preflight', 'create'):
        task = payload if payload and 'task_key' in payload else None
    elif q.get('thread_id'):
        row = db.db.execute('SELECT task_key FROM tasks WHERE thread=?',
                            (q['thread_id'],)).fetchone()
        task = dict(row) if row else None
    if not task or not task['task_key'].startswith('eva-admin-'):
        return q
    need(p.get('admin_delegation') == ADMIN_DELEGATION,
         'admin_delegation_not_authorized')
    if q['mode'] != 'creation_probe':
        need(time.time() < ADMIN_DELEGATION['expires_at'], 'admin_delegation_expired')
    return {**q, 'profile': 'eva_admin'}


def handle(name, args, old):
    need(os.geteuid() == UID, 'task_identity_refused')
    validate(name, args)
    p, legacy = policy(old, observation=name in ('codex_task_status', 'codex_task_list',
                                                'codex_task_reconcile', 'codex_task_revoke'))
    admission_closed = bool(legacy.get('_observation_only') or not p['enabled'] or
                            (STATE / 'revoked').exists())
    with locked(read_only=name == 'codex_task_list'):
        if name == 'codex_task_list':
            import task_list
            # No Store constructor, DDL, receipt writes, resume or inference.
            return task_list.collect(args, __import__(__name__), lambda q: rpc(q, legacy, old),
                                     admission_closed=admission_closed)
        db = store(p)
        try:
            invoke = lambda q: rpc(bind_profile(q, db, p, args), legacy, old)
            idle = lambda: legacy_idle(old, legacy)
            payload = {k: v for k, v in args.items() if k != 'host'}
            if name == 'codex_task_revoke':
                if (STATE / 'revoked').exists():
                    read(STATE / 'revoked', UID, 0o600)
                    return {'revoked': True, 'receipts_preserved': True, 'duplicate': True}
                fd = os.open(STATE / 'revoked', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                os.fsync(fd)
                os.close(fd)
                parent = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
                db.audit('revocation', 'admission_revoked')
                return {'revoked': True, 'receipts_preserved': True}
            if name == 'codex_task_status':
                if args['kind'] == 'creation':
                    if admission_closed:
                        cached = db.row('tasks', args['operation_id'])
                        need(cached is not None, 'task_not_found')
                        previous = db.creation_result(args['operation_id'])
                        row = response({**cached, **({'result': json.dumps(previous)} if previous else {})})
                    else:
                        row = response(db.observe_creation(args['operation_id'], invoke))
                    thread = row.get('thread')
                    if thread:
                        try:
                            observation = invoke({'mode': 'metadata_batch', 'thread_ids': [thread]})['rows'][0]
                        except Exception:
                            observation = {'thread_id': thread, 'status': 'unknown',
                                           'collection_error': 'daemon_metadata_unconfirmed'}
                        row['current_thread_observation'] = observation
                        row['creation_identity_confirmed'] = observation.get('durable') is True and not observation.get('collection_error')
                    counts = db.db.execute("SELECT count(*),sum(state!='not_dispatched'),sum(turn IS NOT NULL) FROM sends WHERE task=?", (args['operation_id'],)).fetchone()
                    row['dispatch_evidence'] = {'attempt_receipts': counts[0],
                        'dispatch_intent_rows': counts[1] or 0, 'recorded_turns': counts[2] or 0}
                    row['send_admission'] = 'closed' if admission_closed or row.get('state') in ('cancelled_before_first_send','creation_lost_before_send') else 'fresh_preflight_required'
                    row['notLoaded_is_terminal'] = False
                    row['observation_without_admission'] = admission_closed
                    return row
                try:
                    row = response(db.observe(args['operation_id'], invoke))
                except Exception:
                    if not admission_closed:
                        raise
                    row = response(db.row('sends', args['operation_id']))
                    row['collection_error'] = 'live_observation_unavailable_cached_state_only'
                row['observation_without_admission'] = admission_closed
                return row
            if name == 'codex_task_reconcile':
                if not db.row('sends', args['operation_id']):
                    return db.reconcile_creation(args['operation_id'], args['result_hash'], invoke)
                return db.reconcile(args['operation_id'], args['result_hash'])
            if name == 'codex_task_create':
                # Existing duplicate is observed even if new admission is revoked.
                if not db.row('tasks', args['operation_id']):
                    count, latest = db.db.execute('SELECT count(*),max(created) FROM sends '
                        'WHERE created>?', (time.time()-86400,)).fetchone()
                    admission(count, latest, p)
                return response(db.create(payload, invoke, idle))
            return response(db.send(payload, invoke, lambda c, t: admission(c, t, p), idle))
        finally:
            db.close()




COORDINATOR_THREAD = '${AUTHORIZED_THREAD_ID_3}'
COORDINATOR_REPORT = Path('/home/gabriel/smart-home-proactive-review-20261023/evidence/coordinator-thread-summary-20261025.json')
COORDINATION_WORK = frozenset(('owner_thread_access', 'icloud_core_compatibility', 'offsite_integrity',
    'acceptance_capture', 'event_latency_observation', 'listener_recovery_guard', 'final_goal_audit'))
COORDINATION_COMPLETED = frozenset(('owner_thread_access', 'events_retained_pending_separation',
    'procmon_signal_io_unit_cpu', 'native_maintenance_recoveries', 'host_observer_MCP_metadata',
    'offsite_authenticated_copy', 'icloud_core_compatibility', 'listener_recovery_guard', 'acceptance_capture_correlation'))
COORDINATION_PENDING = frozenset(('owner_thread_access_publication', 'icloud_core_compatibility',
    'new_offsite_authentication', 'acceptance_capture_correlation', 'full_latency_scope', 'PC_off_and_24h',
    'scheduled_backup_handoff', 'service_restore_scope', 'event_delivery_sustained', 'portable_client_catalogue',
    'listener_recovery_guard'))
COORDINATION_COMPONENTS = frozenset(('thread_access_adapter', 'MCP_capabilities_projection',
    'MCP_source_provenance', 'icloud_adapter', 'native_update_compatibility_guard',
    'offsite_integrity_reader', 'acceptance_capture', 'host_observer', 'NodeRED_host_observer',
    'events_registry', 'events_projection', 'codex_recovery'))


def project_coordinator_checkpoint(value, now):
    """Allowlisted coordination report, not an execution receipt or authority."""
    import datetime
    base = {'source': 'sanitized_coordinator_scope_report', 'state': 'unknown',
        'collection_error': 'coordinator_report_unavailable_or_invalid',
        'observed_at': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(timespec='seconds'),
        'execution_receipt': False, 'goal_completion_verified': False,
        'administrative_authority_from_report': False}
    if not isinstance(value, dict):
        return base
    keys = {'schema_version', 'source', 'thread_id', 'observed_at', 'state', 'active_work', 'head',
        'completed', 'pending', 'reserved_components', 'events_delivery_opportunity',
        'execution_receipt', 'full_goal_complete'}
    def choices(name, allowed):
        row = value.get(name)
        return isinstance(row, list) and len(row) <= len(allowed) and all(isinstance(x, str) and x in allowed for x in row) and len(set(row)) == len(row)
    if (set(value) != keys or type(value.get('schema_version')) is not int or value.get('schema_version') != 1
            or value.get('source') != 'coordinator_scope_report' or value.get('thread_id') != COORDINATOR_THREAD
            or value.get('state') not in ('in_progress', 'waiting_natural_evidence', 'complete', 'blocked', 'paused')
            or not isinstance(value.get('active_work'), str) or value.get('active_work') not in COORDINATION_WORK
            or not isinstance(value.get('head'), str) or re.fullmatch('[a-f0-9]{40}', value['head']) is None
            or not choices('completed', COORDINATION_COMPLETED) or not choices('pending', COORDINATION_PENDING)
            or not choices('reserved_components', COORDINATION_COMPONENTS)
            or value.get('events_delivery_opportunity') not in ('candidate_not_implemented_by_coordinator', 'under_review', 'implemented', 'rejected', 'unknown')
            or value.get('execution_receipt') is not False or type(value.get('full_goal_complete')) is not bool):
        return base
    try:
        stamp = value['observed_at']
        if not isinstance(stamp, str) or len(stamp) > 40:
            return base
        date = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        if date.tzinfo is None:
            return base
        at = date.timestamp()
        if not 0 <= at <= now + 1:
            return base
    except (ValueError, TypeError, OverflowError):
        return base
    fresh = now - at <= 300
    base.update(state='observed' if fresh else 'unknown', collection_error=None if fresh else 'coordinator_report_stale',
        thread_id=COORDINATOR_THREAD, report_observed_at=stamp, age_seconds=round(max(0, now-at), 3),
        reported_state=value['state'], reported_active_work=value['active_work'],
        reported_head=value['head'], reported_completed=list(value['completed']),
        reported_pending=list(value['pending']), reported_reserved_components=list(value['reserved_components']),
        events_delivery_opportunity=value['events_delivery_opportunity'], scope_fresh=fresh,
        reported_goal_complete=value['full_goal_complete'],
        coverage=['coordinator_report_not_daemon_history', 'not_privileged_approval_or_execution_receipt',
            'stale_reservations_are_unknown_not_released', 'no_free_text_prompts_messages_logs_or_credentials'])
    return base


def coordinator_checkpoint():
    try:
        value = json.loads(read(COORDINATOR_REPORT, UID, 0o600, 16384))
    except (OSError, ValueError, TypeError):
        value = None
    result = project_coordinator_checkpoint(value, time.time())
    fingerprints = {}
    for role, path in (('events_registry', '/usr/local/lib/raspberry-mcp-events/registry.py'),
                       ('events_projection', '/usr/local/lib/raspberry-repair-control/event_projection.mjs')):
        try:
            fingerprints[role] = hashlib.sha256(read(Path(path), 0, 0o644, 1048576)).hexdigest()
        except (OSError, ValueError):
            fingerprints[role] = None
    result['installed_source_fingerprints'] = fingerprints
    return result

def project_reference_observations(references, reply, now):
    """Closed metadata projection. No message, prompt, title or turn item is read."""
    import datetime
    rows = reply.get('rows') if isinstance(reply, dict) else None
    valid = (isinstance(rows, list) and len(rows) == len(references)
             and all(isinstance(row, dict) and row.get('thread_id') in references for row in rows)
             and len({row['thread_id'] for row in rows}) == len(references))
    by_id = {row['thread_id']: row for row in rows} if valid else {}
    projected = []
    for identifier, alias in references.items():
        row = by_id.get(identifier, {})
        status = row.get('status')
        if status not in ('idle', 'active', 'notLoaded', 'systemError'):
            status = 'unknown'
        error = row.get('collection_error')
        if error is not None or not row or status == 'unknown':
            error = error if error in ('thread_not_loaded_metadata_unavailable', 'daemon_metadata_unconfirmed') else 'reference_metadata_unconfirmed'
        updated = row.get('updated_at')
        if not (type(updated) in (int, float) and 0 <= updated <= now + 5):
            updated = None
        ready = not error and status == 'idle' and row.get('can_accept_direct_input') is True
        projected.append({'thread_id': identifier, 'safe_title': alias,
            'origin': 'authorized_existing_reference', 'status': status,
            'last_activity_at': datetime.datetime.fromtimestamp(updated, datetime.timezone.utc).isoformat(timespec='seconds') if updated is not None else None,
            'can_receive_input': bool(ready),
            'adapter_send_admission': 'coordinator_observation_only' if alias == 'coordenacao_meta' else 'fresh_legacy_send_preflight_required',
            'serial_execution_gate': 'busy' if status == 'active' else 'fresh_send_preflight_required' if ready else 'not_ready_or_unknown',
            'durable_identity_observed': row.get('durable') if type(row.get('durable')) is bool else None,
            'collection_error': error, 'notLoaded_is_terminal': False,
            'open_link': None, 'link_reason': 'not_provided_or_validated_by_integration'})
    projected.sort(key=lambda row: (row['last_activity_at'] or '', row['thread_id']), reverse=True)
    return {'source': 'fixed_authorized_reference_metadata_from_existing_daemon',
        'observed_at': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(timespec='seconds'),
        'collection_error': 'partial_reference_metadata_unconfirmed' if any(row['collection_error'] for row in projected) else None,
        'threads': projected, 'coverage_partial': True,
        'coverage': ['fixed_existing_references_only', 'adapter_registry_available_through_codex_task_list',
            'no_raw_history_prompts_private_titles_logs_or_credentials', 'no_send_resume_or_inference'],
        'metadata_available_through_existing_tool': 'maintenance_capabilities',
        'direct_read_tool': 'codex_thread_read',
        'direct_read_requires_current_client_schema': True,
        'mutation_performed': False, 'assistant_dispatches': 0}


def reference_observations(old):
    import task_list
    _, legacy = policy(old, observation=True)
    with locked(read_only=True):
        try:
            reply = rpc({'mode': 'metadata_batch', 'thread_ids': list(task_list.REFERENCES)}, legacy, old)
        except Exception:
            reply = None
    result = project_reference_observations(task_list.REFERENCES, reply, time.time())
    result['coordination_checkpoint'] = coordinator_checkpoint()
    return result

def legacy_call(name, args, old, call):
    # ALL legacy adapter entrypoints share this lock after the broker overlay.
    # This avoids racing a legacy send against a dynamic send from another socket.
    p, legacy = policy(old)
    with locked():
        if name == 'codex_thread_send':
            prior = old.Store()
            try:
                duplicate = prior.get(args.get('operation_id')) is not None
            finally:
                prior.close()
            if not duplicate:
                db = store(p)
                try:
                    db.idle()
                    count, latest = db.db.execute('SELECT count(*),max(created) FROM sends '
                        'WHERE created>?', (time.time()-86400,)).fetchone()
                    admission(count, latest, p)
                finally:
                    db.close()
        result = call(name, args)
        if name in ('codex_thread_read', 'codex_thread_status') and args.get('thread_id') == COORDINATOR_THREAD and 'operation_id' not in args:
            result['coordination_checkpoint'] = coordinator_checkpoint()
        return result
