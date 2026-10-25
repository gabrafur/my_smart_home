"""Fixed release installer. Root must invoke --apply; --check never writes.

Preserves the existing lease, budgets, authorized IDs, receipts and databases.
Only the MCP tunnel is restarted. No Codex task or household service is started.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

SOURCE = Path(__file__).resolve().parent
ROOT = Path('/usr/local/lib/raspberry-task-control')
FRONT = Path('/var/lib/raspberry-mcp/root/app')
BACKUPS = Path('/var/backups/raspberry-task-control')
POLICY = ROOT / 'policy.json'
BACKEND = ('task_control.py', 'task_store.py', 'task_rpc.cjs', 'task-broker.py', 'thread_catalog.py')
FRONTEND = ('task-server.mjs', 'task-tools.mjs')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check():
    manifest = json.loads((SOURCE / 'release.json').read_text())
    if set(manifest['files']) != {*BACKEND, *FRONTEND}:
        raise ValueError('release_scope_changed')
    for name, expected in manifest['files'].items():
        path = SOURCE / name
        if path.is_symlink() or digest(path) != expected:
            raise ValueError('release_source_changed')
    if POLICY.is_symlink() or digest(POLICY) != manifest['base_policy_sha256']:
        raise ValueError('installed_policy_changed')
    p = json.loads(POLICY.read_text())
    if time.time() >= p['expires_at']:
        raise ValueError('existing_lease_expired_no_extension')
    if p['boot_id'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise ValueError('existing_boot_changed')
    for name, expected in p['source_hashes'].items():
        if (ROOT / name).is_symlink() or digest(ROOT / name) != expected:
            raise ValueError('installed_source_changed')
    for target, expected in p['dependencies'].items():
        if Path(target).is_symlink() or digest(Path(target)) != expected:
            raise ValueError('installed_dependency_changed')
    if digest(FRONT / 'task-server.mjs') != manifest['base_front_sha256']:
        raise ValueError('installed_front_changed')
    return p


def atomic(path, data):
    # The release payload is copied as bytes; it is not imported or executed.
    fd, name = tempfile.mkstemp(prefix='.task-release-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fchmod(f.fileno(), 0o644)
            os.fsync(f.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def restart():
    subprocess.run(['systemctl', 'restart', 'raspberry-mcp-tunnel.service'], check=True, timeout=30)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'raspberry-mcp-tunnel.service',
                    'raspberry-mcp-operations.socket'], check=True, timeout=10)


def apply():
    if os.geteuid() != 0:
        raise ValueError('root_required_for_sealed_code')
    p = check()
    # Read the checked release into memory and verify it again before mutation.
    manifest = json.loads((SOURCE / 'release.json').read_text())
    targets = {ROOT / n: SOURCE / n for n in BACKEND}
    targets.update({FRONT / n: SOURCE / n for n in FRONTEND})
    payload = {dst: src.read_bytes() for dst, src in targets.items()}
    for dst, data in payload.items():
        if hashlib.sha256(data).hexdigest() != manifest['files'][dst.name]:
            raise ValueError('release_source_changed')
    original_policy = POLICY.read_bytes()
    updated = json.loads(original_policy)
    updated['source_hashes'] = {n: manifest['files'][n] for n in BACKEND}
    for name in FRONTEND:
        updated['dependencies'][str(FRONT / name)] = manifest['files'][name]
    payload[POLICY] = (json.dumps(updated, indent=2, sort_keys=True) + '\n').encode()
    # Every non-code policy field is preserved byte-for-value, including expiry.
    for key in p:
        if key not in ('source_hashes', 'dependencies') and p[key] != updated[key]:
            raise ValueError('policy_authorization_changed')
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='release-', dir=BACKUPS))
    originals = {}
    for index, target in enumerate(payload):
        if target.is_symlink():
            raise ValueError('unsafe_install_target')
        if target.exists():
            info = target.stat()
            if info.st_uid != 0 or not stat.S_ISREG(info.st_mode):
                raise ValueError('unsafe_install_target')
            originals[target] = target.read_bytes()
            (backup / str(index)).write_bytes(originals[target])
        else:
            originals[target] = None
    (backup / 'targets.json').write_text(json.dumps([str(p) for p in payload]))
    check()  # Revalidate the installed base immediately before replacement.
    touched = []
    try:
        for target, data in payload.items():
            # Replacement may succeed before directory fsync raises. Include
            # the target in rollback before attempting any part of the write.
            touched.append(target)
            atomic(target, data)
        restart()
        for target, data in payload.items():
            if target.read_bytes() != data:
                raise ValueError('installed_readback_changed')
    except BaseException:
        for target in reversed(touched):
            if originals[target] is None:
                target.unlink(missing_ok=True)
            else:
                atomic(target, originals[target])
        restart()
        raise
    return {'installed': True, 'backup': str(backup), 'lease_extended': False,
            'thread_scope_extended': False, 'mcp_client_validation': 'pending'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.apply == args.check:
        parser.error('choose exactly one of --apply or --check')
    if args.apply:
        print(json.dumps(apply()))
    else:
        check()
        print(json.dumps({'release_valid': True, 'writes': False, 'installation': 'pending'}))
