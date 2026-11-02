"""Fixed uninstalled Root bootstrap; expected policy SHA pinned in systemd unit.

Never accepts paths, commands, URLs or overrides. Not an installer.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path('/usr/local/lib/raspberry-nodered-admin')
NAMES = ('engine.py', 'coordination.py', 'gateway.py', 'fixed_transport.py', 'bootstrap.py', 'native_guard.py')


def read(path, mode, bound):
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            assert info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        assert stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
        assert stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1 and 0 < info.st_size <= bound
        body = os.read(fd, bound + 1)
        after = os.fstat(fd)
        assert len(body) == info.st_size and (info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns) == (after.st_dev, after.st_ino,
            after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        return body
    finally:
        os.close(fd)


def run(policy_sha256):
    assert os.geteuid() == 0 and os.getegid() == 0 and re.fullmatch('[a-f0-9]{64}', policy_sha256)
    policy_raw = read(ROOT / 'policy.json', 0o600, 262144)
    assert hashlib.sha256(policy_raw).hexdigest() == policy_sha256
    policy = json.loads(policy_raw)
    assert set(policy['sources']) == set(NAMES)
    sources = {}
    for name in NAMES:
        source = read(ROOT / name, 0o644, 1048576)
        assert hashlib.sha256(source).hexdigest() == policy['sources'][name]
        sources[name] = source
    # Execute the exact verified bytes; no import path, editable checkout, or
    # dynamically chosen module can replace a checked dependency.
    for name in ('engine', 'fixed_transport', 'coordination', 'native_guard', 'gateway'):
        spec = importlib.util.spec_from_loader(name, loader=None)
        module = importlib.util.module_from_spec(spec)
        module.__file__ = str(ROOT / (name + '.py'))
        sys.modules[name] = module
        exec(compile(sources[name + '.py'], module.__file__, 'exec'), module.__dict__)
        module.__verified_source_sha256__ = hashlib.sha256(sources[name + '.py']).hexdigest()
    sys.modules['gateway'].serve_one()


if __name__ == '__main__':
    try:
        assert len(sys.argv) == 2
        run(sys.argv[1])
    except Exception:
        # StandardOutput=socket. Never include underlying exceptions or paths.
        os.write(1, b'{"ok":false,"error":"nodered_admin_bootstrap_unconfirmed"}\n')
        raise SystemExit(1)
