"""Typed fixed-task gateway. No caller prompt, thread, path, command or permissions."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import stat
import sqlite3
import subprocess
import time

from repair_store import Store, ResumeStore, TASK, THREAD, TERMINAL, need, validate, digest

ROOT = Path('/usr/local/lib/raspberry-repair-control')
POLICY = ROOT / 'policy.json'
STATE = Path('/var/lib/raspberry-mcp-operations/task-control')
RECEIPTS = Path('/home/gabriel/smart-home-proactive-review-20261023/evidence')
EXPIRY = 1794066708.0
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
    fields = {'enabled', 'expires_at', 'thread', 'tasks', 'source_hashes',
              'dependencies', 'maximum_submissions'}
    need(set(policy) in (fields, fields | {'standing_repair'}, fields | {'standing_repair','resume_enrollment'}), 'repair_policy_changed')
    persistent = standing(policy)
    if 'resume_enrollment' in policy:
        resume_enrollment(policy)
    need(type(policy['enabled']) is bool and
         (policy['expires_at'] is None if persistent else policy['expires_at'] == EXPIRY) and
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
        # Only the fixed private binding uses group-readable mode; all hashes remain required.
        mode = 0o640 if path == '/etc/raspberry-nodered-diagnostics/kia-runtime-binding.json' else 0o644
        need(hashlib.sha256(tasks.read(Path(path), 0, mode)).hexdigest() == h,
             'repair_dependency_changed')
    return policy


def standing(policy):
    grant = policy.get('standing_repair')
    if grant is None:
        return False
    expected = {'schema', 'lease_kind', 'owner_confirmation_sha256', 'project',
                'maximum_submissions_per_24h', 'maximum_receipts', 'revoked',
                'interface_confirmations_required', 'legacy_administrative_grant'}
    need(type(grant) is dict and set(grant) == expected and
         grant['schema'] == 'fixed_health_repair_standing_v1' and
         grant['lease_kind'] == 'persistent_revocable' and
         type(grant['owner_confirmation_sha256']) is str and
         len(grant['owner_confirmation_sha256']) == 64 and
         all(c in '0123456789abcdef' for c in grant['owner_confirmation_sha256']) and
         grant['owner_confirmation_sha256'] != '0' * 64 and
         grant['project'] == '/mnt/data/docker' and
         type(grant['maximum_submissions_per_24h']) is int and grant['maximum_submissions_per_24h'] == 2 and
         type(grant['maximum_receipts']) is int and grant['maximum_receipts'] == 4096 and
         type(grant['revoked']) is bool and
         grant['interface_confirmations_required'] is True and
         grant['legacy_administrative_grant'] is False,
         'standing_repair_scope_changed')
    return True


def selected_admission(policy, tasks, old, *, observation=False):
    if not standing(policy):
        return tasks.policy(old)
    task_policy, peer = tasks.task_policy(old, observation=observation)
    need(peer.get('_v2') is True and not peer.get('_v2_peer_unconfirmed'),
         'repair_peer_unconfirmed')
    if not observation:
        need(task_policy.get('enabled') is True and not (tasks.STATE / 'revoked').exists(),
             'repair_task_admission_revoked')
        need(policy['enabled'] and not policy['standing_repair']['revoked'],
             'repair_standing_revoked')
        enrolled=resume_enrollment(policy)
        need(enrolled is None or enrolled['enabled'],'repair_resume_enrollment_closed')
    return task_policy, peer


def resume_enrollment(policy):
    entry=policy.get('resume_enrollment')
    if entry is None:return None
    need(standing(policy), 'repair_resume_requires_standing')
    need(type(entry)is dict and set(entry)=={'schema','enabled','thread_id','task','owner_scope_sha256','owner_addendum_sha256','metadata_evidence_sha256','profile','legacy_administrative_grant','interface_confirmations_required','normalizes_project_cwd'},'repair_resume_enrollment_shape')
    need(entry['schema']=='fixed_repair_profile_enrollment_v1' and type(entry['enabled'])is bool and entry['thread_id']==THREAD and entry['task']==TASK and entry['legacy_administrative_grant']is False and entry['interface_confirmations_required']is True and entry['normalizes_project_cwd']is True,'repair_resume_enrollment_scope')
    for key in ('owner_scope_sha256','owner_addendum_sha256','metadata_evidence_sha256'):
        need(type(entry[key])is str and len(entry[key])==64 and all(c in '0123456789abcdef'for c in entry[key])and entry[key]!='0'*64,'repair_resume_evidence_required')
    need(entry['owner_scope_sha256']==policy['standing_repair']['owner_confirmation_sha256'],'repair_resume_owner_scope_changed')
    expected={'threadId':THREAD,'cwd':'/mnt/data/docker','model':'gpt-6.1-sol','modelProvider':'openai','approvalPolicy':'on-request','approvalsReviewer':'user','sandbox':'danger-full-access','reasoningEffort':'high'}
    need(entry['profile']==expected,'repair_resume_profile_scope')
    return entry


def revoked(tasks):
    flag = STATE / 'repair.revoked'
    if not os.path.lexists(flag):
        return False
    tasks.read(flag, 1001, 0o600, 64)
    return True


def invoke(q, old, legacy, tasks=None, resume_store=None):
    enrollment=None;resume_hash=None
    if tasks is not None:
        current = configuration(tasks)
        _, peer = selected_admission(current, tasks, old, observation=q['mode'] == 'observe')
        need(peer.get('socket_identity') == legacy.get('socket_identity') and
             peer.get('peer_pid') == legacy.get('peer_pid'), 'repair_peer_changed')
        if q['mode'] != 'observe':
            need(not revoked(tasks), 'repair_standing_revoked')
        enrollment=resume_enrollment(current)
        if enrollment and q['mode']in('preflight','send'):
            need(enrollment['enabled'] and resume_store is not None,'repair_resume_enrollment_closed')
            resume_hash=digest({'enrollment':enrollment,'boot_id':peer.get('boot_id'),'peer_pid':peer.get('peer_pid'),'socket_identity':peer.get('socket_identity')})
            if q['mode']=='preflight':
                if not resume_store.begin(q['operation_id'],resume_hash,time.time()):
                    return resume_store.ready(q['operation_id'],resume_hash)
            else:resume_store.ready(q['operation_id'],resume_hash)
    context = tasks.pinned_peer_connection(legacy, old) if tasks is not None else contextlib.nullcontext(None)
    with context as peer:
        if peer is None:
            old.peer(legacy)
        env = {'PATH': '/usr/bin:/bin', 'WS_NO_BUFFER_UTIL': '1', 'WS_NO_UTF_8_VALIDATE': '1'}
        extra = {}
        if enrollment and q['mode']=='preflight':
            env['REPAIR_RESUME_PROFILE_JSON']=json.dumps(enrollment['profile'],sort_keys=True)
        if peer is not None:
            env['TASK_PEER_FD'] = str(peer.fileno())
            extra['pass_fds'] = (peer.fileno(),)
        result = subprocess.run(['/usr/bin/node', '--jitless', '--no-expose-wasm',
        '--max-old-space-size=24', str(ROOT/'repair_rpc.cjs')],
        input=json.dumps(q).encode(), capture_output=True, timeout=15,
        env=env, **extra)
    need(result.returncode == 0 and len(result.stdout) <= 16384, 'repair_rpc_unconfirmed')
    reply = json.loads(result.stdout)
    need(reply.get('ok') is True, 'repair_rpc_unconfirmed')
    result=reply['result']
    if enrollment and q['mode']=='preflight':
        need(result.get('resume_profile',{}).get('profile_readback_verified')is True,'repair_resume_readback_required')
        resume_store.verified(q['operation_id'],resume_hash,result)
    return result


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


def archive_bytes(value):
    raw = (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
    need(len(raw) <= 131072, 'repair_archive_size_limit')
    return raw


@contextlib.contextmanager
def archive_directory():
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in RECEIPTS.parts[1:]:
            nxt = os.open(part,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        info=os.fstat(fd)
        need(info.st_uid == 1001 and not info.st_mode & 0o002, 'unsafe_archive_directory')
        yield fd
    finally:
        os.close(fd)


def read_archive(op, expected_hash):
    need(type(op) is str and len(op) == 32 and all(c in '0123456789abcdef' for c in op), 'archive_identity_invalid')
    with archive_directory() as directory:
        fd=os.open('eva-health-archive-'+op+'.json',os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,dir_fd=directory)
        try:
            info=os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 1001 and info.st_nlink == 1 and
                 stat.S_IMODE(info.st_mode)==0o600 and 0 < info.st_size <= 131072, 'unsafe_archive_file')
            raw=os.read(fd,131073)
            after=os.fstat(fd)
            need(len(raw)==info.st_size and (info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==
                 (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns), 'archive_file_changed')
        finally:os.close(fd)
    need(hashlib.sha256(raw).hexdigest()==expected_hash,'repair_archive_digest_changed')
    value=json.loads(raw)
    need(value.get('schema')=='fixed_repair_archive_v1' and value.get('operation_id')==op and
         value.get('task')==TASK and value.get('thread_id')==THREAD and
         value.get('terminal_state') in TERMINAL and digest(value['result'])==value['result_hash'],
         'repair_archive_scope_changed')
    return value


def publish_archive(value):
    # Exact terminal central receipt is independently preserved before compaction.
    op=value['operation_id']
    need(type(op)is str and len(op)==32 and all(c in '0123456789abcdef'for c in op),'archive_identity_invalid')
    publish_receipt(op,value['result'])
    raw=archive_bytes(value);h=hashlib.sha256(raw).hexdigest()
    final='eva-health-archive-'+op+'.json';stage=final+'.staging'
    with archive_directory() as directory:
        try:
            final_info=os.stat(final,dir_fd=directory,follow_symlinks=False)
        except FileNotFoundError:final_info=None
        if final_info is not None:
            try:stage_info=os.stat(stage,dir_fd=directory,follow_symlinks=False)
            except FileNotFoundError:stage_info=None
            if stage_info is not None:
                need((final_info.st_dev,final_info.st_ino)==(stage_info.st_dev,stage_info.st_ino) and
                     final_info.st_uid==1001 and stat.S_ISREG(final_info.st_mode) and
                     stat.S_IMODE(final_info.st_mode)==0o600 and final_info.st_nlink==2,
                     'repair_archive_partial_link_conflict')
                fd=os.open(stage,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
                try:need(os.read(fd,131073)==raw,'repair_archive_partial_content_conflict')
                finally:os.close(fd)
                os.unlink(stage,dir_fd=directory);os.fsync(directory)
            need(read_archive(op,h)==value,'repair_archive_conflict')
            return h
        # A same-operation prefix can be completed after an interrupted write.
        # No target is overwritten and the live rows remain until readback.
        fd=os.open(stage,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=directory)
        try:
            info=os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid==1001 and info.st_nlink==1 and
                 stat.S_IMODE(info.st_mode)==0o600 and info.st_size<=len(raw),'repair_archive_stage_unsafe')
            existing=os.read(fd,131073)
            need(raw.startswith(existing) and len(existing)==info.st_size,'repair_archive_stage_conflict')
            remaining=memoryview(raw)[len(existing):]
            while remaining:
                n=os.write(fd,remaining);need(n>0,'repair_archive_write_no_progress');remaining=remaining[n:]
            os.fsync(fd)
            current=os.stat(stage,dir_fd=directory,follow_symlinks=False)
            need((current.st_dev,current.st_ino)==(info.st_dev,info.st_ino),'repair_archive_stage_replaced')
        finally:os.close(fd)
        # link is no-replace. A conflict is observed rather than overwritten.
        os.link(stage,final,src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
        os.fsync(directory);os.unlink(stage,dir_fd=directory);os.fsync(directory)
    need(read_archive(op,h)==value,'repair_archive_readback_unconfirmed')
    return h


def quota_observation(tasks):
    # Read-only metadata query, including after revocation. No schema migration.
    try:
        tasks.read(tasks.LEGACY_DB, 1001, 0o600, 1048576)
        with contextlib.closing(sqlite3.connect('file:'+str(tasks.LEGACY_DB)+'?mode=ro', uri=True)) as db:
            db.row_factory = sqlite3.Row
            return dict(state='observed', **Store.rolling_accounting(db, time.time()))
    except (ValueError, OSError, sqlite3.Error):
        return {'state': 'unconfirmed', 'unknown_timestamp_reserved_count': None,
                'unknown_timestamp_policy': 'settled_unknown_charged_in_every_window'}


def handle(name, args, old, tasks):
    validate(name, args)
    need(os.geteuid() == 1001, 'repair_identity_refused')
    p = configuration(tasks)
    persistent = standing(p)
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
            reason = None
            try:
                selected_admission(p, tasks, old)
                temporal = persistent or time.time() < EXPIRY
            except (ValueError, OSError) as error:
                temporal = False
                reason = str(error) if str(error) in {'repair_peer_unconfirmed', 'repair_task_admission_revoked',
                    'repair_standing_revoked', 'control_lease_expired', 'task_admission_expired'} else 'repair_dependency_unconfirmed'
            if stopped: reason = 'repair_revoked'
            elif not p['enabled']: reason = 'repair_disabled'
            elif not persistent and time.time() >= EXPIRY: reason = 'repair_lease_expired'
            return {'catalog': [TASK], 'thread_id': THREAD, 'enabled': p['enabled'] and temporal and not stopped,
                    'admission_block_reason': reason,
                    'expires_at': None if persistent else EXPIRY, 'maximum_submissions': 2,
                    'lease_kind': 'persistent_revocable' if persistent else 'finite',
                    'submission_window': 'rolling_24h' if persistent else 'lifetime',
                    'quota_observation': quota_observation(tasks) if persistent else None,
                    'maximum_receipts': 4096 if persistent else 8,
                    'storage_pressure': 'fail_closed_no_eviction_or_replay',
                    'thread_resume': ('enrolled_explicit_profile_readback_required' if p.get('resume_enrollment',{}).get('enabled') else 'blocked_without_separate_profile_enrollment'),
                    'automatic_retry': False,
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
            receipt = Store(legacy_store.db, clock=time.time, standing=persistent, archive_reader=read_archive if persistent else None)
            resume_store=ResumeStore(legacy_store.db) if p.get('resume_enrollment') else None
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
                need(p['enabled'] and not stopped and (persistent or time.time() < EXPIRY), 'repair_admission_closed')
                tp, legacy = selected_admission(p, tasks, old)
                dynamic = tasks.store(tp)
                try:
                    dynamic.idle()
                    count, latest = dynamic.db.execute('SELECT count(*),max(created) FROM sends '
                        'WHERE created>?', (time.time()-86400,)).fetchone()
                    tasks.admission(count, latest, tp)
                finally:
                    dynamic.close()
                if persistent:
                    for archived in receipt.archive_ready(time.time()):
                        payload = receipt.archive_payload(archived)
                        archive_hash = publish_archive(payload)
                        receipt.archive_commit(archived, archive_hash)
                repair_count = receipt.rolling_count(time.time()) if persistent else legacy_store.db.execute('SELECT count(*) FROM repair_receipts').fetchone()[0]
                need(repair_count < p['maximum_submissions'], 'repair_submission_budget_exhausted')
                # Registry commit precedes any daemon RPC. A duplicate never
                # reaches send again, even if the first process died here.
                tasks.dispatch_idle(old, legacy) if persistent else tasks.legacy_idle(old, legacy)
                receipt.reserve(op)
                try:
                    legacy_store.send({'operation_id': op, 'thread_id': THREAD, 'intent': TASK},
                                      legacy, lambda q, _: (invoke({**q,'operation_id':op}, old, legacy, tasks, resume_store) if resume_store is not None else invoke(q, old, legacy, tasks)) if persistent else invoke(q, old, legacy))
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
                    _, legacy = selected_admission(p, tasks, old, observation=True)
                    legacy_store.observe({'operation_id': op, 'thread_id': THREAD}, legacy,
                                         lambda q, _: (invoke({**q,'operation_id':op}, old, legacy, tasks, resume_store) if resume_store is not None else invoke(q, old, legacy, tasks)) if persistent else invoke(q, old, legacy))
                except Exception:
                    # Observation failure does not erase the accepted handle,
                    # complete a job, or authorize restarting it.
                    return {'operation_id': op, 'task': TASK, 'state': job['state'],
                        'turn_id': job['turn'], 'observation': 'unavailable_peer_or_recorded_turn',
                        'automatic_retry': False, 'execution_replay_allowed': False}
                job = legacy_store.get(op)
            if job and job['state'] in TERMINAL and job['result']:
                receipt.terminal(op, json.loads(job['result']))
            known = receipt.get(op)
            value = {'operation_id': op, 'task': TASK, 'thread_id': THREAD,
                'state': job['state'] if job else (known['result'].get('operation_state', 'failed') if known['result'] else 'failed'),
                'turn_id': job['turn'] if job else (known['result'].get('turn_id') if known['result'] else None),
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
