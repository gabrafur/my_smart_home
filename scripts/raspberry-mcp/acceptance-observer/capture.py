"""Seven fixed, read-only captures. No collector invocation or repair admission."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import pwd
import resource
import re
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/usr/local/lib/raspberry-procmon-acceptance')
STATE = Path('/var/lib/raspberry-procmon-acceptance')
SCHEDULE = ('2026-10-25T04:30:00Z', '2026-10-25T15:20:00Z', '2026-10-25T20:33:00Z', '2026-10-26T11:00:00Z', '2026-10-26T16:00:00Z', '2026-10-26T20:00:00Z', '2026-10-27T23:00:00Z')
RUNTIME_KEYS = ('source', 'rows', 'invalid_telemetry_rows', 'failed_rows',
                'failure_phases', 'failure_reasons', 'observed_span_seconds',
                'requested_window_seconds', 'max_completion_gap_ms',
                'nonmonotonic_pairs', 'max_wall_ms', 'sum_cpu_us',
                'max_peak_rss_bytes', 'latest_observed_at', 'coverage')


def load(name):
    spec = importlib.util.spec_from_file_location('_acceptance_' + name, ROOT/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invocation_correlation(now):
    source = Path('/usr/local/lib/raspberry-procmon-observability/invocation_audit.py')
    info = source.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1
            or info.st_size > 65536 or any(p.is_symlink() for p in source.parents)):
        raise ValueError('unsafe_fixed_invocation_auditor')
    spec = importlib.util.spec_from_file_location('_fixed_invocation_correlation', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.audit(now)


def journal_limits():
    # Journal files are mmap'ed: virtual address allowance differs from RSS.
    # Parent parsing remains at 128 MiB; the fixed reader gets 512 MiB virtual.
    resource.setrlimit(resource.RLIMIT_AS, (512*1048576, 512*1048576))


def runtime_audit(summarize, now):
    # Filter native structured telemetry before applying the journal line cap.
    # Systemd's own messages must not truncate a 24-hour invocation series.
    result = subprocess.run(['/usr/bin/journalctl', '--quiet', '--no-pager',
        '--unit=raspberry-procmon.service', '--since=@'+str(int(now)-90000),
        '--until=@'+str(int(now)), '--grep="source":[[:space:]]*"procmon_runtime_v1"',
        '--output=json', '--output-fields=MESSAGE,_BOOT_ID,__MONOTONIC_TIMESTAMP', '--lines=2048'],
        capture_output=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
        preexec_fn=journal_limits)
    if result.returncode or len(result.stdout) > 2097152 or len(result.stderr) > 65536:
        raise ValueError('bounded_journal_collection_failed')
    rows, boots = [], set()
    lines = result.stdout.splitlines()
    for line in lines:
        envelope = json.loads(line)
        message = envelope.get('MESSAGE')
        if not isinstance(message, str) or len(message) > 768:
            raise ValueError('invalid_telemetry_envelope')
        native_mono = envelope.get('__MONOTONIC_TIMESTAMP')
        if not isinstance(native_mono, str) or not re.fullmatch(r'\d{1,18}', native_mono):
            raise ValueError('missing_native_monotonic_order')
        boot = envelope.get('_BOOT_ID')
        if not isinstance(boot, str) or not re.fullmatch(r'[a-f0-9]{32}', boot):
            raise ValueError('missing_boot_identity')
        boots.add(boot)
        rows.append((int(native_mono), json.loads(message)))
    # grep/tail can return newest first. Use the native journal monotonic key,
    # not the telemetry value under audit, so regressions remain detectable.
    value = summarize([row for _, row in sorted(rows, key=lambda pair: pair[0])], 90000)
    diagnostic = result.stderr.decode('utf8', errors='replace').lower()
    category = ('none' if not diagnostic else 'reader_address_space_insufficient'
        if 'cannot allocate memory' in diagnostic else 'journal_integrity_warning'
        if 'corrupt' in diagnostic or 'truncat' in diagnostic else 'access_scope_warning'
        if 'permission' in diagnostic or 'not seeing' in diagnostic else 'implicit_reverse_order'
        if '--reverse' in diagnostic else 'unclassified_diagnostic')
    safe = {key: value[key] for key in RUNTIME_KEYS}
    safe.update(journal_exit=result.returncode, journal_limit_reached=len(lines) >= 2048,
                stderr_present=bool(result.stderr), distinct_boot_count=len(boots),
                journal_diagnostic_category=category,
                clock_scope='monotonic_span_requires_single_boot', raw_messages_exported=False,
                collector_invoked=False)
    return safe


def combine(cadence, runtime):
    runtime_window = (runtime.get('observed_span_seconds', 0) >= 86400
        and runtime.get('distinct_boot_count') == 1 and runtime.get('nonmonotonic_pairs') == 0
        and runtime.get('invalid_telemetry_rows') == 0 and not runtime.get('journal_limit_reached')
        and runtime.get('journal_exit') == 0
        and runtime.get('journal_diagnostic_category', 'none') in ('none', 'implicit_reverse_order'))
    return {'cadence_24h_proven': cadence.get('cadence_24h_proven') is True,
        'emitted_runtime_24h_window_proven': runtime_window,
        'cadence_and_emitted_runtime_window_proven': cadence.get('cadence_24h_proven') is True and runtime_window,
        'PC_off_proven': False, 'all_event_latency_proven': False,
        'missing_or_killed_invocation_cost_proven': False, 'full_goal_accepted': False}


def atomic(name, data, replace=False):
    fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError('unsafe_report_directory')
        tmp = '.'+name+'.'+str(os.getpid())+'.'+str(time.monotonic_ns())+'.new'
        out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
        try:
            os.fchmod(out, 0o644)
            with os.fdopen(os.dup(out), 'wb') as stream:
                stream.write(data);stream.flush();os.fsync(stream.fileno())
        finally:
            os.close(out)
        if replace:
            os.rename(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
        else:
            # Immutable window: a concurrent or recovered writer cannot replace it.
            os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            os.unlink(tmp, dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    if os.geteuid() != 0 or Path(__file__).absolute() != ROOT/'capture.py' or sys.argv[1:]:
        raise ValueError('fixed_root_capture_required')
    resource.setrlimit(resource.RLIMIT_AS, (128*1048576, 512*1048576))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    def timeout(signum, frame):
        raise TimeoutError('bounded_capture_timeout')
    signal.signal(signal.SIGALRM, timeout);signal.alarm(45)
    now = time.time()
    due = [item for item in SCHEDULE if dt.datetime.fromisoformat(item.replace('Z', '+00:00')).timestamp() <= now]
    if not due:
        raise ValueError('natural_capture_time_not_due')
    scheduled = due[-1]
    report_name = 'window-'+scheduled[11:16].replace(':', '')+'.json'
    if os.path.lexists(STATE/report_name):
        print(json.dumps({'state': 'already_captured', 'scheduled_for': scheduled, 'collector_invoked': False}));return
    report = {'schema_version': 1, 'source': 'fixed_readonly_procmon_acceptance_capture',
        'observed_at': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
        'scheduled_for': scheduled, 'collection_error': None,
        'production_changes': False, 'collector_invoked': False,
        'administrative_admission_extended': False, 'raw_messages_exported': False}
    try:
        cadence = load('cadence_window');audit = load('audit_runtime')
        uid = pwd.getpwnam('raspberry-procmon').pw_uid
        rows = cadence.read_history(cadence.BASE, uid)
        directory = cadence.open_dir(cadence.BASE/'public')
        try:
            health = cadence.read_at(directory, 'health.json', uid, 0o640, 4096)
        finally:
            os.close(directory)
        report['cadence'] = cadence.assess(rows, now, health)
        report['runtime'] = runtime_audit(audit.summarize, now)
        report['invocation_correlation'] = invocation_correlation(now)
        report['acceptance'] = combine(report['cadence'], report['runtime'])
    except (OSError, ValueError, TypeError, KeyError, TimeoutError, subprocess.TimeoutExpired):
        report.update(collection_error='bounded_capture_incomplete', acceptance={'full_goal_accepted': False})
    raw = (json.dumps(report, sort_keys=True, allow_nan=False)+'\n').encode()
    if len(raw) > 16384:
        raise ValueError('report_size_limit')
    atomic(report_name, raw);atomic('latest.json', raw, replace=True)
    print(json.dumps({'state': 'captured' if report['collection_error'] is None else 'incomplete',
        'scheduled_for': scheduled, 'collection_error': report['collection_error'],
        'collector_invoked': False, 'raw_messages_exported': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'state': 'capture_incomplete', 'exception_kind': type(exc).__name__,
            'raw_error_withheld': True, 'collector_invoked': False, 'automatic_retry': False}))
        raise SystemExit(1)
