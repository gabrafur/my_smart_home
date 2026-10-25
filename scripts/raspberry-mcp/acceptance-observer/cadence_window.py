"""Bounded read-only cadence audit. Never invokes or locks the collector."""
import datetime
import json
import math
import os
from pathlib import Path
import pwd
import re
import resource
import signal
import stat
import time

BASE = Path('/var/lib/raspberry-procmon')
CANDIDATE_START = 1792776152
NAME = re.compile(r'([0-9]{20})-([a-f0-9]{16})\.json')
COUNTERS = ('enumerated', 'records', 'inaccessible', 'vanished', 'invalid', 'pid_reused', 'pid_limit', 'deadline')


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def summarize_sample(sample):
    if sample.get('schema') != 1 or sample.get('source') != 'proc_stat_status_cgroup':
        raise ValueError('invalid_schema')
    if not number(sample.get('observed_at')) or not number(sample.get('monotonic')):
        raise ValueError('invalid_clock')
    if not isinstance(sample.get('boot'), str) or not re.fullmatch('[a-f0-9]{16}', sample['boot']):
        raise ValueError('invalid_boot')
    coverage = sample.get('coverage', {})
    if any(type(coverage.get(k)) is not int or coverage[k] < 0 for k in COUNTERS):
        raise ValueError('invalid_coverage')
    records = sample.get('records')
    if not isinstance(records, list) or len(records) > 4096 or len(records) != coverage['records']:
        raise ValueError('invalid_records')
    return {'at': sample['observed_at'], 'mono': sample['monotonic'], 'boot': sample['boot'],
            'error': sample.get('collection_error') is not None, 'coverage': coverage}


def assess(rows, now, health):
    if not number(now) or now < CANDIDATE_START:
        raise ValueError('clock_before_candidate')
    start = max(CANDIDATE_START, now - 86400)
    rows = sorted(rows, key=lambda r: r['at'])
    previous = [r for r in rows if r['at'] < start]
    selected = ([previous[-1]] if previous else []) + [r for r in rows if r['at'] >= start]
    issues = set()
    if not selected:
        issues.add('no_samples')
    if any(r['at'] > now for r in selected):
        issues.add('future_sample')
    gaps = []
    if selected:
        gaps.extend([max(0, selected[0]['at'] - start), max(0, now - selected[-1]['at'])])
    for a, b in zip(selected, selected[1:]):
        wall, mono = b['at'] - a['at'], b['mono'] - a['mono']
        if wall <= 0 or mono <= 0:
            issues.add('duplicate_or_nonmonotonic')
        if a['boot'] != b['boot']:
            issues.add('boot_changed')
        elif abs(wall - mono) > 2:
            issues.add('clock_discontinuity')
        # A preceding anchor proves a boundary only if this actual interval fits.
        gaps.append(max(wall, mono))
    if gaps and max(gaps) > 60:
        issues.add('sampling_gap_over_60s')
    if any(r['error'] for r in selected):
        issues.add('sample_collection_error')
    health_at = health.get('observed_at')
    if health.get('status') != 'completed':
        issues.add('current_collector_not_completed')
    if not number(health_at) or not 0 <= now - health_at <= 60:
        issues.add('current_health_not_fresh')
    window_rows = [r for r in selected if start <= r['at'] <= now]
    counts = {k: sum(r['coverage'][k] for r in window_rows) for k in COUNTERS}
    partial = sum(any(r['coverage'][k] for k in COUNTERS[2:]) for r in window_rows)
    full_duration = now - start >= 86400
    return {'source': 'fixed_procmon_history_readonly_audit', 'observed_at': now,
            'window_start': start, 'window_end': now, 'window_seconds': now - start,
            'full_24h_elapsed': full_duration, 'samples_in_window': len(window_rows),
            'max_sample_gap_seconds': round(max(gaps), 3) if gaps else None,
            'cadence_60s_proven_for_observed_window': not issues,
            'cadence_24h_proven': full_duration and not issues,
            'partial_samples': partial, 'summed_coverage_counts': counts,
            'issues': sorted(issues), 'whole_goal_accepted': False,
            'coverage': ['history_sample_cadence_only', 'current_health_only',
                         'no_historical_failure_journal', 'not_sustained_collector_cost',
                         'not_events_latency', 'not_PC_off_proof',
                         'transients_between_samples_may_be_missed'],
            'collector_executed': False, 'state_changed': False, 'locks_acquired': False}


def open_dir(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_at(directory, name, uid, mode, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid or
                stat.S_IMODE(before.st_mode) != mode or before.st_nlink != 1 or before.st_size > maximum):
            raise ValueError('unsafe_file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(maximum + 1)
        after = os.fstat(fd)
        if len(raw) > maximum or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('read_changed_or_oversize')
        return json.loads(raw)
    finally:
        os.close(fd)


def read_history(base, uid):
    fd = open_dir(base / 'history')
    try:
        info = os.fstat(fd)
        if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('unsafe_history')
        names = []
        total = 0
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(names) >= 2000 or NAME.fullmatch(entry.name) is None:
                    raise ValueError('history_entry_limit_or_unexpected')
                total += entry.stat(follow_symlinks=False).st_size
                if total > 128 * 1048576:
                    raise ValueError('history_size_limit')
                names.append(entry.name)
        rows = []
        for name in sorted(names):
            row = summarize_sample(read_at(fd, name, uid, 0o600, 1048576))
            match = NAME.fullmatch(name)
            if row['at'] != int(match[1]) or row['boot'] != match[2]:
                raise ValueError('filename_sample_mismatch')
            rows.append(row)
        return rows
    finally:
        os.close(fd)


def main():
    resource.setrlimit(resource.RLIMIT_AS, (96 * 1048576, 96 * 1048576))
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    def timeout(signum, frame):
        raise TimeoutError('bounded_read_timeout')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(15)
    uid = pwd.getpwnam('raspberry-procmon').pw_uid
    rows = read_history(BASE, uid)
    fd = open_dir(BASE / 'public')
    try:
        health = read_at(fd, 'health.json', uid, 0o640, 4096)
    finally:
        os.close(fd)
    print(json.dumps(assess(rows, time.time(), health), allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'read_only': True, 'collection_error': type(error).__name__,
                          'state_changed': False, 'collector_executed': False,
                          'cadence_24h_proven': False, 'automatic_retry': False}))
        raise SystemExit(1)
