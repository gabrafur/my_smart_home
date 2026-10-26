"""Fixed notice repair. Imported by tests; production has no path/command options."""
import datetime, fcntl, hashlib, json, os, pwd, re, socket, stat, struct, subprocess, time
from pathlib import Path

PUBLIC_EXPORT_EXPIRY = 0  # Rebind only in a separately reviewed private package.
ROOT = Path('/usr/local/lib/raspberry-admin-executor')
STATE = Path('/var/lib/raspberry-admin-executor')
NOTICE = Path('/usr/local/lib/raspberry-ha-notices')
CACHE = Path('/var/lib/raspberry-ha-notices/cache.json')
UNIT = 'raspberry-ha-notices.service'
ACTION = 'migrate_two_notice_aliases'
KEY = 'notice-exact-aliases-20261024'
TOOLS = ('admin_action_apply', 'admin_action_status', 'admin_action_reconcile', 'admin_action_revoke')
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'NODE_PATH': ''}

def need(ok, reason):
    if not ok:
        raise ValueError(reason)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def read(path, uid=0, limit=524288):
    directory = os.open('/', os.O_PATH | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = nxt
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == uid and s.st_nlink == 1
                 and not s.st_mode & 0o022 and s.st_size <= limit, 'unsafe_fixed_file')
            raw = os.read(fd, limit + 1)
            need(len(raw) <= limit, 'fixed_file_limit')
            return raw
        finally:
            os.close(fd)
    finally:
        os.close(directory)

def atomic(path, raw, uid=0, gid=0, mode=0o600):
    # Root-owned code/state parents are sealed; cache parent is collector-owned.
    # Check every parent via no-follow, and retain the opened directory for rename.
    directory = os.open('/', os.O_PATH | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = nxt
        parent = os.fstat(directory)
        need(parent.st_uid == uid and not parent.st_mode & 0o022, 'unsafe_fixed_parent')
        tmp = '.' + path.name + '.admin-new'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)

def command(argv, **kwargs):
    return subprocess.run(argv, env=ENV, capture_output=True, timeout=20, **kwargs)

class Backend:
    def __init__(self):
        self.uid = pwd.getpwnam('raspberry-ha-notices').pw_uid
        self.gid = pwd.getpwnam('raspberry-ha-notices').pw_gid
        self.policy = json.loads(read(ROOT / 'policy.json'))
        s = STATE.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o700, 'unsafe_root_state')
        for name, sha in self.policy['sealed'].items():
            need('/' not in name and digest(read(ROOT / name)) == sha, 'sealed_code_changed')
        for path, sha in self.policy['dependencies'].items():
            need(digest(read(Path(path))) == sha, 'fixed_dependency_changed')

    def load(self):
        try:
            return json.loads(read(STATE / 'receipt.json'))
        except FileNotFoundError:
            return None

    def save(self, row):
        row = {**row, 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        atomic(STATE / 'receipt.json', json.dumps(row).encode())
        # Bounded history, sanitized states only. No source/cache contents.
        history = STATE / 'audit.json'
        try:
            rows = json.loads(read(history, limit=65536))
        except FileNotFoundError:
            rows = []
        need(len(rows) < 64, 'audit_capacity')
        rows.append({k: row[k] for k in ('state', 'observed_at')})
        atomic(history, json.dumps(rows).encode())
        return row

    def authorized(self):
        p = self.policy
        need(p['enabled'] is True and not (STATE / 'revoked').exists(), 'revoked')
        need(p['not_before'] <= time.time() < p['expires_at'], 'approval_expired')
        need(Path('/proc/sys/kernel/random/boot_id').read_text().strip() == p['boot_id'], 'boot_changed')

    def active(self):
        p = command(['/usr/bin/systemctl', 'is-active', UNIT])
        need(p.returncode in (0, 3), 'collector_state_unknown')
        return p.returncode == 0

    def baseline(self):
        for name, sha in self.policy['baselines'].items():
            need(digest(read(NOTICE / name)) == sha, 'production_baseline_changed')
        need(self.active(), 'collector_not_active')

    def control(self, verb):
        need(verb in ('stop', 'start'), 'service_verb_refused')
        p = command(['/usr/bin/systemctl', verb, UNIT])
        need(p.returncode == 0, 'collector_control_failed')
        need(self.active() == (verb == 'start'), 'collector_control_unconfirmed')

    def prepare(self):
        # Called only after confirmed stop. Backups stay root-only.
        cache = read(CACHE, self.uid)
        for name in self.policy['baselines']:
            atomic(STATE / (name + '.before'), read(NOTICE / name))
        atomic(STATE / 'cache.before', cache)
        def demote():
            os.setgroups([])
            os.setgid(self.gid)
            os.setuid(self.uid)
        p = command(['/usr/bin/node', '--jitless', '--no-expose-wasm', '--max-old-space-size=24',
                     str(ROOT / 'migration-runner.cjs')], input=cache, preexec_fn=demote)
        need(p.returncode == 0 and len(p.stdout) <= 524288, 'migration_validation_failed')
        # Migrator's output is never returned to MCP or journal.
        json.loads(p.stdout)
        atomic(STATE / 'cache.after', p.stdout)

    def apply(self):
        for name in self.policy['baselines']:
            atomic(NOTICE / name, read(ROOT / name), mode=0o644)
        atomic(CACHE, read(STATE / 'cache.after'), self.uid, self.gid)

    def rollback(self):
        # Never overwrite external/unknown changes.
        for name, before in self.policy['baselines'].items():
            need(digest(read(NOTICE / name)) in (before, digest(read(ROOT / name))), 'rollback_code_conflict')
        need(read(CACHE, self.uid) in (read(STATE / 'cache.before'), read(STATE / 'cache.after')), 'rollback_cache_conflict')
        for name in self.policy['baselines']:
            atomic(NOTICE / name, read(STATE / (name + '.before')), mode=0o644)
        atomic(CACHE, read(STATE / 'cache.before'), self.uid, self.gid)

    def observation(self):
        return {'collector_active': self.active(), 'code_matches_candidate': all(
            digest(read(NOTICE / name)) == digest(read(ROOT / name)) for name in self.policy['baselines'])}

    def revoke(self):
        atomic(STATE / 'revoked', b'revoked\n')

def validate(q):
    need(isinstance(q, dict) and set(q) == {'host', 'tool', 'action', 'idempotency_key'}, 'request_scope_refused')
    need(q['host'] == 'raspberry' and q['tool'] in TOOLS and q['action'] == ACTION
         and q['idempotency_key'] == KEY, 'request_scope_refused')

def handle(q, b):
    validate(q)
    row = b.load()
    if q['tool'] == 'admin_action_status':
        return {'receipt': row, 'observation': b.observation(), 'automatic_retry': False}
    if q['tool'] == 'admin_action_revoke':
        b.revoke()
        return {'revoked': True, 'receipts_preserved': True}
    if q['tool'] == 'admin_action_reconcile':
        # Observation never executes another stop/start or replays an uncertain intent.
        return {'receipt': row, 'observation': b.observation(), 'replay_performed': False}
    b.authorized()
    if row:
        return {'receipt': row, 'duplicate': True, 'automatic_retry': False}
    b.baseline()
    row = {'action': ACTION, 'idempotency_key': KEY, 'state': 'stop_intent', 'attempts': 1}
    b.save(row)
    try:
        b.control('stop')
    except Exception:
        return b.save({**row, 'state': 'stop_outcome_unknown', 'reconciliation_required': True})
    row = b.save({**row, 'state': 'stopped'})
    try:
        b.prepare()
    except Exception:
        # No writes to production made, resume original once.
        row = b.save({**row, 'state': 'resume_original_intent'})
        try:
            b.control('start')
            return b.save({**row, 'state': 'preparation_failed_original_resumed'})
        except Exception:
            return b.save({**row, 'state': 'resume_outcome_unknown', 'reconciliation_required': True})
    row = b.save({**row, 'state': 'write_intent'})
    try:
        b.apply()
    except Exception:
        row = b.save({**row, 'state': 'rollback_intent'})
        try:
            b.rollback()
        except Exception:
            return b.save({**row, 'state': 'rollback_blocked', 'reconciliation_required': True})
        row = b.save({**row, 'state': 'resume_original_intent'})
        try:
            b.control('start')
            return b.save({**row, 'state': 'rolled_back_original_resumed'})
        except Exception:
            return b.save({**row, 'state': 'resume_outcome_unknown', 'reconciliation_required': True})
    row = b.save({**row, 'state': 'start_intent'})
    try:
        b.control('start')
    except Exception:
        return b.save({**row, 'state': 'start_outcome_unknown', 'reconciliation_required': True})
    return b.save({**row, 'state': 'applied_collector_active_mcp_validation_pending'})

def unique_request(pairs):
    out={}
    for key,value in pairs:
        need(key not in out,'duplicate_request_field');out[key]=value
    return out

READINESS_REQUEST={'tool':'icloud_readiness','host':'raspberry','component_id':'icloud_adapter'}
def readiness(q,b):
    need(time.time() < PUBLIC_EXPORT_EXPIRY, 'public_export_unarmed')
    need(q==READINESS_REQUEST,'readiness_scope_refused')
    scope=b.policy.get('readiness_scope')
    need(isinstance(scope,dict)and set(scope)=={'enabled','expires_at','expected_release_revision','minimum_poll_seconds','expected_code_sha256','expected_public_setup_sha256'}and scope['enabled']is True and scope['expires_at']==b.policy['expires_at']and scope['minimum_poll_seconds']==60,'readiness_scope_refused')
    need(b.policy['enabled']is True and b.policy['not_before']<=time.time()and time.time()+10<scope['expires_at']and not Path('/run/raspberry-icloud-read/revoked').exists(),'readiness_expired_or_revoked')
    need(Path('/proc/sys/kernel/random/boot_id').read_text().strip()==b.policy['boot_id'],'boot_changed')
    import importlib.util
    spec=importlib.util.spec_from_file_location('sealed_icloud_readiness',ROOT/'icloud_readiness.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.collect(scope['expected_release_revision'],scope['expected_code_sha256'],scope['expected_public_setup_sha256'])

def serve():
    need(time.time() < PUBLIC_EXPORT_EXPIRY, 'public_export_unarmed')
    need(os.geteuid() == 0, 'root_executor_required')
    os.umask(0o077)
    # Accept=yes socket passes a single connected Unix stream on stdin/stdout.
    sock = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
    _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    need(uid == pwd.getpwnam('__OPERATOR_NATIVE_ACCOUNT__').pw_uid, 'broker_identity_refused')
    sock.settimeout(3)
    raw = bytearray()
    while b'\n' not in raw:
        chunk = sock.recv(1024)
        need(chunk and len(raw) + len(chunk) <= 2048, 'request_limit')
        raw.extend(chunk)
    need(raw.count(b'\n') == 1 and raw.endswith(b'\n'), 'one_request_only')
    q = json.loads(raw, object_pairs_hook=unique_request)
    if q != READINESS_REQUEST:
        validate(q)
    fd = os.open(STATE / 'executor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backend = Backend()
        reply = readiness(q, backend) if q == READINESS_REQUEST else handle(q, backend)
    finally:
        os.close(fd)
    os.write(2, json.dumps({'event': 'admin_executor_request_handled', 'tool': q['tool'],
                          'automatic_retry': False}).encode() + b'\n')
    sock.sendall(json.dumps(reply).encode() + b'\n')

if __name__ == '__main__':
    try:
        serve()
    except Exception:
        # No exception text, user input, subprocess output or cache in audit.
        os.write(2, b'{"event":"admin_executor_request_refused_or_unconfirmed","automatic_retry":false}\n')
        os.write(1, b'{"error":"refused_or_reconciliation_required","automatic_retry":false}\n')
        raise SystemExit(1)
