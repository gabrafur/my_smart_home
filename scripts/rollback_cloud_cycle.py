"""Daily offsite continuation using the existing owner-operated transport.

Call under the existing daily maintenance lock. The backend owns the exact
Docker, PC SSH/SFTP and HA AppFolder operations, with no caller command input.
"""
import json
import math
import os
import stat
import time
from pathlib import Path
from rollback_cloud_policy import operation_id, select_images, verify_proofs

MAX_COMPRESSED_BYTES = 2 * 1024**3


class Ledger:
    def __init__(self, directory, create=True):
        self.directory = Path(directory)
        if create:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('private_ledger_required')

    def read(self, identity):
        file = self.directory / (identity + '.json')
        try:
            fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_uid != os.getuid():
                raise ValueError('receipt_metadata_invalid')
            return json.loads(os.read(fd, 65537))
        finally:
            os.close(fd)

    def history(self):
        files = list(self.directory.glob('*.json'))
        if len(files) > 2048 or list(self.directory.glob('*.next')):
            raise ValueError('ledger_requires_reconciliation')
        rows = []
        for file in files:
            if len(file.stem) != 64 or any(c not in '0123456789abcdef' for c in file.stem):
                raise ValueError('ledger_identity_invalid')
            rows.append(self.read(file.stem))
        return rows

    def write(self, identity, row):
        file = self.directory / (identity + '.json')
        temporary = self.directory / (identity + '.next')
        raw = (json.dumps(row, sort_keys=True) + '\n').encode()
        if len(raw) > 65536:
            raise ValueError('receipt_size_limit')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            pending = memoryview(raw)
            while pending:
                count = os.write(fd, pending)
                if count <= 0:
                    raise OSError("receipt_write_failed")
                pending = pending[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, file)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def run_cycle(backend, ledger, now=None, maximum_images=2):
    now = time.time() if now is None else now
    backend.ensure_policy()
    history = ledger.history()
    unfinished = [r for r in history if r.get('state') not in ('retired', 'preserved')]
    if unfinished:
        return {'state': 'blocked', 'reason': 'global_unresolved_receipt', 'retired': 0, 'automatic_retry': False}
    for record in history:
        stamp = record.get('started_at')
        size = record.get('archive', {}).get('bytes')
        if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp > now + 60 or type(size) is not int or size <= 0:
            raise ValueError('historical_budget_metadata_invalid')
    recent = [r for r in history if r['started_at'] >= now - 86400]
    day_count = len(recent)
    day_bytes = sum(r.get('archive', {}).get('bytes', 0) for r in recent)
    if day_count >= 2 or day_bytes >= MAX_COMPRESSED_BYTES:
        return {'state': 'deferred', 'reason': 'rolling_24h_quota', 'retired': 0}
    resources = backend.resources()
    if resources['available_memory_bytes'] < 2 * 1024**3 or resources['load1'] > 4:
        return {'state': 'deferred', 'reason': 'resource_pressure', 'retired': 0}
    if not backend.staging_available():
        return {'state': 'deferred', 'reason': 'staging_unavailable', 'retired': 0}
    images, protected = backend.inventory()
    rows = select_images(images, protected, now, maximum_images=min(maximum_images, 2 - day_count))
    used = 0
    retired = 0
    blocked = []
    for image in rows:
        identity = operation_id(image['image_id'])
        previous = ledger.read(identity)
        if previous:
            if previous['state'] != 'retired':
                blocked.append({'operation_id': identity, 'reason': 'observe_existing_receipt_no_replay'})
            continue
        if used + day_bytes >= MAX_COMPRESSED_BYTES:
            break
        backend.ensure_policy()
        row = {'operation_id': identity, 'image_id': image['image_id'], 'started_at': now,
               'state': 'export_intent', 'automatic_retry': False}
        ledger.write(identity, row)
        try:
            backend.ensure_policy()
            archive = backend.export(image, MAX_COMPRESSED_BYTES - day_bytes - used)
            used += archive['bytes']
            if used + day_bytes > MAX_COMPRESSED_BYTES:
                raise ValueError('compressed_cycle_quota_exceeded')
            row.update(state='exported', archive=archive)
            ledger.write(identity, row)
            format_proof = backend.verify_archive(archive)
            row.update(state='cloud_intent', format_proof=format_proof)
            ledger.write(identity, row)
            backend.ensure_policy()
            cloud = backend.upload_and_verify(archive)
            row.update(state='cloud_verified', cloud=cloud)
            row['proof_sha256'] = verify_proofs(image['image_id'], archive, cloud, format_proof)
            ledger.write(identity, row)
            if not backend.still_retirable(image):
                row.update(state='preserved', reason='references_or_identity_changed')
                ledger.write(identity, row)
                continue
            backend.ensure_policy()
            row['state'] = 'retire_intent'
            ledger.write(identity, row)
            backend.ensure_policy()
            backend.retire(image['image_id'])
            if backend.image_present(image['image_id']):
                raise ValueError('image_retirement_unconfirmed')
            row.update(state='retired', completed_at=time.time())
            ledger.write(identity, row)
            if 'local_file' in archive:
                backend.ensure_policy()
                backend.cleanup_archive(archive, row)
                row['local_staging_removed'] = True
                ledger.write(identity, row)
            retired += 1
        except Exception as error:
            row.update(state='uncertain', failed_stage=row['state'], exception_kind=type(error).__name__)
            ledger.write(identity, row)
            blocked.append({'operation_id': identity, 'reason': 'observe_existing_receipt_no_replay'})
            break
    return {'state': 'observed', 'retired': retired, 'compressed_bytes': used,
            'blocked': blocked, 'automatic_retry': False}
