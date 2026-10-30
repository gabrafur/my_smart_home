"""Closed, recoverable cache maintenance. No shell or caller-supplied paths."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import ctypes
import gzip
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import time

OWNER_UID = 1001
OWNER_HOME = Path(pwd.getpwuid(OWNER_UID).pw_dir)
STATE = Path('/var/lib/raspberry-mcp-storage')
POLICY = Path('/usr/local/lib/raspberry-mcp-storage/approval.json')
SCOPES = {'npm_logs': (OWNER_HOME/'.npm/_logs', 14*86400, r'\d{4}-\d\d-\d\dT[0-9_]+Z-(?:debug|timing)-\d+\.log'),
          'npm_temporary': (OWNER_HOME/'.npm/_cacache/tmp', 7*86400, r'[a-f0-9]{8,64}')}
MAX_FILES = 32
MAX_BYTES = 16*1024**2
MAX_HISTORY = 64
PLAN_TTL = 900
CHUNK = 65536
MAX_BATCHES_PER_DAY = 4
MINIMUM_SPACING = 21600
MAX_QUARANTINE_BYTES = 512*1024**2


def receipt(value, observed=None):
    observed = time.time() if observed is None else observed
    return {**value, 'source': 'fixed_recoverable_cache_maintenance_ledger',
            'observed_at': datetime.fromtimestamp(observed, timezone.utc).isoformat(),
            'age_seconds': 0, 'collection_error': None,
            'coverage': [*value.get('coverage', []), 'no_paths_names_contents_or_credentials',
                         'receipt_is_not_authority_for_other_operations']}


def _lease_command(fd, command):
    # Reuse the file owner's lease right; do not require CAP_LEASE or ptrace.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.setfsuid.argtypes = [ctypes.c_uint]
    libc.setfsuid.restype = ctypes.c_int
    old = libc.setfsuid(0xffffffff)
    try:
        libc.setfsuid(OWNER_UID)
        need(libc.setfsuid(0xffffffff) == OWNER_UID, 'cache_lease_owner_unconfirmed')
        fcntl.fcntl(fd, fcntl.F_SETLEASE, command)
    finally:
        libc.setfsuid(old)
        need(libc.setfsuid(0xffffffff) == old, 'cache_lease_identity_restore_failed')


@contextmanager
def exclusive_lease(fd):
    def interrupted(*_):
        raise ValueError('cache_lease_break_requested')
    previous = signal.signal(signal.SIGIO, interrupted)
    owner = fcntl.fcntl(fd, fcntl.F_GETOWN)
    held = False
    try:
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        _lease_command(fd, fcntl.F_WRLCK)
        held = True
        yield
    finally:
        try:
            if held:
                _lease_command(fd, fcntl.F_UNLCK)
            fcntl.fcntl(fd, fcntl.F_SETOWN, owner)
        finally:
            signal.signal(signal.SIGIO, previous)


def need(value, reason):
    if not value:
        raise ValueError(reason)


def read_json(path, limit=32768):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit, 'unsafe_ledger')
        return json.loads(os.read(fd, limit+1))
    finally:
        os.close(fd)


def save(path, value):
    encoded = (json.dumps(value, sort_keys=True, allow_nan=False)+'\n').encode()
    need(len(encoded) <= 32768, 'ledger_limit')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as out:
            out.write(encoded)
            out.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(d)
    finally:
        os.close(d)


def identity(s):
    return {'device': s.st_dev, 'inode': s.st_ino, 'bytes': s.st_size,
            'mtime_ns': s.st_mtime_ns, 'ctime_ns': s.st_ctime_ns,
            'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode)}


def open_directory(path):
    """Reject every symlink ancestor, including a replaced cache directory."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_files():
    seen = set()
    deadline = time.monotonic()+1
    checked = 0
    complete = True
    with os.scandir('/proc') as processes:
        for process in processes:
            if not process.name.isdecimal():
                continue
            if checked >= 4096 or time.monotonic() > deadline:
                return seen, False
            try:
                with os.scandir(Path(process.path)/'fd') as files:
                    for entry in files:
                        if checked >= 4096 or time.monotonic() > deadline:
                            return seen, False
                        checked += 1
                        try:
                            s = os.stat(entry.path)
                            if stat.S_ISREG(s.st_mode):
                                seen.add((s.st_dev, s.st_ino))
                        except FileNotFoundError:
                            continue
            except FileNotFoundError:
                continue
            except OSError:
                complete = False
    return seen, complete


def policy(*, allow_revoked=False):
    s = POLICY.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and not s.st_mode & 0o022,
         'policy_identity_unconfirmed')
    p = read_json(POLICY)
    need(p.get('execution_approved') is True and p.get('project') == '/mnt/data/docker'
         and p.get('allowed_scopes') == ['npm_logs', 'npm_temporary']
         and p.get('max_files') == MAX_FILES and p.get('max_bytes') == MAX_BYTES,
         'specific_maintenance_policy_approval_required')
    need(p.get('max_batches_per_24h') == MAX_BATCHES_PER_DAY
         and p.get('minimum_spacing_seconds') == MINIMUM_SPACING
         and p.get('maximum_quarantine_bytes') == MAX_QUARANTINE_BYTES,
         'maintenance_limits_changed')
    need(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == p.get('source_sha256'),
         'maintenance_source_changed')
    if p.get('expires_at') is not None:
        need(type(p['expires_at']) in (int, float) and time.time() < p['expires_at'], 'maintenance_scope_expired')
    need(allow_revoked or not (STATE/'revoked').exists(), 'maintenance_scope_revoked')
    return p


def resources(filesystem='/mnt/data/docker'):
    v = os.statvfs(filesystem)
    available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:')))*1024
    need(available >= 2*1024**3 and v.f_bavail*v.f_frsize >= 2*1024**3
         and v.f_bavail/v.f_blocks >= .15, 'resource_gate_blocked')
    return {'available_bytes': v.f_bavail*v.f_frsize, 'total_bytes': v.f_blocks*v.f_frsize}


class Maintenance:
    def __init__(self, state=STATE, scopes=None, probe=open_files, authorize=policy,
                 resource_gate=resources, common_lock=Path('/mnt/data/docker/.daily-maintenance.lock'),
                 restore_authorize=None):
        self.state = Path(state)
        self.scopes = SCOPES if scopes is None else scopes
        self.probe, self.authorize, self.resources = probe, authorize, resource_gate
        self.common_lock = Path(common_lock)
        self.restore_authorize = (lambda: policy(allow_revoked=True)) if authorize is policy else authorize
        if restore_authorize is not None:
            self.restore_authorize = restore_authorize

    @contextmanager
    def locked(self):
        self.state.mkdir(mode=0o700, exist_ok=True)
        info = self.state.lstat()
        need(stat.S_ISDIR(info.st_mode) and not self.state.is_symlink()
             and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
             'state_identity_changed')
        locks = []
        try:
            for path in [self.state/'maintenance.lock', self.common_lock]:
                flags = os.O_NOFOLLOW | (os.O_WRONLY | os.O_CREAT if path != self.common_lock else os.O_RDONLY)
                fd = os.open(path, flags, 0o600)
                locks.append(fd)
                need(stat.S_ISREG(os.fstat(fd).st_mode), 'lock_identity_changed')
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError('maintenance_busy') from None
            yield
        finally:
            for fd in reversed(locks):
                os.close(fd)

    def location(self, scope):
        need(scope in self.scopes and scope in SCOPES, 'scope_protected_or_unknown')
        return self.scopes[scope]

    def op_path(self, op):
        need(type(op) is str and re.fullmatch('[a-f0-9]{32}', op), 'invalid_operation_id')
        return self.state/op

    def view(self, plan):
        return {'operation_id': plan['operation_id'], 'scope': plan['scope'], 'dry_run': True,
                'source': 'fixed_cache_metadata_plan', 'observed_at': plan['observed_at'],
                'age_seconds': max(0, round(time.time()-plan['created_at'], 3)),
                'collection_error': None, 'expires_at': plan['expires_at'],
                'items': [{'item_id': row['item_id'], 'bytes': row['identity']['bytes'],
                           'reason': 'aged_known_cache_file_exclusive_kernel_lease_required',
                           'open_file_observation_complete': plan['open_file_scan_complete'],
                           'recovery': 'verified_gzip_quarantine_restore_without_overwrite'}
                          for row in plan['items']],
                'candidate_bytes': sum(row['identity']['bytes'] for row in plan['items']),
                'reclaimed_bytes': None, 'reclaim_estimate': 'unknown_until_compression',
                'coverage': ['no_file_contents_or_names', 'not_execution_or_owner_approval',
                             'protected_data_and_Docker_images_excluded'],
                'skipped': plan['skipped']}

    def plan(self, scope, op, now=None):
        now = time.time() if now is None else now
        root, age, pattern = self.location(scope)
        directory = self.op_path(op)
        with self.locked():
            if directory.exists():
                p = read_json(directory/'plan.json')
                need(p['scope'] == scope, 'operation_id_conflict')
                return self.view(p) | {'duplicate': True}
            need(sum(1 for p in self.state.iterdir() if p.is_dir()) < MAX_HISTORY, 'history_capacity')
            opened, complete = self.probe()
            items = []
            skipped = {'not_eligible': 0, 'in_use': 0, 'limit': 0}
            total = entries = 0
            try:
                fd = open_directory(root)
            except FileNotFoundError:
                fd = None
            try:
                if fd is not None:
                    need(os.fstat(fd).st_uid == OWNER_UID and not os.fstat(fd).st_mode & 0o022,
                         'cache_owner_changed')
                    with os.scandir(fd) as files:
                        for entry in files:
                            entries += 1
                            if entries > 512:
                                skipped['limit'] += 1
                                break
                            s = entry.stat(follow_symlinks=False)
                            if (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != OWNER_UID
                                    or stat.S_IMODE(s.st_mode) not in (0o600, 0o640, 0o644)
                                    or not re.fullmatch(pattern, entry.name)
                                    or min(now-s.st_mtime, now-s.st_ctime) < age):
                                skipped['not_eligible'] += 1
                                continue
                            if (s.st_dev, s.st_ino) in opened:
                                skipped['in_use'] += 1
                                continue
                            if len(items) >= MAX_FILES or total+s.st_size > MAX_BYTES:
                                skipped['limit'] += 1
                                continue
                            token = hashlib.sha256(f'{op}:{s.st_dev}:{s.st_ino}'.encode()).hexdigest()[:24]
                            items.append({'item_id': token, 'name': entry.name, 'identity': identity(s)})
                            total += s.st_size
            finally:
                if fd is not None:
                    os.close(fd)
            directory.mkdir(mode=0o700)
            plan = {'schema_version': 1, 'operation_id': op, 'scope': scope, 'created_at': now,
                    'observed_at': datetime.fromtimestamp(now, timezone.utc).isoformat(),
                    'expires_at': now+PLAN_TTL, 'items': items, 'skipped': skipped,
                    'open_file_scan_complete': complete}
            save(directory/'plan.json', plan)
            return self.view(plan)

    def status(self, op):
        directory = self.op_path(op)
        plan = read_json(directory/'plan.json')
        for name in ['restore-result.json', 'restore-intent.json', 'result.json', 'intent.json']:
            if (directory/name).exists():
                out = read_json(directory/name)
                if out.get('observed_at'):
                    stamp = datetime.fromisoformat(out['observed_at']).timestamp()
                    out['age_seconds'] = round(max(0, time.time()-stamp), 3)
                return out
        return self.view(plan)

    def execute(self, scope, op):
        root, age, pattern = self.location(scope)
        directory = self.op_path(op)
        with self.locked():
            self.authorize()
            if (directory/'intent.json').exists():
                return self.status(op) | {'duplicate': True, 'automatic_retry': False}
            plan = read_json(directory/'plan.json')
            need(plan['scope'] == scope and plan['expires_at'] >= time.time(), 'plan_expired_or_changed')
            need(len(plan['items']) <= MAX_FILES and sum(r['identity']['bytes'] for r in plan['items']) <= MAX_BYTES,
                 'plan_limits_changed')
            if not plan['items']:
                return receipt({'state': 'no_eligible_items_no_execution', 'operation_id': op,
                                'items': [], 'automatic_retry': False, 'reclaimed_bytes': 0})
            attempts = []
            for record in self.state.glob('*/intent.json'):
                value = read_json(record)
                need(type(value.get('created_at')) in (int, float), 'prior_intent_requires_reconciliation')
                if value['created_at'] > time.time()-86400:
                    attempts.append(value['created_at'])
            need(len(attempts) < MAX_BATCHES_PER_DAY and
                 (not attempts or time.time()-max(attempts) >= MINIMUM_SPACING), 'maintenance_budget_held')
            retained = 0
            for record in self.state.glob('*/payload/*'):
                s = record.lstat()
                need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'quarantine_identity_changed')
                retained += s.st_blocks*512
            need(retained+MAX_BYTES <= MAX_QUARANTINE_BYTES, 'quarantine_capacity')
            before = self.resources()
            opened, complete = self.probe()
            source_fd = open_directory(root) if plan['items'] else None
            payload = directory/'payload'
            payload.mkdir(mode=0o700)
            done = []
            save(directory/'intent.json', receipt({'state': 'execution_intent_reconciliation_required',
                 'operation_id': op, 'created_at': time.time(), 'automatic_retry': False, 'before': before}))
            try:
                for row in plan['items']:
                    need(re.fullmatch(pattern, row['name']), 'protected_target')
                    s = os.stat(row['name'], dir_fd=source_fd, follow_symlinks=False)
                    need(identity(s) == row['identity'] and stat.S_ISREG(s.st_mode) and s.st_nlink == 1
                         and s.st_uid == OWNER_UID and (s.st_dev, s.st_ino) not in opened,
                         'candidate_changed_or_in_use')
                    done.append(self.quarantine_one(row, source_fd, payload))
                after = self.resources()
                result = {'state': 'recoverable_quarantine_complete', 'operation_id': op,
                          'items': done, 'before': before, 'after': after,
                          'net_available_delta_bytes': after['available_bytes']-before['available_bytes'],
                          'coverage': ['net_filesystem_change_not_exclusive_cleanup_attribution',
                                       'original_cache_files_recoverable_from_verified_gzip'],
                          'automatic_retry': False}
            except Exception as exc:
                result = {'state': 'outcome_unknown_reconciliation_required', 'operation_id': op,
                          'completed_items': done, 'reason': str(exc) if type(exc) is ValueError else type(exc).__name__,
                          'automatic_retry': False, 'recovery_payloads_preserved': True}
            finally:
                if source_fd is not None:
                    os.close(source_fd)
            result = receipt(result)
            save(directory/'result.json', result)
            return result

    def restore(self, scope, op):
        root, _age, pattern = self.location(scope)
        directory = self.op_path(op)
        with self.locked():
            self.restore_authorize()
            if (directory/'restore-intent.json').exists():
                return self.status(op) | {'duplicate': True, 'automatic_retry': False}
            plan = read_json(directory/'plan.json')
            need(plan['scope'] == scope and (directory/'intent.json').exists(), 'no_quarantine_intent')
            payload = directory/'payload'
            rows = [row for row in plan['items'] if (payload/(row['item_id']+'.original')).exists()
                    or (payload/(row['item_id']+'.seal.json')).exists()]
            self.resources()
            fd = open_directory(root)
            done = []
            try:
                for row in rows:
                    need(re.fullmatch(pattern, row['name']), 'protected_restore_target')
                    try:
                        os.stat(row['name'], dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    raise ValueError('restore_target_exists_no_overwrite')
                save(directory/'restore-intent.json', receipt({'operation_id': op, 'created_at': time.time(),
                     'state': 'restore_intent_reconciliation_required', 'automatic_retry': False}))
                for row in rows:
                    staged = payload/(row['item_id']+'.original')
                    archive = payload/(row['item_id']+'.gz')
                    if staged.exists():
                        s = staged.lstat()
                        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1
                             and (s.st_dev, s.st_ino, s.st_size) ==
                                 (row['identity']['device'], row['identity']['inode'], row['identity']['bytes']),
                             'original_quarantine_changed')
                        os.link(staged, row['name'], dst_dir_fd=fd, follow_symlinks=False)
                        staged.unlink()
                    else:
                        seal = read_json(payload/(row['item_id']+'.seal.json'))
                        need(seal['recovery_verified'] is True and seal['bytes'] == row['identity']['bytes'],
                             'recovery_seal_unconfirmed')
                        temp = '.storage-restore-'+row['item_id']
                        target = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                         0o600, dir_fd=fd)
                        digest = hashlib.sha256()
                        count = 0
                        with os.fdopen(target, 'wb') as out, gzip.open(archive, 'rb') as inp:
                            while chunk := inp.read(CHUNK):
                                count += len(chunk)
                                need(count <= seal['bytes'], 'recovery_expansion_limit')
                                digest.update(chunk);out.write(chunk)
                            need(count == seal['bytes'] and digest.hexdigest() == seal['source_sha256'],
                                 'recovery_integrity_failed')
                            out.flush();os.fsync(out.fileno())
                            if os.geteuid() == 0:
                                os.fchown(out.fileno(), row['identity']['uid'], row['identity']['gid'])
                            os.fchmod(out.fileno(), row['identity']['mode'])
                        os.link(temp, row['name'], src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                        os.unlink(temp, dir_fd=fd)
                    os.fsync(fd)
                    done.append({'item_id': row['item_id'], 'bytes': row['identity']['bytes']})
                result = {'operation_id': op, 'state': 'cache_restored_without_overwrite',
                          'items': done, 'quarantine_preserved': True, 'automatic_retry': False}
            except Exception as exc:
                result = {'operation_id': op, 'state': 'restore_unconfirmed_no_automatic_retry',
                          'completed_items': done, 'reason': str(exc) if type(exc) is ValueError else type(exc).__name__,
                          'quarantine_preserved': True, 'automatic_retry': False}
            finally:
                os.close(fd)
            result = receipt(result)
            if (directory/'restore-intent.json').exists():
                save(directory/'restore-result.json', result)
            return result

    def revoke(self):
        with self.locked():
            if (self.state/'revoked').exists():
                return read_json(self.state/'revoked') | {'duplicate': True}
            self.authorize()
            result = receipt({'state': 'new_cache_execution_revoked', 'automatic_retry': False,
                              'existing_quarantine_and_receipts_preserved': True})
            save(self.state/'revoked', result)
            return result

    def quarantine_one(self, row, source_fd, payload):
        source = os.open(row['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
        try:
            with exclusive_lease(source):
                s = os.fstat(source)
                need(identity(s) == row['identity'], 'leased_candidate_changed')
                staged = payload/(row['item_id']+'.original')
                need(s.st_dev == payload.stat().st_dev, 'cross_filesystem_quarantine_refused')
                os.rename(row['name'], staged, src_dir_fd=source_fd)
                moved = staged.lstat()
                need(stat.S_ISREG(moved.st_mode) and moved.st_nlink == 1
                     and {k: v for k, v in identity(moved).items() if k != 'ctime_ns'} ==
                         {k: v for k, v in row['identity'].items() if k != 'ctime_ns'},
                     'candidate_replaced_during_quarantine')
                target = payload/(row['item_id']+'.gz')
                digest = hashlib.sha256()
                count = 0
                with os.fdopen(os.dup(source), 'rb') as inp, target.open('xb') as out:
                    os.fchmod(out.fileno(), 0o600)
                    with gzip.GzipFile(fileobj=out, mode='wb', filename='', compresslevel=1, mtime=0) as gz:
                        while chunk := inp.read(CHUNK):
                            count += len(chunk)
                            need(count <= row['identity']['bytes'], 'candidate_grew')
                            digest.update(chunk);gz.write(chunk)
                    out.flush();os.fsync(out.fileno())
                need(count == row['identity']['bytes'], 'candidate_truncated')
                verify = hashlib.sha256()
                recovered = 0
                with gzip.open(target, 'rb') as inp:
                    while chunk := inp.read(CHUNK):
                        recovered += len(chunk);need(recovered <= count, 'quarantine_expansion_limit');verify.update(chunk)
                need(recovered == count and verify.digest() == digest.digest(), 'recovery_verification_failed')
                save(payload/(row['item_id']+'.seal.json'), {'item_id': row['item_id'],
                     'source_sha256': digest.hexdigest(), 'bytes': count, 'recovery_verified': True})
                staged.unlink()  # Exact owned staged cache file, verified recovery retained.
                return {'item_id': row['item_id'], 'source_bytes': count,
                        'quarantine_bytes': target.stat().st_size, 'recovery_verified': True}
        finally:
            os.close(source)
