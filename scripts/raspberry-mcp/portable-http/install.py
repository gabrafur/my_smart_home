"""Prepare an optional local MCP transport. Never start or expose it automatically."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import stat
import subprocess
import sys

STAGE = Path('/run/raspberry-mcp-http-review')
CODE = Path('/usr/local/lib/raspberry-mcp-http')
STATE = Path('/var/lib/raspberry-mcp-http')
UNIT = Path('/etc/systemd/system/raspberry-mcp-http.service')
ACCOUNT = 'raspberry-mcp-http'


def need(condition):
    if not condition:
        raise ValueError('installation_precondition_failed')


def read_root(path, mode=0o644, limit=65536):
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
             stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1 and info.st_size <= limit)
        value = os.read(fd, limit + 1)
        need(len(value) <= limit)
        return value
    finally:
        os.close(fd)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def existing_file(path, expected):
    if os.path.lexists(path):
        need(read_root(path) == expected)


def ensure_directory(path, gid, mode):
    if not os.path.lexists(path):
        path.mkdir(mode=mode)
        os.chown(path, 0, gid)
        os.chmod(path, mode)
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
         info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode)


def write_new(path, raw, gid, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        with os.fdopen(os.dup(fd), 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(fd)


def prepare():
    need(os.geteuid() == 0 and not sys.argv[1:] and Path(__file__).absolute() == STAGE / 'install.py')
    read_root(STAGE / 'install.py')
    manifest = json.loads(read_root(STAGE / 'release.json'))
    names = {'gateway.py', 'raspberry-mcp-http.service'}
    need(set(manifest['files']) == names and manifest['loopback_only'] is True and
         manifest['automatic_activation'] is False and manifest['changes_backend_authority'] is False)
    payload = {name: read_root(STAGE / name) for name in names}
    need(all(sha(payload[name]) == manifest['files'][name] for name in names))
    compile(payload['gateway.py'], str(CODE / 'gateway.py'), 'exec')
    need(Path('/etc/systemd/system/raspberry-mcp.socket').is_file())
    mcp_gid = grp.getgrnam('raspberry-mcp').gr_gid
    existing_file(CODE / 'gateway.py', payload['gateway.py'])
    existing_file(UNIT, payload['raspberry-mcp-http.service'])
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        subprocess.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                        '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
        account = pwd.getpwnam(ACCOUNT)
    gid = grp.getgrnam(ACCOUNT).gr_gid
    need(account.pw_uid != 0 and account.pw_gid == gid and account.pw_shell == '/usr/sbin/nologin'
         and account.pw_dir == '/nonexistent' and
         set(os.getgrouplist(ACCOUNT, gid)) <= {gid, mcp_gid})
    ensure_directory(CODE, 0, 0o755)
    ensure_directory(STATE, gid, 0o750)
    token = STATE / 'token'
    if not os.path.lexists(token):
        write_new(token, (secrets.token_hex(32) + '\n').encode(), gid, 0o440)
    else:
        value = read_root(token, 0o440, 65)
        need(len(value) == 65 and all(c in b'0123456789abcdef' for c in value[:-1]) and value[-1:] == b'\n')
        need(token.stat().st_gid == gid)
    for target, raw in [(CODE / 'gateway.py', payload['gateway.py']), (UNIT, payload['raspberry-mcp-http.service'])]:
        if not target.exists():
            write_new(target, raw, 0, 0o644)
    receipt = {'state': 'prepared_not_activated', 'source_hashes': manifest['files'],
               'loopback': '127.0.0.1', 'port': 8765, 'identity': ACCOUNT,
               'credential_exported': False, 'services_started': 0,
               'backend_authority_or_expiry_changed': False}
    receipt_raw = (json.dumps(receipt, sort_keys=True) + '\n').encode()
    if not (STATE / 'install.json').exists():
        write_new(STATE / 'install.json', receipt_raw, gid, 0o440)
    else:
        need(read_root(STATE / 'install.json', 0o440) == receipt_raw)
    print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        prepare()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(json.dumps({'state': 'preparation_unconfirmed', 'raw_error_withheld': True,
                          'automatic_retry': False, 'services_started': 0}))
        raise SystemExit(1)
