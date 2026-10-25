"""Fixed unprivileged task admission for the existing private Codex daemon.

Installed code/policy must be root owned. No root RPC, arbitrary path/command,
credentials, policy overrides or subscription mutation are exposed here.
"""
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import time

from task_store import Store, BUSY, need, fingerprint
from thread_catalog import catalog

ROOT = Path('/usr/local/lib/raspberry-task-control')
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
POLICY = ROOT / 'policy.json'
LEGACY_POLICY = Path('/usr/local/lib/raspberry-mcp/codex-control-approval.json')
LEGACY_DB = Path('/var/lib/raspberry-mcp-operations/codex-control/jobs.sqlite3')
UID = 1001
TOOLS = ('codex_task_create', 'codex_task_send', 'codex_task_status',
         'codex_task_reconcile', 'codex_task_revoke', 'codex_threads_list')
FIELDS = {
    'codex_threads_list': ('limit', 'cursor'),
    'codex_task_create': ('operation_id', 'task_key', 'objective', 'acceptance'),
    'codex_task_send': ('operation_id', 'task_id', 'text'),
    'codex_task_status': ('operation_id', 'kind'),
    'codex_task_reconcile': ('operation_id', 'result_hash'),
    'codex_task_revoke': (),
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


def policy(old):
    legacy = old.plan()  # Existing boot, wall-clock and monotonic lease gates.
    p = json.loads(read(POLICY, 0, 0o644))
    need(isinstance(p.get('enabled'), bool) and
         p.get('legacy_policy_sha256') == hashlib.sha256(read(LEGACY_POLICY, 0, 0o644)).hexdigest()
         and p.get('expires_at') == legacy['expires_at'] and
         p.get('boot_id') == legacy['boot_id'], 'task_admission_changed')
    need(p.get('max_sends_per_24h') == 48 and p.get('minimum_spacing_seconds') == 60
         and p.get('maximum_database_bytes') == 1048576, 'task_limits_changed')
    need(set(p.get('source_hashes', {})) == {
        'task_control.py', 'task_store.py', 'task_rpc.cjs', 'task-broker.py', 'thread_catalog.py'},
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
    if name == 'codex_threads_list':
        need(type(args['limit']) is int and 1 <= args['limit'] <= 50, 'invalid_thread_limit')
        need(args['cursor'] is None or isinstance(args['cursor'], str) and
             len(args['cursor']) <= 512, 'invalid_thread_cursor')
    if name == 'codex_task_status':
        need(args['kind'] in ('creation', 'turn'), 'invalid_task_kind')


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
def locked():
    s = STATE.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == UID and
         stat.S_IMODE(s.st_mode) == 0o700, 'unsafe_task_state')
    fd = os.open(STATE / 'coordinator.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
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
    if q['mode'] in ('create', 'send'):
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
    need(p.returncode == 0 and reply.get('ok') is True, 'task_rpc_unconfirmed')
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


def readonly_rows(path, query):
    read(path, UID, 0o600)
    db = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        return [dict(row) for row in db.execute(query)]
    finally:
        db.close()


def registry_entries(legacy):
    # Exact SELECTs do not load task text, answer bodies, input hashes or logs.
    tasks = readonly_rows(STATE / 'jobs.sqlite3',
        'SELECT id,thread,state,created FROM tasks WHERE thread IS NOT NULL') if os.path.lexists(STATE / 'jobs.sqlite3') else []
    sends = readonly_rows(STATE / 'jobs.sqlite3',
        'SELECT id,task,state,turn,created FROM sends ORDER BY created DESC,id ASC') if tasks else []
    prior = readonly_rows(LEGACY_DB,
        'SELECT id,thread,state,turn,created FROM jobs ORDER BY created DESC,id ASC') if os.path.lexists(LEGACY_DB) else []
    entries = []
    for thread in legacy['threads']:
        ops = [r for r in prior if r['thread'] == thread]
        op = ops[0] if ops else None
        entries.append({'thread_id': thread, 'origin': 'legacy_authorized',
            'task_id': None, 'operation_id': op['id'] if op else None,
            'operation_state': op['state'] if op else 'no_adapter_send',
            'created_at': None})
    for task in tasks:
        ops = [r for r in sends if r['task'] == task['id']]
        op = ops[0] if ops else None
        entries.append({'thread_id': task['thread'], 'origin': 'adapter',
            'task_id': task['id'], 'operation_id': op['id'] if op else None,
            'operation_state': op['state'] if op else 'not_sent',
            'creation_state': task['state'], 'created_at': task['created']})
    need(len(entries) <= 256 and len({e['thread_id'] for e in entries}) == len(entries),
         'thread_catalog_scope_unconfirmed')
    for entry in entries:
        need(isinstance(entry['thread_id'], str) and
             re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', entry['thread_id']),
             'thread_catalog_identity_unconfirmed')
        for field in ('task_id', 'operation_id'):
            need(entry[field] is None or isinstance(entry[field], str) and
                 re.fullmatch('[a-f0-9]{32}', entry[field]), 'thread_catalog_operation_unconfirmed')
        need(entry['created_at'] is None or type(entry['created_at']) in (int, float) and
             math.isfinite(entry['created_at']) and entry['created_at'] >= 0,
             'thread_catalog_time_unconfirmed')
        for field in ('operation_state', 'creation_state'):
            if field in entry and entry[field] not in (*BUSY, 'created', 'creation_lost_before_send',
                    'dispatch_intent', 'completed', 'failed', 'interrupted', 'not_sent', 'no_adapter_send'):
                entry[field] = 'unknown'
    return entries


def list_threads(args, p, legacy, old):
    try:
        entries = registry_entries(legacy)
    except Exception:
        return {**catalog([], lambda q: None, args['limit'], None),
                'collection_error': 'registry_collection_failed',
                'authorized_count': None, 'coverage': 'scope_collection_unavailable'}
    return catalog(entries, lambda q: rpc(q, legacy, old), args['limit'], args['cursor'])


def handle(name, args, old):
    need(os.geteuid() == UID, 'task_identity_refused')
    validate(name, args)
    p, legacy = policy(old)
    if name == 'codex_threads_list':
        return list_threads(args, p, legacy, old)
    with locked():
        db = store(p)
        try:
            invoke = lambda q: rpc(q, legacy, old)
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
                    return response(db.observe_creation(args['operation_id'], invoke))
                return response(db.observe(args['operation_id'], invoke))
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
        return call(name, args)
