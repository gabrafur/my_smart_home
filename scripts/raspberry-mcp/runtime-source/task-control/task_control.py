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
import socket
import sqlite3
import stat
import struct
import subprocess
import time

from task_store import Store, BUSY, need, fingerprint

ROOT = Path('/usr/local/lib/raspberry-task-control')
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
POLICY = ROOT / 'policy.json'
V2_POLICY = ROOT / 'task-policy-v2.json'
V2_PEER = ROOT / 'task-peer-v2.json'
V2_MARKER = ROOT / 'task-v2-admitted.marker'
V2_MARKER_BYTES = b'raspberry-task-v2-admitted\n'
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


def legacy_boundary_v2(old):
    """Verify the old code and scope without borrowing its finite lease."""
    legacy = json.loads(read(LEGACY_POLICY, 0, 0o644))
    need(legacy.get('threads') == list(old.THREADS) and
         legacy.get('project') == '/mnt/data/docker' and
         legacy.get('max_sends') == 6 and
         legacy.get('allow_send') is False and
         set(legacy.get('source_hashes', {})) ==
         {'codex_control.py', 'codex_control_rpc.cjs'},
         'task_v2_legacy_boundary_changed')
    for name, digest in legacy['source_hashes'].items():
        need(hashlib.sha256(read(old.ROOT / name, 0, 0o644)).hexdigest() == digest,
             'task_v2_legacy_source_changed')
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
    need(type(p.get('workspace_thread_communication', False)) is bool,
         'workspace_communication_policy_invalid')
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


BROAD_OWNER_SHA256='${EVA_BROAD_OWNER_APPROVAL_SHA256}'
def broad_grant(p,active=False):
    value=p.get('broad_task_profile')
    if value is None:return None
    fields={'schema','enabled','revoked','lease_kind','scope','owner_approval_sha256','profile','mandatory_interface_confirmations','preserve_existing_ids','exclude_legacy_admin','exclude_unregistered_references'}
    need(type(value)is dict and set(value)==fields and value['schema']=='eva_broad_task_profile_v1'
         and value['lease_kind']=='persistent_revocable'and value['scope']=='registered_tasks_in_eva_project'
         and value['owner_approval_sha256']==BROAD_OWNER_SHA256
         and type(value['enabled'])is bool and type(value['revoked'])is bool
         and value['profile']=={'sandbox':'danger-full-access','approvalPolicy':'on-request','approvalsReviewer':'user','cwd':'/mnt/data/docker'}
         and all(value[k]is True for k in ('mandatory_interface_confirmations','preserve_existing_ids','exclude_legacy_admin','exclude_unregistered_references')),
         'broad_task_profile_scope_changed')
    if active:need(value['enabled']and not value['revoked'],'broad_task_profile_revoked')
    return value


def task_policy(old, observation=False):
    """Select the independent Root-sealed task grant if explicitly installed.

    The legacy policy remains pinned for its own interface, but its finite
    lease cannot become the clock for this new grant. An invalid v2 file
    never falls back to the old route.
    """
    if not os.path.lexists(V2_POLICY):
        need(not os.path.lexists(V2_MARKER),
             'task_v2_policy_missing_after_admission')
        return policy(old, observation)
    need(os.path.lexists(V2_MARKER) and
         read(V2_MARKER, 0, 0o644, 64) == V2_MARKER_BYTES,
         'task_v2_admission_marker_changed')
    raw = read(V2_POLICY, 0, 0o644)
    p = json.loads(raw)
    need(p.get('schema') == 'raspberry-task-policy-v2' and
         type(p.get('enabled')) is bool and
         p.get('lease_kind') == 'persistent_revocable' and
         p.get('expires_at', 'missing') is None and
         isinstance(p.get('owner_approval_sha256'), str) and
         re.fullmatch('[a-f0-9]{64}', p['owner_approval_sha256']) and
         p['owner_approval_sha256'] != '0' * 64 and
         p.get('project') == '/mnt/data/docker' and
         p.get('profile') == 'restricted' and
         p.get('admin_delegation') == {'enabled': False} and
         p.get('workspace_thread_communication') is True and
         p.get('max_sends_per_24h') == 48 and
         p.get('minimum_spacing_seconds') == 60 and
         p.get('maximum_database_bytes') == 1048576 and
         p.get('legacy_policy_sha256') == hashlib.sha256(read(LEGACY_POLICY, 0, 0o644)).hexdigest(),
         'task_v2_scope_changed')
    broad_grant(p)
    need(set(p.get('source_hashes', {})) ==
         {'task_control.py', 'task_store.py', 'task_rpc.cjs', 'task-broker.py', 'task_list.py'},
         'task_v2_code_scope_changed')
    for name, digest in p['source_hashes'].items():
        need(hashlib.sha256(read(ROOT / name, 0, 0o644)).hexdigest() == digest,
             'task_v2_source_changed')
    need(isinstance(p.get('dependencies'), dict) and p['dependencies'],
         'task_v2_dependencies_missing')
    for path, digest in p['dependencies'].items():
        need(isinstance(path, str) and path.startswith('/') and
             hashlib.sha256(read(Path(path), 0, 0o644)).hexdigest() == digest,
             'task_v2_dependency_changed')
    legacy = legacy_boundary_v2(old)
    need(legacy.get('project') == p['project'] and
         legacy.get('allow_send') is False,
         'task_v2_legacy_boundary_changed')
    try:
        proof = json.loads(read(V2_PEER, 0, 0o644))
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        need(proof.get('schema') == 'raspberry-task-peer-v2' and
             proof.get('policy_sha256') == hashlib.sha256(raw).hexdigest() and
             proof.get('boot_id') == boot and
             type(proof.get('peer_pid')) is int and proof['peer_pid'] > 1 and
             isinstance(proof.get('socket_identity'), list) and
             len(proof['socket_identity']) == 2 and
             all(type(x) is int and x > 0 for x in proof['socket_identity']),
             'task_v2_peer_proof_changed')
    except (OSError, ValueError, TypeError, KeyError):
        if not observation:
            raise
        return p, {**legacy, '_v2': True, '_v2_peer_unconfirmed': True}
    # The peer proof is Root-owned and bound to the current boot, socket inode
    # and SO_PEERCRED PID. A new boot/socket requires a fresh Root proof.
    legacy = {**legacy, '_v2': True, 'boot_id': boot,
              'socket_identity': proof['socket_identity'],
              'peer_pid': proof['peer_pid']}
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
        if legacy.get('_v2'):
            t = rpc({'mode': 'metadata_batch', 'thread_ids': [thread]}, legacy, old)['rows'][0]
        else:
            t = old.rpc({'mode': 'metadata', 'thread_id': thread}, legacy)
        need(t.get('status') in ('idle', 'notLoaded'), 'legacy_thread_busy')
    # Status is a point-in-time check. Other native clients are not globally
    # locked by this adapter; the review/acceptance must retain this limitation.


def dispatch_idle(old, legacy):
    """Serialize old receipts without retaining the historical thread gate.

    After v2 admission the legacy sender is permanently closed by
    legacy_boundary_v2().  Its durable database must still have no unresolved
    dispatch, but availability of the three historical thread references no
    longer controls creation or workspace communication.
    """
    if legacy.get('_v2'):
        need(legacy_summary()['busy'] == 0,
             'legacy_operation_requires_reconciliation')
        return
    legacy_idle(old, legacy)


def admission(count, latest, p):
    need(p.get('enabled', True) is True, 'root_task_admission_disabled')
    need(not (STATE / 'revoked').exists(), 'task_admission_revoked')
    prior = legacy_summary()
    need(count + prior['count'] < p['max_sends_per_24h'], 'task_send_budget_exhausted')
    last = max(latest or 0, prior['latest'] or 0)
    need(time.time() - last >= p['minimum_spacing_seconds'], 'task_send_spacing')
    resources()


@contextlib.contextmanager
def pinned_peer_connection(legacy, old):
    """Keep the exact SO_PEERCRED-verified connection for Node's WebSocket."""
    path = old.SOCKET
    before = os.stat(path, follow_symlinks=False)
    need(stat.S_ISSOCK(before.st_mode) and before.st_uid == UID and
         stat.S_IMODE(before.st_mode) == 0o600 and
         [before.st_dev, before.st_ino] == legacy['socket_identity'],
         'task_peer_socket_changed')
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(path)
        pid, uid, gid = struct.unpack('3i', connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        after = os.stat(path, follow_symlinks=False)
        need((before.st_dev, before.st_ino, before.st_uid, before.st_mode) ==
             (after.st_dev, after.st_ino, after.st_uid, after.st_mode) and
             pid == legacy['peer_pid'] and uid == UID,
             'task_peer_identity_changed')
        connection.settimeout(None)
        yield connection


def rpc(q, legacy, old):
    need(not legacy.get('_v2_peer_unconfirmed'), 'task_v2_peer_unconfirmed')
    if legacy.get('_observation_only') and not legacy.get('_v2'):
        need(q['mode'] in ('metadata_batch', 'observe', 'workspace_message_observe'), 'expired_observation_only')
        need(legacy['boot_id'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
             'observation_peer_boot_unconfirmed')
    if q['mode'] in ('create_preflight', 'create', 'creation_probe', 'send_preflight', 'send',
                      'workspace_message_preflight', 'workspace_message'):
        if not legacy.get('_v2'):
            fresh = old.plan()
            need(fresh['expires_at'] == legacy['expires_at'] and
                 time.time() < fresh['expires_at'], 'task_admission_expired')
        current, current_peer = task_policy(old)
        need(current_peer.get('_v2') == legacy.get('_v2') and
             current_peer.get('socket_identity') == legacy.get('socket_identity') and
             current_peer.get('peer_pid') == legacy.get('peer_pid'),
             'task_admission_changed')
        need(current['enabled'] is True, 'root_task_admission_disabled')
        if q.get('profile')=='eva_broad':broad_grant(current,active=True)
        need(not (STATE / 'revoked').exists(), 'task_admission_revoked')
        if q['mode'] in ('workspace_message_preflight', 'workspace_message'):
            need(current.get('workspace_thread_communication') is True,
                 'workspace_communication_not_approved')
    peer_context = (pinned_peer_connection(legacy, old) if legacy.get('_v2')
                    else contextlib.nullcontext(None))
    with peer_context as peer:
        if peer is None:
            old.peer(legacy)
        env = {'PATH': '/usr/bin:/bin', 'WS_NO_BUFFER_UTIL': '1',
               'WS_NO_UTF_8_VALIDATE': '1'}
        kwargs = {'input': json.dumps(q, ensure_ascii=False).encode(),
                  'capture_output': True, 'timeout': 15, 'env': env}
        if peer is not None:
            env['TASK_PEER_FD'] = str(peer.fileno())
            kwargs['pass_fds'] = (peer.fileno(),)
        p = subprocess.run(['/usr/bin/node', '--jitless', '--no-expose-wasm',
                            '--max-old-space-size=24', str(ROOT / 'task_rpc.cjs')],
                           **kwargs)
    need(len(p.stdout) <= 16384, 'task_response_limit')
    reply = json.loads(p.stdout)
    reason = reply.get('error') if reply.get('error') in (
        'thread_not_ready', 'thread_profile_changed', 'project_binding_unconfirmed',
        'creation_project_unconfirmed', 'invalid_metadata_scope',
        'workspace_thread_not_loaded', 'workspace_thread_metadata_unconfirmed',
        'workspace_thread_out_of_project', 'workspace_provider_unconfirmed', 'workspace_thread_not_ready',
        'workspace_active_turn_unconfirmed', 'workspace_thread_state_changed') else 'task_rpc_unconfirmed'
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
    'dedicated_user': '${ADMIN_DELEGATE_USER}',
    'dedicated_uid': int('${ADMIN_DELEGATE_UID}'),
    'expires_at': float('${ADMIN_DELEGATION_EXPIRES_AT}'),
    'authorization': '${ADMIN_DELEGATION_AUTHORIZATION}',
}


def bind_profile(q, db, p, payload=None):
    """Only sealed policy and the durable task identity select admin authority.

    A caller cannot submit an internal profile/configuration/thread override.
    Ordinary tasks keep the original restricted-profile check unchanged.
    """
    if q.get('mode') not in ('create_preflight', 'create', 'creation_probe',
                             'send_preflight', 'send','workspace_message_preflight','workspace_message'):
        return q
    task = None
    if q['mode'] in ('create_preflight', 'create'):
        task = payload if payload and 'task_key' in payload else None
    elif q.get('thread_id'):
        row = db.db.execute('SELECT task_key FROM tasks WHERE thread=?',
                            (q['thread_id'],)).fetchone()
        task = dict(row) if row else None
    if not task:
        return q
    if not task['task_key'].startswith(('eva-admin-','workspace:')) and broad_grant(p) is not None:
        grant=broad_grant(p,active=True)
        if q['mode']in ('workspace_message_preflight','workspace_message'):
            # Existing references acquire no grant. Only an independently
            # registered task row can reach this branch, regardless RPC origin.
            rows=db.db.execute("SELECT *FROM profile_transitions WHERE thread=?AND grant_sha256=?AND mode='send'ORDER BY updated DESC LIMIT 1",(q['thread_id'],fingerprint(grant))).fetchall()
            proof=None
            if rows:
                record=dict(rows[0])
                if record['state']=='archived':record=db.history_profile(record['id'])
                if record['state']=='confirmed':proof=json.loads(record['receipt'])
            turn=proof.get('turn_id')if proof and proof.get('broad_profile_verified')is True else None
            return {**q,'profile':'eva_broad','broad_active_turn':turn}
        return {**q,'profile':'eva_broad',**({'project_binding_required':True}if q['mode']!='create_preflight'else{})}
    if not task['task_key'].startswith('eva-admin-'):
        return q
    need(p.get('schema') != 'raspberry-task-policy-v2',
         'admin_delegation_requires_separate_review')
    need(p.get('admin_delegation') == ADMIN_DELEGATION,
         'admin_delegation_not_authorized')
    if q['mode'] != 'creation_probe':
        need(time.time() < ADMIN_DELEGATION['expires_at'], 'admin_delegation_expired')
    return {**q, 'profile': 'eva_admin'}


def profile_rpc(q,db,p,payload,legacy,old):
    bound=bind_profile(q,db,p,payload)
    if bound.get('profile')!='eva_broad'or bound['mode']=='create_preflight':return rpc(bound,legacy,old)
    operation=payload.get('operation_id')or payload.get('task_id')
    need(type(operation)is str and re.fullmatch('[a-f0-9]{32}',operation),'broad_profile_operation_required')
    grant=broad_grant(p,active=True);grant_sha=fingerprint(grant)
    transition=hashlib.sha256((operation+':'+bound['mode']+':'+grant_sha).encode()).hexdigest()[:32]
    previous=db.begin_profile_transition(transition,operation,bound.get('thread_id'),grant_sha,bound['mode'])
    if previous is not None:
        need(previous['state']=='confirmed','broad_profile_uncertain_observe_same_operation')
        return json.loads(previous['receipt'])
    try:
        reply=rpc(bound,legacy,old)
        confirmed=reply.get('broad_profile_verified')is True
        db.finish_profile_transition(transition,'confirmed'if confirmed else'uncertain',reply)
        need(confirmed,'broad_profile_readback_unconfirmed')
        return reply
    except Exception:
        db.finish_profile_transition(transition,'uncertain',None)
        raise


def communication_state(policy, legacy, revoked, now):
    """Project admission causes without treating an unknown peer as expiry."""
    if policy.get('workspace_thread_communication') is not True:
        return 'not_approved'
    if revoked:
        return 'closed_revoked'
    if policy.get('enabled') is not True:
        return 'closed_disabled'
    if legacy.get('_v2_peer_unconfirmed'):
        return 'closed_peer_unconfirmed'
    if legacy.get('_observation_only') and not legacy.get('_v2'):
        return 'closed_legacy_transport'
    expiry = policy.get('expires_at')
    if expiry is not None and now >= expiry:
        return 'closed_expired'
    return 'fresh_preflight_required'


def handle(name, args, old):
    need(os.geteuid() == UID, 'task_identity_refused')
    validate(name, args)
    p, legacy = task_policy(old, observation=name in ('codex_task_status', 'codex_task_list',
                                                'codex_task_reconcile', 'codex_task_revoke'))
    admission_closed = bool(legacy.get('_v2_peer_unconfirmed') or
                            (legacy.get('_observation_only') and not legacy.get('_v2')) or not p['enabled'] or
                            (STATE / 'revoked').exists())
    delegation = p.get('admin_delegation')
    administrative_closed = bool(admission_closed or delegation != ADMIN_DELEGATION or
        delegation.get('enabled') is not True or time.time() >= delegation['expires_at'])
    legacy_send_closed = bool(legacy.get('_v2') or admission_closed or legacy.get('allow_send', True) is not True)
    with locked(read_only=name == 'codex_task_list'):
        if name == 'codex_task_list':
            import task_list
            communication_enabled=p.get('workspace_thread_communication') is True
            communication_state_value=communication_state(p, legacy,
                (STATE/'revoked').exists(), time.time())
            # No Store constructor, DDL, receipt writes, resume or inference.
            return task_list.collect(args, __import__(__name__), lambda q: rpc(q, legacy, old),
                                     admission_closed=admission_closed,
                                     administrative_closed=administrative_closed,
                                     legacy_send_closed=legacy_send_closed,
                                     workspace_communication_closed=bool(admission_closed or
                                         not communication_enabled),
                                     communication_policy={'enabled':communication_enabled,
                                         'expires_at':p.get('expires_at'),'state':communication_state_value})
        db = store(p)
        try:
            invoke = lambda q: profile_rpc(q, db, p, args, legacy, old)
            idle = lambda: dispatch_idle(old, legacy)
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
                    known=db.row('tasks',args['operation_id']);grant=broad_grant(p)
                    broad_task=bool(known and not known['task_key'].startswith(('eva-admin-','workspace:'))and grant is not None)
                    broad_closed=bool(broad_task and(not grant['enabled']or grant['revoked']))
                    if admission_closed or broad_closed:
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
                        row['creation_identity_confirmed'] = (
                            (observation.get('durable') is True and not observation.get('collection_error'))
                            or (observation.get('status') == 'notLoaded' and row.get('state') == 'created'))
                    counts = db.db.execute("SELECT count(*),sum(state!='not_dispatched'),sum(turn IS NOT NULL) FROM sends WHERE task=?", (args['operation_id'],)).fetchone()
                    row['dispatch_evidence'] = {'attempt_receipts': counts[0],
                        'dispatch_intent_rows': counts[1] or 0, 'recorded_turns': counts[2] or 0}
                    task_record = db.row('tasks', args['operation_id'])
                    profile_closed = admission_closed or broad_closed or bool(task_record and
                        task_record['task_key'].startswith(ADMIN_DELEGATION['task_key_prefix']) and
                        administrative_closed)
                    row['send_admission'] = 'closed' if profile_closed or row.get('state') in ('cancelled_before_first_send','creation_lost_before_send') else 'fresh_preflight_required'
                    row['resume_supported'] = bool(row['send_admission'] != 'closed' and row.get('state') == 'created')
                    row['interface_confirmation'] = 'client_policy_required_for_create_send_and_revoke'
                    row['notLoaded_is_terminal'] = False
                    row['observation_without_admission'] = profile_closed
                    row['workspace_admission_closed'] = admission_closed
                    row['administrative_admission_closed'] = administrative_closed
                    row['broad_profile_scope']='registered_tasks_in_eva_project'if broad_task else None
                    row['broad_profile_admission']='closed_revoked_or_disabled'if broad_closed else'fresh_native_readback_required'if broad_task else'not_enrolled'
                    row['mandatory_interface_confirmations']=True
                    return row
                try:
                    row = response(db.observe(args['operation_id'], invoke))
                except Exception:
                    if not admission_closed:
                        raise
                    row = response(db.row('sends', args['operation_id']))
                    row['collection_error'] = 'live_observation_unavailable_cached_state_only'
                task_record = db.row('tasks', row['task']) if row.get('task') else None
                row['observation_without_admission'] = admission_closed or bool(task_record and
                    task_record['task_key'].startswith(ADMIN_DELEGATION['task_key_prefix']) and
                    administrative_closed)
                row['reconciliation_ready'] = bool(
                    row.get('state') in ('completed', 'failed', 'interrupted', 'not_dispatched')
                    and row.get('result_hash') and not row.get('reconciled'))
                row['workspace_admission_closed'] = admission_closed
                row['administrative_admission_closed'] = administrative_closed
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
            return response(db.send(payload, invoke, lambda c, t: admission(c, t, p), idle,
                                    allow_workspace=p.get('workspace_thread_communication') is True))
        finally:
            db.close()




COORDINATOR_THREAD = '${COORDINATOR_THREAD_ID}'
COORDINATOR_REPORT = Path('${COORDINATOR_REPORT_PATH}')
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
    _, legacy = task_policy(old, observation=True)
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
