#!/usr/bin/env python3
"""Fixed daily continuation. Invoked only by the existing locked offsite stage."""
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import sys

ROOT = Path(__file__).resolve().parent.parent
FILES = ('rollback_cloud_daily.py', 'rollback_cloud_policy.py', 'rollback_cloud_cycle.py',
         'rollback_cloud_backend.py', 'rollback_cloud_transport.py', 'rollback_cloud_upload.py',
         'rollback_cloud_worker.py', 'rollback_cloud_verify_archive.py', 'rollback_cloud_locks.py', 'rollback_cloud_local.py')


def policy():
    path = ROOT/'.local-secrets/rollback-cloud-daily.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 16384:
            raise ValueError('private_owner_policy_required')
        value = json.loads(os.read(fd, 16385))
    finally:
        os.close(fd)
    if value.get('enabled') is not True or value.get('revoked') is not False or value.get('maximum_images_per_cycle') not in (1, 2):
        raise ValueError('daily_policy_not_enabled')
    if value.get('maximum_compressed_bytes_per_24h') != 2 * 1024**3 or value.get('maximum_images_per_24h') != 2:
        raise ValueError('rolling_budget_policy_invalid')
    if type(value.get('protected_image_ids')) is not list or not all(isinstance(x, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', x) for x in value['protected_image_ids']):
        raise ValueError('protected_runtime_identity_invalid')
    if value.get('local_staging_minimum_free_bytes') != 6 * 1024**3 or value.get('local_staging_floor_free_bytes') != 4 * 1024**3:
        raise ValueError('local_staging_policy_invalid')
    for name in FILES:
        if hashlib.sha256((ROOT/'scripts'/name).read_bytes()).hexdigest() != value['source_pins'][name]:
            raise ValueError('daily_source_changed')
    return value, hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def dry_run(backend):
    from rollback_cloud_policy import select_images
    from rollback_cloud_cycle import Ledger
    backend.ensure_policy()
    resources = backend.resources()
    images, protected = backend.inventory()
    backend.ensure_policy()
    candidates = select_images(images, protected, __import__('time').time(), maximum_images=2)
    directory = ROOT/'.local-state/rollback-cloud-daily'
    history = Ledger(directory, create=False).history() if directory.exists() else []
    unresolved = sum(row.get('state') not in ('retired', 'preserved') for row in history)
    return {'state': 'dry_run', 'resources': resources,
            'candidate_image_ids': [row['image_id'] for row in candidates],
            'candidate_count': len(candidates), 'protected_count': len(protected),
            'unresolved_receipts': unresolved, 'pc_probe': 'not_requested',
            'maximum_images_per_24h': 2, 'maximum_compressed_bytes_per_24h': 2 * 1024**3,
            'exports': 0, 'uploads': 0, 'retired': 0}


def main(arguments=None, backend_factory=None, policy_loader=policy):
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments not in ([], ['--dry-run']):
        raise ValueError('only_optional_dry_run_supported')
    value, expected_policy = policy_loader()
    sys.path.insert(0, str(ROOT/"scripts"))
    def check_policy():
        current, digest = policy_loader()
        if digest != expected_policy:
            raise ValueError('policy_changed_or_revoked')
    if backend_factory is None:
        from rollback_cloud_backend import Backend
        import rollback_cloud_transport
        if rollback_cloud_transport.POLICY != value:
            raise ValueError("policy_changed_during_load")
        backend_factory = Backend
    backend = backend_factory(check_policy)
    if arguments == ['--dry-run']:
        return dry_run(backend)
    from rollback_cloud_cycle import Ledger, run_cycle
    from rollback_cloud_locks import require_daily_caller, docker_marker
    require_daily_caller(ROOT)
    ledger = Ledger(ROOT/'.local-state/rollback-cloud-daily')
    fd = os.open(ledger.directory/'lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'deferred', 'reason': 'daily_cycle_running', 'retired': 0}
        with docker_marker(ROOT):
            return run_cycle(backend, ledger, maximum_images=value['maximum_images_per_cycle'])
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        result = main()
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and __import__('re').fullmatch(r'[a-z][a-z0-9_]{0,95}', str(error)) else 'unexpected_failure_inspect_receipt'
        result = {'state': 'blocked', 'reason': reason, 'exception_kind': type(error).__name__, 'retired': 0, 'automatic_retry': False}
    print(json.dumps(result, separators=(',', ':')))
