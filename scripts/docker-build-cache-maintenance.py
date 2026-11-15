#!/usr/bin/env python3
"""Bounded, owner-authorized cache-only housekeeping; never images or volumes.

The Engine supplies exact timestamps/bytes; buildx independently corroborates
record identity, immutability and eligibility. Every mutation uses an anchored
allowlist of record IDs, never an unfiltered prune. Unknown dispatch is terminal
until an operator reconciles its durable receipt. No caller-supplied paths.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.local-state/docker-build-cache-maintenance'
MAX_RECORDS = 32
MAX_BYTES = 2_000_000_000
MIN_AGE = 30 * 86400
INTERVAL = 86400
LOCK_WAIT = 25.0
MAX_OUTPUT = 2 * 1024 * 1024
ID = re.compile(r'^[a-z0-9]{16,64}$')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'buildx', '--builder', 'default']


class Refused(Exception):
    pass


class DeferredBeforeDispatch(Refused):
    """Lock admission failed before run() or any Docker mutation."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp_unknown')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp_without_timezone')
    return parsed.timestamp()


def select(engine, cli, now):
    """Only metadata: descriptions, commands and repository names are discarded."""
    if not isinstance(engine, list) or not isinstance(cli, list) or len(engine) > 2048 or len(cli) > 2048:
        raise Refused('inventory_invalid')
    corroborated = {row.get('ID'): row for row in cli}
    if len(corroborated) != len(cli) or len({r.get('ID') for r in engine}) != len(engine):
        raise Refused('duplicate_inventory_identity')
    rows = []
    for row in engine:
        rid = row.get('ID')
        other = corroborated.get(rid, {})
        if not isinstance(rid, str) or not ID.fullmatch(rid):
            continue
        if row.get('Type') != 'regular' or row.get('InUse') is not False or row.get('Shared') is not False:
            continue
        if other.get('Type') != 'regular' or other.get('Reclaimable') is not True or other.get('Shared') is not False or other.get('Mutable') is not False:
            continue
        size = row.get('Size')
        if type(size) is not int or not 0 < size <= MAX_BYTES:
            continue
        try:
            created, used = timestamp(row.get('CreatedAt')), timestamp(row.get('LastUsedAt'))
        except (ValueError, TypeError, OverflowError):
            continue
        if not 0 < created <= used <= now - MIN_AGE:
            continue
        rows.append({'id': rid, 'bytes': size, 'created_at': row['CreatedAt'], 'last_used_at': row['LastUsedAt'],
                     'reason': 'regular_immutable_private_unused_30_days',
                     'recovery': 'no_undo_rebuild_requires_original_inputs_and_dependencies'})
    picked, total = [], 0
    for row in sorted(rows, key=lambda r: (timestamp(r['last_used_at']), r['id'])):
        if len(picked) >= MAX_RECORDS:
            break
        if total + row['bytes'] <= MAX_BYTES:
            picked.append(row)
            total += row['bytes']
    return without_retained_descendants(picked, cli)


def without_retained_descendants(picked, cli):
    """The builder keeps a record while any other record lists it as a parent.

    Selecting such a record only dispatches a prune that removes nothing, so a
    candidate stays eligible only when every dependent record is selected too.
    Unknown parent metadata keeps the record out of the plan.
    """
    children = {}
    for row in cli:
        parents = row.get('Parents')
        if parents is None:
            parents = []
        if not isinstance(parents, list) or any(not isinstance(p, str) for p in parents):
            raise Refused('parent_metadata_invalid')
        for parent in parents:
            children.setdefault(parent, set()).add(row.get('ID'))
    kept = list(picked)
    while True:
        ids = {row['id'] for row in kept}
        remaining = [row for row in kept if children.get(row['id'], set()) <= ids]
        if len(remaining) == len(kept):
            return remaining
        kept = remaining


class Engine(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect('/var/run/docker.sock')


def engine_inventory():
    connection = Engine('localhost', timeout=10)
    try:
        connection.request('GET', '/system/df?type=build-cache')
        response = connection.getresponse()
        raw = response.read(MAX_OUTPUT + 1)
        if response.status != 200 or len(raw) > MAX_OUTPUT:
            raise Refused('engine_inventory_unavailable')
        data = json.loads(raw)
        if 'BuildCache' not in data:
            raise Refused('build_cache_inventory_missing')
        return data['BuildCache']
    finally:
        connection.close()


def cli_inventory():
    result = subprocess.run(DOCKER + ['du', '--format', 'json'], capture_output=True, timeout=15, check=False)
    if result.returncode or len(result.stdout) > MAX_OUTPUT:
        raise Refused('buildx_inventory_unavailable')
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def inventory(now):
    return select(engine_inventory(), cli_inventory(), now)


def available_bytes():
    s = os.statvfs('/')
    return s.f_bavail * s.f_frsize


def resource_check():
    values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(values['MemAvailable'].split()[0]) < 2 * 1024 * 1024:
        raise Refused('memory_pressure')
    if os.getloadavg()[0] > (os.cpu_count() or 1) * 1.5:
        raise Refused('cpu_pressure')


def atomic_json(path, value):
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise Refused('unsafe_receipt')
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, sort_keys=True, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise Refused('unsafe_or_missing_receipt')
    return json.loads(path.read_text())


@contextmanager
def locks(state=STATE, maintenance_lock=ROOT / '.daily-maintenance.lock', wait=0.0):
    if state.is_symlink():
        raise Refused('unsafe_state_directory')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.stat().st_uid != os.geteuid() or state.stat().st_mode & 0o077:
        raise Refused('state_directory_owner_or_mode')
    held = []
    try:
        # A read-only reconciliation passes no maintenance lock: it must not
        # wait behind unrelated daily workers to answer from the receipt.
        for path in (maintenance_lock, state / 'lock') if maintenance_lock else (state / 'lock',):
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            held.append(fd)
            # The minute workers queue on the maintenance lock at the same
            # second; a single non-blocking attempt lost to them for hours.
            # A short bounded wait takes a turn without holding anything else.
            deadline = time.monotonic() + (wait if path == maintenance_lock else 0.0)
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError as exc:
                    if time.monotonic() >= deadline:
                        raise DeferredBeforeDispatch('maintenance_in_progress') from exc
                    time.sleep(0.25)
        yield
    finally:
        for fd in held:
            os.close(fd)


def prune_args(rows):
    ids = [row['id'] for row in rows]
    if not ids or len(ids) > MAX_RECORDS or any(not ID.fullmatch(i) for i in ids):
        raise Refused('invalid_exact_target_set')
    return DOCKER + ['prune', '--force', '--filter', 'id~=^(' + '|'.join(ids) + ')$', '--filter', 'until=720h']


def plan(rows, now):
    return {'version': 1, 'source': 'docker_engine_exact_metadata_and_buildx', 'observed_at': now,
            'collection_error': None, 'rows': rows, 'candidate_bytes': sum(r['bytes'] for r in rows),
            'limits': {'max_records': MAX_RECORDS, 'max_bytes': MAX_BYTES, 'minimum_age_seconds': MIN_AGE, 'interval_seconds': INTERVAL}}


def run(mode, state=STATE, now=None):
    now = time.time() if now is None else now
    latest = state / 'latest.json'
    previous = read_json(latest) if latest.exists() else None
    if previous and previous['state'] in ('dispatch_intent', 'uncertain'):
        raise Refused('existing_dispatch_requires_reconciliation_no_retry')
    if mode != '--dry-run' and previous and previous.get('dispatched_at') and now - previous['dispatched_at'] < INTERVAL:
        return {'state': 'daily_cooldown', 'next_eligible_at': previous['dispatched_at'] + INTERVAL}
    if mode == '--apply':
        prepared = read_json(state / 'plan.json')
        if now - prepared['observed_at'] > 900 or prepared['observed_at'] > now:
            raise Refused('plan_expired')
        current = inventory(now)
        if prepared['rows'] != current:
            raise Refused('candidate_changed_prepare_again')
    else:
        prepared = plan(inventory(now), now)
        atomic_json(state / 'plan.json', prepared)
    result = {'state': 'dry_run' if mode == '--dry-run' else 'no_candidates', 'plan_sha256': digest(prepared),
              'candidate_count': len(prepared['rows']), 'candidate_bytes': prepared['candidate_bytes'], 'rows': prepared['rows']}
    if mode == '--dry-run' or not prepared['rows']:
        return result
    resource_check()
    # Corroborate the exact set again immediately before recording the intent.
    if prepared['rows'] != inventory(time.time() if now is None else now):
        raise Refused('candidate_changed_before_dispatch')
    operation = uuid.uuid4().hex
    receipt = dict(result, operation_id=operation, state='prepared', before_available_bytes=available_bytes(), observed_at=now)
    receipt.pop('rows')
    path = state / (operation + '.json')
    atomic_json(state / (operation + '.plan.json'), prepared)
    atomic_json(path, receipt)
    receipt.update(state='dispatch_intent', dispatched_at=now)
    atomic_json(path, receipt)
    atomic_json(latest, receipt)  # durable before the single permitted dispatch
    try:
        outcome = subprocess.run(prune_args(prepared['rows']), capture_output=True, timeout=120, check=False)
        if outcome.returncode:
            raise Refused('prune_result_unconfirmed')
        remaining = {row['ID'] for row in engine_inventory()}
        removed = [row['id'] for row in prepared['rows'] if row['id'] not in remaining]
        receipt.update(state='verified', removed_record_ids=removed, removed_record_count=len(removed),
                       after_available_bytes=available_bytes(), completed_at=time.time(),
                       effects='cache_records_only_no_images_volumes_containers_or_services',
                       partial=len(removed) != len(prepared['rows']))
        receipt['filesystem_net_increase_bytes'] = receipt['after_available_bytes'] - receipt['before_available_bytes']
        receipt['space_attribution'] = 'filesystem_delta_may_include_concurrent_activity'
    except Exception as exc:
        receipt.update(state='uncertain', exception_kind=type(exc).__name__, automatic_retry=False)
        atomic_json(path, receipt)
        atomic_json(latest, receipt)
        raise Refused('dispatch_unconfirmed_inspect_same_receipt_no_retry') from exc
    atomic_json(path, receipt)
    atomic_json(latest, receipt)
    return receipt


def unresolved_dispatch(state=STATE):
    """Durable proof of whether a dispatch may have happened without a verdict.

    The intent is written before the single dispatch, so a readable latest
    receipt outside these two states proves that no dispatch is pending. An
    unreadable receipt is treated as unresolved.
    """
    latest = state / 'latest.json'
    if not latest.exists() and not latest.is_symlink():
        return None
    try:
        previous = read_json(latest)
        if previous['state'] in ('dispatch_intent', 'uncertain'):
            return {'operation_id': previous.get('operation_id'), 'receipt_state': previous['state']}
    except Exception:
        return {'operation_id': None, 'receipt_state': 'unreadable'}
    return None


def reason_of(exc):
    return str(exc) if isinstance(exc, Refused) else type(exc).__name__


def execute(mode, state=STATE, runner=None, lock=None):
    """Return (exit status, printable result). Exit statuses are a contract:

    0 done; 75 lock contention before run(); 74 refused before any dispatch
    intent existed (nothing to reconcile); 1 a dispatch needs reconciliation.
    """
    runner = run if runner is None else runner
    if lock is None:
        lock = (lambda: locks(state, None)) if mode == '--reconcile' else (lambda: locks(state, wait=LOCK_WAIT))
    try:
        with lock():
            if mode == '--reconcile':
                pending = unresolved_dispatch(state)
                if pending:
                    return 1, dict(pending, state='unresolved_dispatch', automatic_retry=False)
                return 0, {'state': 'no_unresolved_dispatch', 'dispatched': False}
            try:
                return 0, runner(mode, state)
            except Exception as exc:
                pending = unresolved_dispatch(state)
                if pending:
                    return 1, dict(pending, state='refused', reason=reason_of(exc), automatic_retry=False)
                return 74, {'state': 'refused_before_dispatch', 'reason': reason_of(exc), 'dispatched': False,
                            'automatic_retry': False}
    except DeferredBeforeDispatch as exc:
        return 75, {'state': 'deferred', 'reason': str(exc), 'dispatched': False}
    except Exception as exc:
        return 1, {'state': 'refused', 'reason': reason_of(exc), 'automatic_retry': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    for flag in ('--dry-run', '--apply', '--daily', '--reconcile'):
        group.add_argument(flag, action='store_true')
    args = parser.parse_args()
    mode = ('--dry-run' if args.dry_run else '--apply' if args.apply else
            '--reconcile' if args.reconcile else '--daily')
    status, result = execute(mode)
    print(json.dumps(result, sort_keys=True))
    return status


if __name__ == '__main__':
    raise SystemExit(main())
