"""Bounded local transient image staging, removed after verified retirement."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import resource
import stat
import subprocess
import time
from rollback_cloud_policy import operation_id, verify_proofs

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT/'.local-state/rollback-cloud-daily/local'
START_FREE_BYTES = 6 * 1024**3
FLOOR_FREE_BYTES = 4 * 1024**3


def free_bytes():
    result = os.statvfs(ROOT)
    return result.f_bavail * result.f_frsize


def identity(info):
    return {name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink', 'st_uid')}


def check_directory(create=False):
    if DIRECTORY.parent.resolve() != DIRECTORY.parent:
        raise ValueError('local_staging_parent_changed')
    if create:
        DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    current = DIRECTORY.lstat()
    if not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) != 0o700:
        raise ValueError('local_staging_directory_invalid')
    if DIRECTORY.resolve() != DIRECTORY:
        raise ValueError('local_staging_path_changed')


def sync_directory():
    fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Writer:
    def __init__(self, fd, maximum_bytes):
        self.fd = fd
        self.maximum_bytes = maximum_bytes
        self.bytes = 0
        self.digest = hashlib.sha256()

    def write(self, data):
        if self.bytes + len(data) > self.maximum_bytes:
            raise ValueError('compressed_cycle_quota_exceeded')
        if free_bytes() - len(data) < FLOOR_FREE_BYTES:
            raise ValueError('local_free_space_floor')
        pending = memoryview(data)
        while pending:
            count = os.write(self.fd, pending)
            if count <= 0:
                raise OSError('archive_write_failed')
            self.digest.update(pending[:count])
            self.bytes += count
            pending = pending[count:]
        return len(data)

    def flush(self):
        os.fsync(self.fd)


def export_local(image_id, maximum_bytes):
    if free_bytes() < START_FREE_BYTES:
        raise ValueError('local_staging_space_insufficient')
    check_directory(create=True)
    image = image_id.removeprefix('sha256:')
    if len(image) != 64 or any(char not in '0123456789abcdef' for char in image):
        raise ValueError('image_identity_invalid')
    path = DIRECTORY/(image+'.docker.tar.gz')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    writer = Writer(fd, maximum_bytes)
    process = None
    raw = 0
    started = time.monotonic()
    try:
        process = subprocess.Popen(['nice', '-n', '19', 'ionice', '-c', '3', 'docker', 'image', 'save', image_id],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with gzip.GzipFile(filename='', fileobj=writer, mode='wb', compresslevel=1, mtime=0) as packed:
            while chunk := process.stdout.read(256 * 1024):
                packed.write(chunk)
                raw += len(chunk)
                pause = raw / (16 * 1024**2) - (time.monotonic() - started)
                if pause > 0:
                    time.sleep(pause)
        if process.wait(timeout=30) != 0:
            raise ValueError('docker_export_failed')
        os.fsync(fd)
        info = os.fstat(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        while chunk := os.read(fd, 256 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != writer.digest.hexdigest() or info.st_size != writer.bytes:
            raise ValueError('local_archive_hash_mismatch')
        sync_directory()
        return {'state': 'local_archive_hash_verified', 'image_id': image,
                'local_file': str(path), 'local_identity': identity(info),
                'bytes': writer.bytes, 'sha256': digest.hexdigest(),
                'raw_tar_bytes': raw, 'at': time.time()}
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        if process is not None and process.stdout is not None:
            process.stdout.close()
        os.close(fd)


def open_verified_archive(row):
    check_directory()
    path = Path(row['local_file'])
    if path.parent != DIRECTORY or path.name != row['image_id']+'.docker.tar.gz':
        raise ValueError('local_archive_outside_own_directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or identity(info) != row['local_identity']:
            raise ValueError('local_archive_identity_changed')
        digest = hashlib.sha256()
        while chunk := os.read(fd, 256 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != row['sha256'] or info.st_size != row['bytes']:
            raise ValueError('local_archive_content_changed')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def limits():
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024**2, 256 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (300, 300))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def verify_local(row):
    fd = open_verified_archive(row)
    os.close(fd)
    result = subprocess.run(['nice', '-n', '19', 'ionice', '-c', '3', '/usr/bin/python3', '-I', '-S', '-B',
                             str(Path(__file__).with_name('rollback_cloud_verify_archive.py')),
                             row['local_file'], row['image_id'], str(DIRECTORY)],
                            capture_output=True, timeout=600, preexec_fn=limits)
    if result.returncode != 0 or len(result.stdout) > 16384:
        raise ValueError('local_archive_format_unverified')
    return json.loads(result.stdout)


def cleanup_local(row, receipt):
    image_id = 'sha256:'+row['image_id']
    if receipt.get('state') != 'retired' or receipt.get('archive') != row:
        raise ValueError('durable_retirement_required')
    proof = verify_proofs(image_id, row, receipt['cloud'], receipt['format_proof'])
    if proof != receipt.get('proof_sha256'):
        raise ValueError('retirement_proof_changed')
    from rollback_cloud_cycle import Ledger
    stored = Ledger(DIRECTORY.parent, create=False).read(operation_id(image_id))
    if stored != receipt:
        raise ValueError('retirement_receipt_not_durable')
    fd = open_verified_archive(row)
    try:
        if identity(Path(row['local_file']).lstat()) != row['local_identity']:
            raise ValueError('local_archive_changed_before_cleanup')
        os.unlink(row['local_file'])
        sync_directory()
    finally:
        os.close(fd)
