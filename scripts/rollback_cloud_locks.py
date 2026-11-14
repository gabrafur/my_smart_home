"""Existing daily lock attestation and own Docker update marker lifecycle."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import stat


def require_daily_caller(root, proc=Path('/proc')):
    lock = root/'.daily-maintenance.lock'
    info = lock.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('daily_lock_metadata_invalid')
    parents = set()
    current = os.getppid()
    caller = False
    for _ in range(24):
        if current <= 1 or current in parents:
            break
        parents.add(current)
        values = (proc/str(current)/'cmdline').read_bytes()[:16384].split(b'\0')
        words = [value.decode(errors='replace') for value in values if value]
        if str(root/'scripts/process-update-stage-request.sh') in words and 'offsite-backup' in words:
            caller = True
        status = (proc/str(current)/'stat').read_text()
        current = int(status[status.rfind(')')+2:].split()[1])
    if not caller:
        raise ValueError('existing_offsite_caller_required')
    inode = str(info.st_ino)
    for line in (proc/'locks').read_text().splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[1:4] == ['FLOCK', 'ADVISORY', 'WRITE'] and int(parts[4]) in parents and parts[5].rsplit(':', 1)[-1] == inode:
            device = parts[5].split(':')
            if int(device[0], 16) == os.major(info.st_dev) and int(device[1], 16) == os.minor(info.st_dev):
                return
    raise ValueError('existing_daily_lock_not_held_by_caller')


@contextmanager
def docker_marker(root):
    path = root/'.docker-auto-update.lock'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    payload = (str(os.getpid())+'\n').encode()
    try:
        os.write(fd, payload)
        os.fsync(fd)
        before = os.fstat(fd)
    except BaseException:
        os.close(fd)
        raise
    os.close(fd)
    try:
        yield
    finally:
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_size) != (before.st_dev, before.st_ino, len(payload)) or path.read_bytes() != payload:
            raise ValueError('docker_marker_changed_preserve_third_party')
        path.unlink()
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
