#!/usr/bin/env python3
"""Fixed main publication/observation; metadata receipt, never a backup-cycle rewrite."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SHA = re.compile(r'^[a-f0-9]{40}$')
SSH = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10'


def command(args, *, root=ROOT, env=None):
    result = subprocess.run(args, cwd=root, env=env, capture_output=True, timeout=30, check=False)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise RuntimeError('fixed_read_failed')
    return result.stdout.decode('utf8').strip()


def verified_head(root=ROOT):
    if command(['git', 'branch', '--show-current'], root=root) != 'main':
        raise RuntimeError('main_required')
    if command(['git', 'status', '--porcelain', '--untracked-files=all'], root=root):
        raise RuntimeError('clean_checkout_required')
    head = command(['git', 'rev-parse', 'HEAD'], root=root)
    if not SHA.fullmatch(head):
        raise RuntimeError('invalid_local_identity')
    env = dict(os.environ)
    env.setdefault('GIT_SSH_COMMAND', SSH)
    remote = command(['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'], root=root, env=env)
    if remote != head + '\trefs/heads/main':
        raise RuntimeError('remote_main_differs')
    if command(['git', 'rev-parse', 'HEAD'], root=root) != head or command(['git', 'status', '--porcelain', '--untracked-files=all'], root=root):
        raise RuntimeError('checkout_changed')
    return head


def hacs_failure(log):
    """Require exact diagnostic tokens in a bounded, completed failed cycle."""
    required = {
        '- docs/DEPENDENCY_PROVENANCE.en.md:31: referenced path is missing or untracked: homeassistant/custom_components/hacs/',
        '- docs/DEPENDENCY_PROVENANCE.md:33: referenced path is missing or untracked: homeassistant/custom_components/hacs/',
        '- docs/i18n-manifest.json: classified path is outside human documentation scope: homeassistant/custom_components/hacs/validate/README.md',
        '- missing tracked i18n document: homeassistant/custom_components/hacs/validate/README.md',
    }
    # Line numbers may change between documentation revisions, but paths cannot.
    def normalize(line):
        return re.sub(r'(?<=\.md):\d+:', ':LINE:', line)
    required = {normalize(x) for x in required}
    cycle = None
    found = None
    for line in log.splitlines():
        if re.fullmatch(r'\[[^\]]+\] backup started', line):
            cycle = set()
        elif cycle is not None:
            cycle.add(normalize(line))
            match = re.fullmatch(r'\[([^\]]+)\] backup failed: could not push origin/main reason=validation_failed', line)
            if match:
                if required <= cycle:
                    when = datetime.fromisoformat(match[1].replace('Z', '+00:00'))
                    if when.utcoffset() is None:
                        raise RuntimeError('failure_time_unknown')
                    found = when.astimezone(timezone.utc).isoformat()
                cycle = None
    if found is None:
        raise RuntimeError('exact_hacs_failure_not_in_log')
    return found


@contextmanager
def locked(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def record(origin, correction=False, root=ROOT):
    if origin not in ('interactive', 'worker'):
        raise RuntimeError('invalid_origin')
    with locked(root / '.git-publication-evidence.lock'):
        head = verified_head(root)
        failure_at = 'none'
        path = root / '.git-backup.log'
        fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise RuntimeError('unsafe_existing_log')
            os.lseek(fd, max(0, info.st_size - 131072), os.SEEK_SET)
            log = os.read(fd, 131072).decode('utf8', errors='replace')
            if info.st_size > 131072:
                log = log.split('\n', 1)[-1]
            if correction:
                failure_at = hacs_failure(log)
                # Validate current committed docs, not merely an operator assertion.
                command(['node', 'scripts/docs-check.mjs'], root=root)
                if verified_head(root) != head:
                    raise RuntimeError('verification_changed')
            now = datetime.now(timezone.utc).isoformat(timespec='seconds')
            if failure_at != 'none' and datetime.fromisoformat(failure_at) >= datetime.fromisoformat(now):
                raise RuntimeError('failure_chronology_invalid')
            suffix = f'git publication verified: origin={origin} commit={head} remote_commit={head} correction={"hacs_documentation_references" if correction else "none"} failure_at={failure_at}'
            if any(line.endswith('] ' + suffix) for line in log.splitlines()):
                return {'state': 'existing_receipt_preserved', 'commit': head}
            raw = f'[{now}] {suffix}\n'.encode()
            if os.write(fd, raw) != len(raw):
                raise RuntimeError('receipt_write_uncertain')
            os.fsync(fd)
            return {'state': 'remote_main_verified_receipt_recorded', 'commit': head, 'observed_at': now, 'origin': origin}
        finally:
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['observe', 'worker', 'hacs-correction', 'publish'])
    args = parser.parse_args()
    if args.mode == 'publish':
        # Same residential transaction lock; pre-push validation stays enabled.
        with locked(ROOT / '.daily-maintenance.lock'):
            if command(['git', 'branch', '--show-current']) != 'main' or command(['git', 'status', '--porcelain', '--untracked-files=all']):
                raise RuntimeError('clean_main_required')
            env = dict(os.environ, GIT_SSH_COMMAND=SSH)
            result = subprocess.run(['git', 'push', 'origin', 'main'], cwd=ROOT, env=env, check=False)
            if result.returncode:
                raise RuntimeError('push_not_confirmed_inspect_remote_no_retry')
            return record('interactive')
    return record('worker' if args.mode == 'worker' else 'interactive', correction=args.mode == 'hacs-correction')


if __name__ == '__main__':
    import json
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as exc:
        print(json.dumps({'state': 'unconfirmed', 'reason': str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__, 'automatic_retry': False}))
        raise SystemExit(1)
