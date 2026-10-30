"""Bounded metadata-only Storage Health supplement. No cleanup or shell API."""
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import heapq
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import time

REPO = Path('/mnt/data/docker')
REPORT = REPO / 'homeassistant/storage-maintenance-status.json'
OUTPUT = REPO / '.local-state/storage-maintenance/observation.json'
OWNER_HOME = Path(pwd.getpwuid(1001).pw_dir)
ROOTS = {
    'recorder': (REPO/'homeassistant/home-assistant_v2.db',
                 REPO/'homeassistant/home-assistant_v2.db-wal',
                 REPO/'homeassistant/home-assistant_v2.db-shm'),
    'backups': (REPO/'homeassistant/backups',),
    'snapshots': (REPO/'homeassistant/backups',),
    'recovery_workspace': (Path('/var/lib/raspberry-seven-service-recovery'),),
    'logs': (Path('/var/log'), REPO/'zigbee2mqtt/log', REPO/'mosquitto/log'),
    'tools': (OWNER_HOME/'.vscode-server', OWNER_HOME/'.cursor-server',
              OWNER_HOME/'.local/lib/node_modules/@openai/codex'),
    'caches': (OWNER_HOME/'.npm', OWNER_HOME/'.cache/pip'),
    'checkout': (REPO,),
}
FIELDS = {
    'docker': 'docker_logical_bytes', 'logs': 'known_logs_bytes',
    'caches': 'allowlisted_user_caches_logical_bytes', 'checkout': 'repository_bytes',
    'tools': 'vscode_server_logical_bytes', 'recorder': 'home_assistant_recorder_logical_bytes',
    'backups': 'home_assistant_backup_archives_logical_bytes',
    'snapshots': 'home_assistant_manual_snapshots_logical_bytes',
}
MAX_ENTRIES = 16000
MAX_SECONDS = 4.0
MAX_OUTPUT = 16384


def utc(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def envelope(source, observed, now, data, error=None, state='observed', coverage=()):
    age = now-observed if observed is not None else None
    if age is not None and age < 0:
        error, state, age = 'source_clock_ahead', 'unknown', None
    return {'source': source, 'observed_at': utc(observed) if observed is not None else None,
            'age_seconds': round(age, 3) if age is not None else None,
            'collection_error': error, 'state': state, 'data': data, 'coverage': list(coverage)}


def number(value):
    return value if type(value) is int and 0 <= value <= 2**63-1 else None


def legacy_report(path=REPORT, now=None):
    now = time.time() if now is None else now
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_mode & 0o022 or s.st_size > 16384:
                raise ValueError('invalid_report_metadata')
            v = json.loads(os.read(fd, 16385))
        finally:
            os.close(fd)
        observed = datetime.fromisoformat(v['last_maintenance_at'].replace('Z', '+00:00'))
        if observed.tzinfo is None:
            raise ValueError('invalid_report_clock')
        rows = {key: number(v.get(field)) for key, field in FIELDS.items()}
        data = {'logical_bytes_by_category': rows,
                'available_bytes': number(v.get('filesystem_free_bytes')),
                'total_bytes': number(v.get('filesystem_total_bytes')),
                'deleted_open_bytes': number(v.get('deleted_open_bytes')),
                'deleted_open_count': number(v.get('deleted_open_count')),
                'deleted_open_scan_complete': v.get('deleted_open_scan_complete') is True}
        return envelope('existing_Storage_Health_report', observed.timestamp(), now, data,
                        state='stale' if now-observed.timestamp() > 300 else 'observed',
                        coverage=['retained_historical_point_not_current_measurement',
                                  'overlapping_categories_not_additive',
                                  'legacy_repository_metric_may_use_allocated_bytes',
                                  'incomplete_deleted_open_scan_is_not_zero_proof'])
    except FileNotFoundError:
        error = 'source_missing'
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        error = 'source_invalid_or_unavailable'
    return envelope('existing_Storage_Health_report', None, now, None, error, 'unknown')


def measure(roots, deadline, remaining, category, clock=time.monotonic):
    """Internal test injection only; no caller path enters the production CLI."""
    queue = deque(Path(p) for p in roots)
    seen = set()
    logical = allocated = entries = 0
    largest = []
    errors = 0
    complete = True
    while queue:
        if clock() >= deadline or entries >= remaining:
            complete = False
            break
        p = queue.popleft()
        try:
            s = p.lstat()
            entries += 1
            if (s.st_dev, s.st_ino) in seen:
                continue
            seen.add((s.st_dev, s.st_ino))
            if stat.S_ISLNK(s.st_mode):
                continue
            if stat.S_ISREG(s.st_mode):
                if category == 'backups' and p.suffix != '.tar':
                    continue
                if category == 'snapshots' and p.suffix != '.db':
                    continue
                logical += s.st_size
                allocated += s.st_blocks*512
                token = hashlib.sha256(f'{s.st_dev}:{s.st_ino}'.encode()).hexdigest()[:24]
                heapq.heappush(largest, (s.st_size, token))
                if len(largest) > 5:
                    heapq.heappop(largest)
            elif stat.S_ISDIR(s.st_mode):
                if category in ('backups', 'snapshots') and p not in roots:
                    continue
                with os.scandir(p) as children:
                    for child in children:
                        if clock() >= deadline or len(queue)+entries >= remaining:
                            complete = False
                            break
                        info = child.stat(follow_symlinks=False)
                        if info.st_dev == s.st_dev:
                            queue.append(Path(child.path))
                        else:
                            complete = False
        except FileNotFoundError:
            # A disappearing optional root is absent, not an invented zero sample.
            errors += 1
        except OSError:
            errors += 1
            complete = False
    return {'logical_bytes_lower_bound': logical, 'allocated_bytes_lower_bound': allocated,
            'complete': complete and not errors and not queue, 'metadata_entries': entries,
            'inaccessible_or_missing_entries': errors,
            'largest_observed_files': [{'item_id': token, 'logical_bytes': size}
                                       for size, token in sorted(largest, reverse=True)]}


def deleted_open(deadline, proc=Path('/proc'), maximum=4096):
    seen = set()
    count = logical = allocated = checked = inaccessible = 0
    complete = True
    try:
        with os.scandir(proc) as processes:
            for process in processes:
                if not process.name.isdecimal():
                    continue
                if time.monotonic() >= deadline or checked >= maximum:
                    complete = False
                    break
                try:
                    with os.scandir(Path(process.path)/'fd') as files:
                        for entry in files:
                            if time.monotonic() >= deadline or checked >= maximum:
                                complete = False
                                break
                            checked += 1
                            if not os.readlink(entry.path).endswith(' (deleted)'):
                                continue
                            s = os.stat(entry.path)
                            if not stat.S_ISREG(s.st_mode) or (s.st_dev, s.st_ino) in seen:
                                continue
                            seen.add((s.st_dev, s.st_ino))
                            count += 1
                            logical += s.st_size
                            allocated += s.st_blocks*512
                except FileNotFoundError:
                    continue  # Process exit is not permission to infer a zero scan.
                except OSError:
                    inaccessible += 1
                    complete = False
    except OSError:
        complete = False
        inaccessible += 1
    return {'count_lower_bound': count, 'logical_bytes_lower_bound': logical,
            'allocated_bytes_lower_bound': allocated, 'complete': complete,
            'checked_descriptors': checked, 'inaccessible_processes': inaccessible}


def docker_usage(now):
    """One fixed aggregate query. Never request names, inspect payloads or prune."""
    try:
        p = subprocess.run(['/usr/bin/docker', 'system', 'df', '--format', '{{json .}}'],
                           capture_output=True, timeout=1.5,
                           env={'PATH': '/usr/bin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock'})
        if p.returncode or len(p.stdout) > 8192:
            raise ValueError('docker_aggregate_unavailable')
        aliases = {'Images': 'images', 'Containers': 'containers', 'Local Volumes': 'volumes',
                   'Build Cache': 'build_cache'}
        rows = []
        for line in p.stdout.splitlines():
            row = json.loads(line)
            if row.get('Type') not in aliases:
                raise ValueError('docker_aggregate_schema_invalid')
            value = row.get('Size')
            if not isinstance(value, str) or len(value) > 32:
                raise ValueError('docker_aggregate_size_invalid')
            factors = {'B': 1, 'kB': 1000, 'MB': 10**6, 'GB': 10**9, 'TB': 10**12}
            unit = next((u for u in sorted(factors, key=len, reverse=True) if value.endswith(u)), None)
            size = int(Decimal(value[:-len(unit)])*factors[unit]) if unit else None
            if number(size) is None:
                raise ValueError('docker_aggregate_size_invalid')
            rows.append({'kind': aliases[row['Type']], 'logical_bytes': size,
                         'cleanup_allowed': False})
        if len(rows) != 4 or len({r['kind'] for r in rows}) != 4:
            raise ValueError('docker_aggregate_incomplete')
        return envelope('fixed_Docker_system_df_aggregate', now, now, rows,
                        coverage=['logical_shared_bytes_not_additive', 'volumes_and_rollback_images_protected'])
    except (OSError, ValueError, TypeError, InvalidOperation, subprocess.SubprocessError):
        return envelope('fixed_Docker_system_df_aggregate', None, now, None,
                        'docker_aggregate_unavailable', 'unknown')


def growth(previous, current):
    """Compare only complete samples with the same fixed source and filesystem."""
    try:
        before = datetime.fromisoformat(previous['observed_at']).timestamp()
        after = datetime.fromisoformat(current['observed_at']).timestamp()
        a, b = previous['filesystem']['data'], current['filesystem']['data']
        if not 0 < after-before <= 86400 or a['device_id'] != b['device_id']:
            raise ValueError('incompatible_sample_identity_or_clock')
        for row in (a, b):
            if any(number(row[k]) is None for k in ('available_bytes', 'used_bytes', 'device_id')):
                raise ValueError('invalid_filesystem_sample')
        categories = {}
        for name, v in current['categories'].items():
            old = previous['categories'].get(name)
            if not old or old['source'] != v['source'] or not old['data']['complete'] or not v['data']['complete']:
                continue
            key = 'logical_bytes_lower_bound'
            if number(old['data'][key]) is not None and number(v['data'][key]) is not None:
                categories[name] = v['data'][key]-old['data'][key]
        return {'state': 'observed', 'collection_error': None,
                'source': 'two_actual_bounded_metadata_samples', 'observed_at': current['observed_at'],
                'age_seconds': 0, 'window_start': previous['observed_at'],
                'interval_seconds': round(after-before, 3),
                'filesystem_used_delta_bytes': b['used_bytes']-a['used_bytes'],
                'available_delta_bytes': b['available_bytes']-a['available_bytes'],
                'complete_category_deltas_bytes': categories,
                'coverage': ['no_growth_inference_from_partial_scans', 'net_change_not_cleanup_attribution']}
    except (TypeError, ValueError, KeyError):
        return {'state': 'unknown', 'collection_error': 'two_compatible_samples_not_available',
                'source': 'two_actual_bounded_metadata_samples', 'observed_at': current['observed_at'],
                'age_seconds': 0, 'coverage': ['no_synthetic_or_backfilled_growth']}


def collect(now=None, roots=None, *, filesystem=REPO, report=REPORT, docker_reader=docker_usage):
    now = time.time() if now is None else now
    roots = ROOTS if roots is None else roots
    started = time.monotonic()
    deadline = started+MAX_SECONDS
    vfs = os.statvfs(filesystem)
    fs = {'total_bytes': vfs.f_blocks*vfs.f_frsize,
          'available_bytes': vfs.f_bavail*vfs.f_frsize,
          'free_bytes_including_reserve': vfs.f_bfree*vfs.f_frsize,
          'used_bytes': (vfs.f_blocks-vfs.f_bfree)*vfs.f_frsize,
          'device_id': os.stat(filesystem).st_dev}
    result = {'schema_version': 1, 'source': 'bounded_Storage_Health_metadata_supplement',
              'observed_at': utc(now),
              'filesystem': envelope('native_statvfs_fixed_checkout_filesystem', now, now, fs,
                                     coverage=['current_filesystem_snapshot_not_category_totals']),
              'legacy_report': legacy_report(path=report, now=now), 'categories': {},
              'coverage': ['read_only_metadata_no_file_contents_or_names',
                           'bounded_scan_partial_results_are_lower_bounds',
                           'categories_overlap_do_not_sum', 'regular_file_bytes_only',
                           'no_cleanup_or_service_calls'],
              'cleanup_enabled': False}
    result['docker'] = docker_reader(now)
    result['deleted_open'] = envelope('bounded_proc_fd_metadata', now, now,
                                     deleted_open(min(deadline, time.monotonic()+1)),
                                     coverage=['no_names_PIDs_or_contents', 'deduplicated_device_inode'])
    if not result['deleted_open']['data']['complete']:
        result['deleted_open']['state'] = 'partial'
        result['deleted_open']['collection_error'] = 'bounded_or_incomplete_scan'
    remaining = MAX_ENTRIES
    for index, (category, paths) in enumerate(roots.items()):
        quota = remaining if index == len(roots)-1 else min(remaining, 4000)
        row = measure(paths, deadline, quota, category)
        remaining -= row['metadata_entries']
        result['categories'][category] = envelope(
            'fixed_path_metadata_scan', now, now, row,
            None if row['complete'] else 'bounded_or_incomplete_scan',
            'observed' if row['complete'] else 'partial',
            ['no_names_or_contents', 'logical_and_allocated_bytes_separate', 'no_mount_crossing'])
    result['scan_elapsed_seconds'] = round(time.monotonic()-started, 3)
    result['metadata_entries'] = MAX_ENTRIES-remaining
    result.update(age_seconds=0, collection_error=None, state='observed')
    return result


def main():
    import sys
    if sys.argv[1:] != ['observe']:
        raise SystemExit('fixed_observe_action_only')
    lock = os.open(OUTPUT.with_suffix('.lock'), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = None
    try:
        old = os.open(OUTPUT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            s = os.fstat(old)
            if stat.S_ISREG(s.st_mode) and s.st_size <= MAX_OUTPUT:
                previous = json.loads(os.read(old, MAX_OUTPUT+1))
        finally:
            os.close(old)
    except (FileNotFoundError, ValueError):
        pass
    result = collect()
    result['growth'] = growth(previous, result)
    encoded = (json.dumps(result, sort_keys=True)+'\n').encode()
    if len(encoded) > MAX_OUTPUT:
        raise SystemExit('bounded_observation_output_exceeded')
    target = OUTPUT.with_name(OUTPUT.name+'.tmp')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, 1001, 1001)
        with os.fdopen(os.dup(fd), 'wb') as out:
            out.write(encoded)
            out.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(target, OUTPUT)
    os.close(lock)
    print(json.dumps({'state': 'metadata_observed_no_cleanup', 'bytes': len(encoded),
                      'entries': result['metadata_entries'], 'elapsed_seconds': result['scan_elapsed_seconds']}))


if __name__ == '__main__':
    main()
