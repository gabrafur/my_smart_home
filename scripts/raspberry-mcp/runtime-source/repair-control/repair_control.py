"""Typed fixed-task gateway. No caller prompt, thread, path, command or permissions."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time

from repair_store import Store, TASK, THREAD, TERMINAL, need, validate, digest

ROOT = Path('/usr/local/lib/raspberry-repair-control')
POLICY = ROOT / 'policy.json'
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
RECEIPTS = Path('/home/gabriel/smart-home-proactive-review-20261023/evidence')
EXPIRY = (1792941922 + 2443945 / 10000000)
NAMES = ('submit', 'status', 'result', 'reconcile', 'revoke', 'capabilities')
TOOLS = tuple('codex_repair_' + x for x in NAMES)
FIELDS = {
 'codex_repair_submit': ('operation_id', 'task'),
 'codex_repair_status': ('operation_id',), 'codex_repair_result': ('operation_id',),
 'codex_repair_reconcile': ('operation_id', 'result_hash'),
 'codex_repair_revoke': (), 'codex_repair_capabilities': (),
}


def configuration(tasks):
    policy = json.loads(tasks.read(POLICY, 0, 0o644))
    need(set(policy) == {'enabled', 'expires_at', 'thread', 'tasks', 'source_hashes',
                         'dependencies', 'maximum_submissions'}, 'repair_policy_changed')
    need(type(policy['enabled']) is bool and policy['expires_at'] == EXPIRY and
         policy['thread'] == THREAD and policy['tasks'] == [TASK] and
         policy['maximum_submissions'] == 2, 'repair_policy_changed')
    need(set(policy['source_hashes']) == {'repair_control.py', 'repair_store.py',
         'repair_rpc.cjs', 'health_summary.py', 'repair-broker.py',
         'verify_candidate.py', 'test_health_summary.py', 'test_repair_store.py',
         'test_repair_control.py', 'test_events.mjs', 'event_projection.mjs'},
         'repair_source_scope_changed')
    for name, h in policy['source_hashes'].items():
        need(hashlib.sha256(tasks.read(ROOT/name, 0, 0o644)).hexdigest() == h,
             'repair_source_changed')
    for path, h in policy['dependencies'].items():
        need(hashlib.sha256(tasks.read(Path(path), 0, 0o644)).hexdigest() == h,
             'repair_dependency_changed')
    return policy


def revoked(tasks):
    flag = STATE / 'repair.revoked'
    if not os.path.lexists(flag):
        return False
    tasks.read(flag, 1001, 0o600, 64)
    return True


def invoke(q, old, legacy):
    old.peer(legacy)
    result = subprocess.run(['/usr/bin/node', '--jitless', '--no-expose-wasm',
        '--max-old-space-size=24', str(ROOT/'repair_rpc.cjs')],
        input=json.dumps(q).encode(), capture_output=True, timeout=15,
        env={'PATH': '/usr/bin:/bin', 'WS_NO_BUFFER_UTIL': '1', 'WS_NO_UTF_8_VALIDATE': '1'})
    need(result.returncode == 0 and len(result.stdout) <= 16384, 'repair_rpc_unconfirmed')
    reply = json.loads(result.stdout)
    need(reply.get('ok') is True, 'repair_rpc_unconfirmed')
    return reply['result']


def publish_receipt(op, result):
    """Immutable central evidence; no rewrite of the shared checkpoint JSON."""
    raw = (json.dumps({'operation_id': op, 'task': TASK, 'thread_id': THREAD,
                       'result': result, 'result_hash': digest(result)},
                      sort_keys=True, separators=(',', ':'))+'\n').encode()
    need(len(raw) <= 16384, 'repair_receipt_limit')
    directory = os.open('/', os.O_PATH|os.O_DIRECTORY)
    try:
        for part in RECEIPTS.parts[1:]:
            nxt = os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory);directory = nxt
        info = os.fstat(directory)
        need(info.st_uid == 1001 and not info.st_mode & 0o002, 'unsafe_central_evidence_directory')
        name = 'eva-health-summary-'+op+'.json'
        try:
            fd = os.open(name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=directory)
        except FileExistsError:
            fd = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=directory)
            try:
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_uid == 1001 and info.st_nlink == 1
                     and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 16384,
                     'unsafe_central_evidence_file')
                need(os.read(fd, 16385) == raw, 'central_repair_receipt_conflict')
            finally:os.close(fd)
        else:
            try:
                with os.fdopen(os.dup(fd), 'wb') as stream:
                    stream.write(raw);stream.flush();os.fsync(stream.fileno())
            finally:os.close(fd)
            os.fsync(directory)
        return 'evidence/'+name
    finally:os.close(directory)


def handle(name, args, old, tasks):
    validate(name, args)
    need(os.geteuid() == 1001, 'repair_identity_refused')
    p = configuration(tasks)
    with tasks.locked():
        stopped = revoked(tasks)
        if name == 'codex_repair_revoke':
            if not stopped:
                fd = os.open(STATE/'repair.revoked', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
                try:
                    os.write(fd, b'revoked\n'); os.fsync(fd)
                finally:
                    os.close(fd)
                parent = os.open(STATE, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try: os.fsync(parent)
                finally: os.close(parent)
            return {'revoked': True, 'duplicate': stopped, 'running_turn_cancelled': False,
                    'scope': 'new_fixed_repair_submissions_only', 'receipts_preserved': True}
        if name == 'codex_repair_capabilities':
            try:
                tasks.policy(old)
                temporal = time.time() < EXPIRY
            except (ValueError, OSError):
                temporal = False
            return {'catalog': [TASK], 'thread_id': THREAD, 'enabled': p['enabled'] and temporal and not stopped,
                    'expires_at': EXPIRY, 'maximum_submissions': 2, 'automatic_retry': False,
                    'scope': 'fixed_task_and_readonly_health_projection;not_general_root_or_filesystem_confinement',
                    'new_task_policy': 'root_review_and_existing_standing_goal_authorization'}
        # Reuse the existing durable ledger: dynamic/legacy admission already
        # checks its busy states. Refuse oversized DB before its schema migration.
        tasks.read(tasks.LEGACY_DB, 1001, 0o600, 1048576)
        legacy_store = old.Store()
        try:
            legacy_store.db.execute('PRAGMA max_page_count=256')
            need(legacy_store.db.execute('PRAGMA page_size').fetchone()[0] == 4096,
                 'repair_database_page_size')
            receipt = Store(legacy_store.db)
            op = args['operation_id']
            known = receipt.get(op)
            was_known = known is not None
            job = legacy_store.get(op)
            need(job is None or (job['intent'] == TASK and job['thread'] == THREAD
                                 and known is not None), 'repair_operation_id_conflict')
            if name == 'codex_repair_reconcile':
                need(known is not None and known['result'] is not None,
                     'repair_result_not_terminal')
                publish_receipt(op, known['result'])
                return receipt.reconcile(op, args['result_hash'])
            if name == 'codex_repair_submit' and known is None:
                need(p['enabled'] and not stopped and time.time() < EXPIRY, 'repair_admission_closed')
                tp, legacy = tasks.policy(old)
                dynamic = tasks.store(tp)
                try:
                    dynamic.idle()
                    count, latest = dynamic.db.execute('SELECT count(*),max(created) FROM sends '
                        'WHERE created>?', (time.time()-86400,)).fetchone()
                    tasks.admission(count, latest, tp)
                finally:
                    dynamic.close()
                need(legacy_store.db.execute('SELECT count(*) FROM repair_receipts').fetchone()[0]
                     < p['maximum_submissions'], 'repair_submission_budget_exhausted')
                # Registry commit precedes any daemon RPC. A duplicate never
                # reaches send again, even if the first process died here.
                tasks.legacy_idle(old, legacy)
                receipt.reserve(op)
                try:
                    legacy_store.send({'operation_id': op, 'thread_id': THREAD, 'intent': TASK},
                                      legacy, lambda q, _: invoke(q, old, legacy))
                except Exception:
                    if legacy_store.get(op) is None:
                        receipt.terminal(op, {'operation_state': 'failed',
                            'outcome': 'preflight_refused_no_send', 'automatic_retry': False})
                    else:
                        raise
                known = receipt.get(op)
                job = legacy_store.get(op)
            need(known is not None, 'repair_operation_not_found')
            duplicate = name == 'codex_repair_submit' and was_known
            if job is None and known['result'] is None:
                # Legacy implementation commits dispatch intent before send.
                # No legacy row proves no send occurred; release still needs ack.
                receipt.terminal(op, {'operation_state': 'failed',
                    'outcome': 'reserved_without_dispatch', 'automatic_retry': False})
            if name in ('codex_repair_status', 'codex_repair_result') and job and job['turn'] and job['state'] in ('accepted', 'inProgress'):
                try:
                    _, legacy = tasks.policy(old)
                    legacy_store.observe({'operation_id': op, 'thread_id': THREAD}, legacy,
                                         lambda q, _: invoke(q, old, legacy))
                except Exception:
                    # Observation failure does not erase the accepted handle,
                    # complete a job, or authorize restarting it.
                    return {'operation_id': op, 'task': TASK, 'state': job['state'],
                        'turn_id': job['turn'], 'observation': 'unavailable_or_admission_expired',
                        'automatic_retry': False, 'execution_replay_allowed': False}
                job = legacy_store.get(op)
            if job and job['state'] in TERMINAL and job['result']:
                receipt.terminal(op, json.loads(job['result']))
            known = receipt.get(op)
            value = {'operation_id': op, 'task': TASK, 'thread_id': THREAD,
                'state': job['state'] if job else 'failed', 'turn_id': job['turn'] if job else None,
                'result_hash': known['result_hash'], 'reconciled': bool(known['ack']),
                'automatic_retry': False, 'execution_replay_allowed': False}
            if name == 'codex_repair_submit':
                value['duplicate'] = duplicate
            if known['result'] is not None:
                value['central_receipt'] = publish_receipt(op, known['result'])
                value['centrally_recorded'] = True
            if name == 'codex_repair_result':
                value['result'] = known['result']
            return value
        finally:
            legacy_store.close()
