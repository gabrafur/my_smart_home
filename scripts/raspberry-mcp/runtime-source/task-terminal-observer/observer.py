"""Unactivated candidate: bounded metadata projection for registered sends.

The separate native adapter verifies the current sealed policy and peer.
The collector's 15 s unit budget leaves at most 2 s after its 12 s child;
this module limits each observation and never dispatches or mutates a ledger.
"""
import contextlib
import fcntl
import hashlib
import json
import math
import datetime
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

UID = 1001
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
DB = STATE / 'jobs.sqlite3'
LOCK = STATE / 'coordinator.lock'
OUTPUT = Path('/run/raspberry-mcp/task-terminal-observer/snapshot.json')
MAX_DB = 1048576
MAX_TERMINALS = 64
PENDING = ('send_intent', 'send_unknown', 'accepted', 'inProgress', 'outcome_unknown')
TERMINAL = ('completed', 'failed', 'interrupted', 'not_dispatched')
OP = re.compile(r'^[a-f0-9]{32}$')
UUID = re.compile(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')


def receipt(raw):
    def unique(rows):
        d={}
        for k,v in rows:
            if k in d:raise ValueError('duplicate_receipt_key')
            d[k]=v
        return d
    if len(raw.encode())>8192:raise ValueError('receipt_limit')
    return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite_receipt')))


def fingerprint(value):
    # Exactly task_store.fingerprint: default separators and ensure_ascii=False.
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _checked_file(path, owner, mode, max_bytes=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not (stat.S_ISREG(s.st_mode) and s.st_uid == owner and
                stat.S_IMODE(s.st_mode) == mode and s.st_nlink == 1 and
                (max_bytes is None or s.st_size <= max_bytes)):
            raise ValueError('unsafe_registered_file')
        return s
    finally:
        os.close(fd)


@contextlib.contextmanager
def _locked(lock, owner):
    _checked_file(lock, owner, 0o600)
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not (stat.S_ISREG(s.st_mode) and s.st_uid == owner and
                stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1):
            raise ValueError('unsafe_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def _rows(db, lock, owner, scope_started_at=0, clock=time.time):
    """Only fixed installed entrypoint may pass production paths; tests inject fixtures."""
    parent = db.parent.lstat()
    if not (stat.S_ISDIR(parent.st_mode) and parent.st_uid == owner and
            stat.S_IMODE(parent.st_mode) == 0o700):
        raise ValueError('unsafe_state_directory')
    with _locked(lock, owner):
        _checked_file(db, owner, 0o600, MAX_DB)
        if any(os.path.lexists(str(db) + suffix) for suffix in ('-wal', '-journal')):
            raise ValueError('database_journal_requires_reconciliation')
        conn = sqlite3.connect('file:' + str(db) + '?mode=ro&immutable=1', uri=True, timeout=0.1)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA query_only=ON')
            conn.execute('BEGIN')
            pending = conn.execute('''SELECT s.id,s.task,s.state,s.turn,s.updated,s.result,t.thread
                FROM sends s LEFT JOIN tasks t ON s.task=t.id
                WHERE (t.id IS NOT NULL OR s.task LIKE 'workspace:%')
                AND s.state IN (?,?,?,?,?) ORDER BY s.updated ASC,s.id ASC LIMIT 1''', PENDING).fetchall()
            terminal = conn.execute('''SELECT s.id,s.task,s.state,s.turn,s.updated,s.result,s.reconciled,t.thread
                FROM sends s LEFT JOIN tasks t ON s.task=t.id
                WHERE (t.id IS NOT NULL OR s.task LIKE 'workspace:%')
                AND s.state IN (?,?,?,?) AND (s.reconciled=0 OR (s.updated>=? AND s.updated>=?))
                ORDER BY s.updated ASC,s.id ASC LIMIT 65''', (*TERMINAL,scope_started_at,clock()-86400)).fetchall()
            def reference(row):
                value=dict(row)
                if isinstance(value.get('task'),str) and value['task'].startswith('workspace:'):
                    thread=value['task'][len('workspace:'):]
                    if not UUID.fullmatch(thread):raise ValueError('invalid_workspace_reference')
                    context=receipt(value['result']) if isinstance(value.get('result'),str) else None
                    if not(isinstance(context,dict) and context.get('route')=='workspace_thread_communication'
                            and context.get('target_thread_id')==thread
                            and context.get('profile_preserved') is True
                            and context.get('authority_changed') is False
                            and (context.get('assistant_acknowledged') is None or type(context.get('assistant_acknowledged')) is bool)):
                        raise ValueError('invalid_workspace_reference_receipt')
                    value['thread']=thread
                return value
            return [reference(x) for x in pending], [reference(x) for x in terminal]
        finally:
            conn.close()


def _valid_identity(row, pending=False):
    task=row.get('task') or ''
    workspace=isinstance(task,str) and task.startswith('workspace:')
    valid_task=(bool(UUID.fullmatch(task[len('workspace:'):])) and
                row.get('thread')==task[len('workspace:'):]) if workspace else bool(OP.fullmatch(task))
    return (bool(OP.fullmatch(row.get('id') or '')) and valid_task and
            (not pending or bool(UUID.fullmatch(row.get('thread') or ''))))


def collect(read_rows, policy_check, observe=None, *, now=time.time, monotonic=time.monotonic,
            budget_seconds=2.0, scope_started_at=0):
    """Metadata only. `observe` must prove an enforced upper bound, not merely claim one.

    The installed entrypoint supplies the sealed observe-only native adapter.
    Re-read under the same lock after any observation to detect ledger races.
    """
    if type(scope_started_at) is not int:
        raise ValueError('invalid_scope_started_at')
    start = monotonic()
    stamp = now()
    report = {'schema_version': 1, 'source': 'registered_task_terminal_observer_candidate',
              'observed_at': stamp, 'age_seconds': 0, 'state': 'unknown',
              'collection_error': None, 'coverage': ['registered_sends_only',
              'metadata_only', 'no_dispatch', 'no_ledger_mutation'],
              'pending': None, 'terminal_unreconciled': [], 'terminal_truncated': False}
    try:
        if not (0 < budget_seconds <= 2.0):
            raise ValueError('budget_unproven')
        # Required even for mock paths: an adapter must verify current policy and peer.
        if policy_check() is not True:
            raise ValueError('policy_or_peer_unconfirmed')
        pending, terminals = read_rows()
        report['terminal_truncated'] = len(terminals) > MAX_TERMINALS
        for row in terminals[:MAX_TERMINALS]:
            if not _valid_identity(row) or row.get('state') not in TERMINAL:
                raise ValueError('invalid_registered_terminal')
            value = receipt(row['result']) if isinstance(row.get('result'), str) else None
            if (not isinstance(value, dict) or value.get('operation_state') != row['state']
                    or (row.get('turn') is not None and value.get('turn_id') != row['turn'])
                    or not valid_time(row.get('updated'),stamp)
                    or (row['state']=='not_dispatched' and (row.get('turn') is not None or value.get('send_called') is not False or value.get('execution_proven') is not False))):
                raise ValueError('invalid_terminal_receipt')
            report['terminal_unreconciled'].append({'operation_id': row['id'], 'task_id': row['task'],
                'state': row['state'], 'updated_at': terminal_time(value,stamp), 'result_hash': fingerprint(value)})
        if pending:
            row = pending[0]
            if not _valid_identity(row, pending=True) or row.get('state') not in PENDING or not valid_time(row.get('updated'),stamp):
                raise ValueError('invalid_registered_pending')
            item = {'operation_id': row['id'], 'task_id': row['task'], 'state': 'unknown',
                    'ledger_state': row['state'], 'updated_at': row['updated'], 'result_hash': None}
            report['pending'] = item
            turn = row.get('turn')
            if not isinstance(turn, str) or not UUID.fullmatch(turn):
                report['collection_error'] = 'pending_turn_unavailable'
            elif observe is None or getattr(observe, 'enforced_timeout_seconds', None) is None:
                report['collection_error'] = 'bounded_observe_adapter_unavailable'
            elif observe.enforced_timeout_seconds <= 0 or monotonic() - start + observe.enforced_timeout_seconds >= budget_seconds:
                report['collection_error'] = 'observation_budget_unproven'
            else:
                result = observe({'mode': 'observe', 'thread_id': row['thread'], 'turn_id': turn,
                                  'operation_id': row['id']})
                if not isinstance(result, dict) or result.get('turn_id') != turn or result.get('operation_state') not in (*TERMINAL, 'inProgress', 'outcome_unknown'):
                    raise ValueError('observation_unconfirmed')
                again, _ = read_rows()
                if not again or any(again[0].get(k) != row.get(k) for k in ('id', 'task', 'state', 'turn', 'thread', 'updated')):
                    raise ValueError('registered_send_changed')
                item['state'] = result['operation_state']
                if result['operation_state'] in TERMINAL:
                    item['result_hash'] = fingerprint(result)
                    item['updated_at'] = terminal_time(result,stamp)
        if not valid_time(stamp,stamp) or not valid_time(scope_started_at,stamp) or monotonic() - start > budget_seconds:
            raise ValueError('observation_deadline_exceeded')
        if report['terminal_truncated']:
            report['collection_error'] = 'terminal_registry_truncated'
        report['state'] = 'observed' if report['collection_error'] is None else 'unknown'
    except (OSError, ValueError, sqlite3.Error, TypeError, KeyError, TimeoutError) as error:
        safe={'control_socket_changed','control_peer_changed','observer_boot_changed','legacy_policy_binding_changed',
              'sealed_source_scope_changed','sealed_source_digest_changed','sealed_dependency_digest_changed',
              'policy_changed_during_observation','unregistered_observation_refused','observation_deadline_exceeded',
              'database_journal_requires_reconciliation','unsafe_registered_file','unsafe_state_directory','unsafe_lock',
              'invalid_registered_terminal','invalid_terminal_receipt','registered_send_changed',
              'duplicate_receipt_key','nonfinite_receipt','observation_transport_unconfirmed','observation_transport_timeout'}
        reason='task_coordinator_busy' if isinstance(error,BlockingIOError) else str(error) if isinstance(error,(ValueError,TimeoutError)) and str(error) in safe else 'observation_unconfirmed'
        report.update(state='unknown', collection_error=reason, pending=None,
                      terminal_unreconciled=[], terminal_truncated=False)
    return public_snapshot(report,scope_started_at)


def valid_time(value,now):
    return type(value) in (int,float) and math.isfinite(value) and 0<=value<=now

def terminal_time(result,now):
    value=result.get('completed_at')
    if value is not None and not valid_time(value,now):raise ValueError('invalid_terminal_receipt')
    return value

def public_snapshot(report,scope_started_at):
    # Operation IDs are opaque receipt references already accepted by task_status.
    # Task/thread IDs, result bodies and prompts never cross this boundary.
    events=[]
    if report['state']=='observed':
        rows=list(report['terminal_unreconciled'])
        if report['pending'] and report['pending']['state'] in TERMINAL:rows.append(report['pending'])
        if len(rows)>MAX_TERMINALS:
            report['state']='unknown';report['collection_error']='terminal_registry_truncated'
        else:
            for row in rows:
                operation=row['operation_id'];events.append({
                    'topic':'task_terminal','source':'registered_task_status','phase':'terminal',
                    'object_id':hashlib.sha256(('task-terminal-operation-v1:'+operation).encode()).hexdigest(),
                    'operation_id':operation,'revision':row['result_hash'],'terminal_state':row['state'],
                    'observed_at':int(report['observed_at']),'result_updated_at':row['updated_at']})
    return {'schema_version':1,'source':'registered_task_terminal_observer_v1',
        'observed_at':datetime.datetime.fromtimestamp(report['observed_at'],datetime.timezone.utc).isoformat(),
        'scope_started_at':scope_started_at,'state':report['state'],'collection_error':report['collection_error'],
        'events':events if report['state']=='observed' else [],
        'coverage':['registered_sends_only','one_pending_RPC_per_sample','no_dispatch','no_task_ledger_mutation',
            'reconciled_terminals_retained_24h_after_observer_scope_start','no_delivery_or_functional_recovery_proof']}


def production_rows(scope_started_at=0):
    if os.geteuid() != UID:
        raise ValueError('task_identity_refused')
    return _rows(DB, LOCK, UID,scope_started_at)

# Deliberately no CLI, transport, output writer, scheduler, or service hook.
# A fixed-output writer must be separately reviewed with /run ownership, atomic
# replace, mode 0640, symlink/race checks, freshness and full unit-budget proof.


def publish_snapshot(report):
    """Fixed path only; caller must prove cadence, budget and install authority."""
    if os.geteuid() != UID or os.getegid() != 985 or not isinstance(report, dict):
        raise ValueError('snapshot_identity_refused')
    allowed = {'schema_version','source','observed_at','scope_started_at','state','collection_error','coverage','events'}
    if set(report) != allowed:
        raise ValueError('snapshot_schema_refused')
    payload = json.dumps(report, ensure_ascii=False, sort_keys=True).encode()
    if len(payload) > 65536:
        raise ValueError('snapshot_too_large')
    parent = os.open(OUTPUT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.task-terminal-observer.' + str(os.getpid()) + '.tmp'
    try:
        st = os.fstat(parent)
        if st.st_uid != UID or st.st_gid != 985 or stat.S_IMODE(st.st_mode) != 0o750:
            raise ValueError('snapshot_directory_unsafe')
        try:
            old = os.stat(OUTPUT.name, dir_fd=parent, follow_symlinks=False)
            if not (stat.S_ISREG(old.st_mode) and old.st_uid == UID and
                    stat.S_IMODE(old.st_mode) == 0o640 and old.st_nlink == 1):
                raise ValueError('snapshot_target_unsafe')
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o640, dir_fd=parent)
        try:
            os.fchmod(fd, 0o640)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=parent)
            except OSError:
                pass
            raise
        os.replace(temporary, OUTPUT.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)
