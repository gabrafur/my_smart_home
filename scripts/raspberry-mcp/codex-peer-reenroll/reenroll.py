"""Root re-enrollment of the Codex app-server executable after a Codex CLI update.

The task peer attestor pins the exact executable (sha256 + size) of the process that
serves the Codex control socket. Every Codex update (the nightly `codex-cli` stage)
installs a new binary, and the attestor then refuses until the enrollment is updated.

This fixed service updates only daemon_identity.executable_sha256/executable_size, and
only when ALL of these hold:
  * the process really serving the enrolled socket (SO_PEERCRED) passes the attestor's
    path, owner, mode, cgroup and app-server role checks;
  * its executable is byte-identical to the linux-arm64 binary that the public npm
    registry publishes for the installed version: the tarball is downloaded fresh and
    checked against the registry's sha512 integrity before the member is hashed.
    Nothing written by the household user (lockfiles, update results) is trusted for
    provenance; the installed package.json only chooses which version to check.
Every other enrollment field stays byte-identical. The previous enrollment is kept in
the state directory. The proof is NOT written here: the attestor timer re-attests by CAS
within a minute and keeps the old proof if any check fails. No restart, no retry loop:
failures back off and are reported in status.json and the journal.
"""
import base64
import datetime
import fcntl
import hashlib
import json
import os
import pwd
import re
import socket
import stat
import struct
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ENROLLMENT = Path('/etc/raspberry-task-control/peer-attestor-enrollment.json')
# Relative to the host_operator home, which comes from the Root-sealed enrollment (the uid that
# owns the daemon executable); no account name or home path is tracked here.
CONTROL_SOCKET = Path('.codex/app-server-control/app-server-control.sock')
PACKAGE_JSON = Path('.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/package.json')
LOCK = Path('/run/raspberry-task-peer-attest.lock')
STATE = Path('/var/lib/raspberry-task-peer-reenroll')
REGISTRY = 'https://registry.npmjs.org/@openai%2fcodex/'
TARBALL = 'https://registry.npmjs.org/@openai/codex/-/codex-%s.tgz'
MEMBER = 'package/vendor/aarch64-unknown-linux-musl/bin/codex'
VERSION = re.compile(r'[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-(alpha|beta|rc)\.[0-9]{1,4})?-linux-arm64\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
EXECUTABLE_FIELDS = {'executable_sha256', 'executable_size'}
MAX_EXECUTABLE = 536870912
MAX_TARBALL = 536870912
MAX_METADATA = 1048576
BACKOFF_FAILURE = 1800        # network or registry failure: try again after 30 min
BACKOFF_MISMATCH = 6 * 3600   # binary differs from the registry build: 6 h
KEEP_BACKUPS = 10


class Refused(Exception):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def now_iso(clock=time.time):
    return datetime.datetime.fromtimestamp(clock(), datetime.timezone.utc).isoformat(timespec='seconds')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


# ---------- pure decisions (unit tested) ----------

def derive(raw, executable_sha256, executable_size):
    """Enrollment bytes -> new bytes where only the executable sha256/size changed."""
    cfg = json.loads(raw)
    need(canonical(cfg) == raw.rstrip(b'\n'), 'enrollment_serialization_unknown')
    need(cfg.get('schema') == 'raspberry-task-peer-attestor-v2' and type(cfg.get('daemon_identity')) is dict,
         'enrollment_schema')
    need(SHA256.fullmatch(executable_sha256 or '') and type(executable_size) is int
         and 0 < executable_size <= MAX_EXECUTABLE, 'executable_identity_invalid')
    new = json.loads(raw)
    new['daemon_identity']['executable_sha256'] = executable_sha256
    new['daemon_identity']['executable_size'] = executable_size
    need({k for k in new if new[k] != cfg[k]} <= {'daemon_identity'}, 'only_executable_fields_may_change')
    old_ident = cfg['daemon_identity']
    need({k for k in new['daemon_identity'] if new['daemon_identity'][k] != old_ident.get(k)} <= EXECUTABLE_FIELDS
         and set(new['daemon_identity']) == set(old_ident), 'only_executable_fields_may_change')
    out = canonical(new)
    return out + b'\n' if raw.endswith(b'\n') else out


def check_metadata(meta, version):
    """Registry document for one version -> (tarball URL, sha512 digest bytes)."""
    need(type(meta) is dict and meta.get('name') == '@openai/codex' and meta.get('version') == version,
         'registry_metadata_mismatch')
    dist = meta.get('dist')
    need(type(dist) is dict and dist.get('tarball') == TARBALL % version, 'registry_tarball_url_unexpected')
    integrity = dist.get('integrity')
    need(type(integrity) is str and integrity.startswith('sha512-'), 'registry_integrity_missing')
    digest = base64.b64decode(integrity[7:], validate=True)
    need(len(digest) == 64, 'registry_integrity_invalid')
    return dist['tarball'], digest


def member_identity(tarball_path):
    """sha256 and size of the one Codex binary inside a verified tarball (streamed)."""
    found = None
    with tarfile.open(tarball_path, 'r:gz') as archive:
        for entry in archive:
            if entry.name != MEMBER:
                continue
            need(found is None and entry.isreg() and 0 < entry.size <= MAX_EXECUTABLE, 'registry_member_invalid')
            h = hashlib.sha256()
            stream = archive.extractfile(entry)
            while True:
                block = stream.read(1 << 20)
                if not block:
                    break
                h.update(block)
            found = (h.hexdigest(), entry.size)
    need(found is not None, 'registry_member_missing')
    return found


def backoff_active(last, live_sha, clock=time.time):
    """True when the same live binary already failed recently (no tight retry loops)."""
    if type(last) is not dict or last.get('live_sha256') != live_sha or last.get('state') == 'reenrolled':
        return False
    wait = BACKOFF_MISMATCH if last.get('reason') == 'live_binary_differs_from_registry' else BACKOFF_FAILURE
    return clock() - float(last.get('at_epoch', 0)) < wait


# ---------- host observation ----------

def sealed_enrollment():
    s = ENROLLMENT.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and stat.S_IMODE(s.st_mode) == 0o600
         and s.st_nlink == 1 and s.st_size <= 8192, 'enrollment_unsealed')
    return ENROLLMENT.read_bytes()


def operator_home(identity, getpwuid=pwd.getpwuid):
    """host_operator home of the enrolled daemon owner (uid from the sealed enrollment)."""
    uid = identity.get('executable_uid') if type(identity) is dict else None
    need(type(uid) is int and not isinstance(uid, bool) and uid > 0, 'enrollment_operator_uid_invalid')
    try:
        home = getpwuid(uid).pw_dir.rstrip('/')
    except KeyError:
        raise Refused('enrollment_operator_unknown') from None
    need(home.startswith('/') and len(home) > 1 and '/../' not in home + '/' and '\0' not in home,
         'enrollment_operator_home_invalid')
    return Path(home)


def observe(identity, cgroup_expected, cache=None):
    """Live peer behind the enrolled socket; mirrors the attestor's checks except the hash pin."""
    SOCKET = operator_home(identity) / CONTROL_SOCKET
    link = SOCKET.lstat()
    need(stat.S_ISLNK(link.st_mode) and link.st_uid == identity['executable_uid'], 'socket_link_changed')
    target = os.readlink(SOCKET)
    t = Path(target).lstat()
    need(stat.S_ISSOCK(t.st_mode) and t.st_uid == identity['executable_uid'] and stat.S_IMODE(t.st_mode) == 0o600,
         'socket_changed')
    with socket.socket(socket.AF_UNIX) as c:
        c.settimeout(2)
        c.connect(str(SOCKET))
        need(c.getpeername() == target, 'bound_address_changed')
        pid, uid, _gid = struct.unpack('3i', c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    need(pid > 1 and uid == identity['executable_uid'], 'peer_changed')
    proc = Path('/proc') / str(pid)
    exe = os.readlink(proc / 'exe')
    need(exe == identity['executable_path'], 'executable_path_changed')
    argv = (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    need(argv.count(b'app-server') == 1, 'role_unconfirmed')
    need((proc / 'cgroup').read_text().strip() == cgroup_expected, 'cgroup_changed')
    fd = os.open(exe, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        run = (proc / 'exe').stat()
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and (st.st_dev, st.st_ino) == (run.st_dev, run.st_ino)
             and st.st_uid == identity['executable_uid'] and st.st_gid == identity['executable_gid']
             and stat.S_IMODE(st.st_mode) == identity['executable_mode'] and 0 < st.st_size <= MAX_EXECUTABLE,
             'executable_metadata_unconfirmed')
        key = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
        if cache and cache.get('stat') == key and SHA256.fullmatch(str(cache.get('sha256'))):
            digest = cache['sha256']  # same inode, size and times as the last full hash
        else:
            h = hashlib.sha256()
            while True:
                b = os.read(fd, 1 << 20)
                if not b:
                    break
                h.update(b)
            after = os.fstat(fd)
            need((st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns) ==
                 (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'executable_changed')
            digest = h.hexdigest()
    finally:
        os.close(fd)
    return {'pid': pid, 'sha256': digest, 'size': st.st_size, 'stat': key, 'socket': [t.st_dev, t.st_ino]}


def installed_version(identity):
    fd = os.open(operator_home(identity) / PACKAGE_JSON, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as h:
        meta = json.loads(h.read(65537))
    version = meta.get('version') if type(meta) is dict else None
    need(meta.get('name') == '@openai/codex' and type(version) is str and VERSION.fullmatch(version),
         'installed_version_invalid')
    return version


def fetch(url, limit, sink=None, timeout=60):
    request = urllib.request.Request(url, headers={'Accept': 'application/json' if sink is None else '*/*',
                                                   'User-Agent': 'raspberry-task-peer-reenroll'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        need(response.status == 200, 'registry_http_%s' % response.status)
        total, chunks = 0, []
        while True:
            block = response.read(1 << 20)
            if not block:
                break
            total += len(block)
            need(total <= limit, 'registry_response_too_large')
            if sink is None:
                chunks.append(block)
            else:
                sink(block)
    return b''.join(chunks) if sink is None else total


def registry_identity(version, workdir, fetcher=fetch):
    """Download the published tarball, check its sha512 and return the binary's identity."""
    tarball, expected = check_metadata(json.loads(fetcher(REGISTRY + version, MAX_METADATA)), version)
    path = workdir / ('download-%d.tgz' % os.getpid())
    h = hashlib.sha512()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as out:
            def sink(block):
                h.update(block)
                out.write(block)
            fetcher(tarball, MAX_TARBALL, sink)
        need(h.digest() == expected, 'registry_integrity_mismatch')
        return member_identity(path)
    finally:
        if path.exists():
            path.unlink()


# ---------- state ----------

def read_status():
    try:
        return json.loads((STATE / 'status.json').read_text())
    except (OSError, ValueError):
        return {}


def write_atomic(path, body, mode=0o600):
    tmp = path.with_name('.' + path.name + '.reenroll-tmp')
    if tmp.exists():
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as h:
        h.write(body)
        h.flush()
        os.fsync(h.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def keep_backup(raw, stamp):
    folder = STATE / 'previous'
    folder.mkdir(mode=0o700, exist_ok=True)
    write_atomic(folder / ('enrollment-%s.json' % stamp), raw)
    backups = sorted(folder.glob('enrollment-*.json'))
    for old in backups[:-KEEP_BACKUPS]:
        old.unlink()


# ---------- verbs ----------

def run(clock=time.time):
    last = read_status()
    raw = sealed_enrollment()
    cfg = json.loads(raw)
    ident = cfg['daemon_identity']
    peer = observe(ident, cfg['daemon_cgroup'], last.get('hash_cache'))
    result = {'at': now_iso(clock), 'at_epoch': clock(), 'live_sha256': peer['sha256'], 'live_size': peer['size'],
              'peer_pid': peer['pid'], 'enrolled_sha256': ident['executable_sha256'], 'automatic_retry': False,
              'hash_cache': {'stat': peer['stat'], 'sha256': peer['sha256']}}
    if peer['sha256'] == ident['executable_sha256'] and peer['size'] == ident['executable_size']:
        return dict(result, state='current')
    if backoff_active(last.get('last_attempt'), peer['sha256'], clock):
        return dict(result, state='backoff', last_attempt=last.get('last_attempt'))
    version = installed_version(ident)
    attempt = {'live_sha256': peer['sha256'], 'version': version, 'at': result['at'], 'at_epoch': result['at_epoch']}
    try:
        published = registry_identity(version, STATE)
    except Refused as error:
        attempt.update(state='refused', reason=str(error))
        return dict(result, state='refused', reason=str(error), last_attempt=attempt)
    except Exception as error:  # network, TLS, gzip: report, back off, never guess
        attempt.update(state='failed', reason='registry_unavailable:%s' % type(error).__name__)
        return dict(result, state='failed', reason=attempt['reason'], last_attempt=attempt)
    if published != (peer['sha256'], peer['size']):
        attempt.update(state='refused', reason='live_binary_differs_from_registry', registry_sha256=published[0])
        return dict(result, state='refused', reason=attempt['reason'], last_attempt=attempt)
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        again = sealed_enrollment()
        need(again == raw, 'enrollment_changed_during_check')
        confirm = observe(ident, cfg['daemon_cgroup'])
        need((confirm['pid'], confirm['sha256'], confirm['size']) == (peer['pid'], peer['sha256'], peer['size']),
             'peer_changed_during_check')
        after = derive(raw, peer['sha256'], peer['size'])
        keep_backup(raw, now_iso(clock).replace(':', ''))
        tmp = ENROLLMENT.with_name('.' + ENROLLMENT.name + '.reenroll-tmp')
        if tmp.exists():
            tmp.unlink()
        w = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(w, 'wb') as h:
            h.write(after)
            h.flush()
            os.fsync(h.fileno())
        os.chown(tmp, 0, 0)
        os.chmod(tmp, 0o600)
        need(ENROLLMENT.read_bytes() == raw, 'enrollment_changed_before_swap')
        os.replace(tmp, ENROLLMENT)
    finally:
        os.close(fd)
    attempt.update(state='reenrolled', previous_sha256=ident['executable_sha256'])
    return dict(result, state='reenrolled', version=version, previous_sha256=ident['executable_sha256'],
                enrollment_sha256=hashlib.sha256(after).hexdigest(), last_attempt=attempt)


def check_provenance():
    """Read-only: prove the currently ENROLLED binary equals the registry build (no write)."""
    raw = sealed_enrollment()
    cfg = json.loads(raw)
    ident = cfg['daemon_identity']
    peer = observe(ident, cfg['daemon_cgroup'], read_status().get('hash_cache'))
    version = installed_version(ident)
    published = registry_identity(version, STATE)
    return {'state': 'provenance_confirmed' if published == (peer['sha256'], peer['size']) ==
            (ident['executable_sha256'], ident['executable_size']) else 'provenance_mismatch',
            'version': version, 'registry_sha256': published[0], 'live_sha256': peer['sha256'],
            'enrolled_sha256': ident['executable_sha256'], 'at': now_iso()}


def main(argv):
    verb = argv[1] if len(argv) > 1 else 'run'
    need(verb in ('run', 'check-provenance'), 'verb')
    STATE.mkdir(mode=0o700, exist_ok=True)
    if verb == 'check-provenance':
        try:
            out = check_provenance()
        except Refused as error:
            out = {'state': 'refused', 'reason': str(error)}
        print(json.dumps(out, sort_keys=True), flush=True)
        return
    last = read_status()
    try:
        out = run()
    except Refused as error:
        out = {'at': now_iso(), 'state': 'refused', 'reason': str(error), 'automatic_retry': False}
    status = dict(out)
    status.setdefault('last_attempt', last.get('last_attempt'))
    status.setdefault('hash_cache', last.get('hash_cache'))
    write_atomic(STATE / 'status.json', canonical(status) + b'\n')
    # One journal line, without the cache (stable, greppable state for observers).
    print(json.dumps({k: v for k, v in out.items() if k != 'hash_cache'}, sort_keys=True), flush=True)


if __name__ == '__main__':
    main(sys.argv)
