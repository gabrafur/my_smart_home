"""Prepare the optional OAuth edge. Never starts, enables or exposes anything."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys

STAGE = Path('/run/raspberry-mcp-edge-review')
CODE = Path('/usr/local/lib/raspberry-mcp-edge')
STATE = Path('/var/lib/raspberry-mcp-edge')
UNIT = Path('/etc/systemd/system/raspberry-mcp-edge.service')
ACCOUNT = 'raspberry-mcp-edge'
FILES = {'edge.py': CODE / 'edge.py', 'edge_admin.py': CODE / 'edge_admin.py',
         'raspberry-mcp-edge.service': UNIT}


def need(condition):
    if not condition:
        raise ValueError('installation_precondition_failed')


def read_root(path, limit=65536):
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o644
             and info.st_nlink == 1 and info.st_size <= limit)
        return os.read(fd, limit + 1)
    finally:
        os.close(fd)


def ensure_directory(path, uid, gid, mode):
    if not os.path.lexists(path):
        path.mkdir(mode=mode)
    need(not path.is_symlink())
    os.chown(path, uid, gid)
    os.chmod(path, mode)
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid)


def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    os.chown(path, 0, 0)
    os.chmod(path, 0o644)


def prepare():
    need(os.geteuid() == 0 and not sys.argv[1:] and Path(__file__).absolute() == STAGE / 'install.py')
    read_root(STAGE / 'install.py')
    manifest = json.loads(read_root(STAGE / 'release.json'))
    need(set(manifest['files']) == set(FILES) and manifest['loopback_only'] is True and
         manifest['automatic_activation'] is False and manifest['changes_backend_authority'] is False)
    payload = {name: read_root(STAGE / name) for name in FILES}
    need(all(hashlib.sha256(payload[n]).hexdigest() == manifest['files'][n] for n in FILES))
    compile(payload['edge.py'], 'edge.py', 'exec')
    key = Path('/var/lib/raspberry-mcp-edgekey/token')  # Restricted key made by the gateway installer.
    need(Path('/etc/systemd/system/raspberry-mcp-http.service').is_file() and key.is_file() and
         key.stat().st_uid == 0 and key.stat().st_gid == grp.getgrnam('raspberry-mcp-edgekey').gr_gid and
         stat.S_IMODE(key.stat().st_mode) == 0o440)
    for name, target in FILES.items():
        if os.path.lexists(target):
            need(read_root(target) == payload[name])
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        subprocess.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                        '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
        account = pwd.getpwnam(ACCOUNT)
    gid = grp.getgrnam(ACCOUNT).gr_gid
    need(account.pw_uid != 0 and account.pw_shell == '/usr/sbin/nologin')
    ensure_directory(CODE, 0, 0, 0o755)
    ensure_directory(STATE, 0, gid, 0o750)
    ensure_directory(STATE / 'state', account.pw_uid, gid, 0o700)
    for name, target in FILES.items():
        if not target.exists():
            write_new(target, payload[name])
    print(json.dumps({'state': 'prepared_not_activated', 'source_hashes': manifest['files'],
                      'loopback': '127.0.0.1', 'port': 8766, 'identity': ACCOUNT,
                      'owner_credentials_present': (STATE / 'owner.json').exists(),
                      'public_url_configured': (STATE / 'config.json').exists(),
                      'services_started': 0}))


if __name__ == '__main__':
    try:
        prepare()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(json.dumps({'state': 'preparation_unconfirmed', 'raw_error_withheld': True,
                          'automatic_retry': False, 'services_started': 0}))
        raise SystemExit(1)
