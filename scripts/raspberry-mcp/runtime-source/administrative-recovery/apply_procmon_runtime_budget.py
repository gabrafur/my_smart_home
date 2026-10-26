"""Fixed two-file runtime correction; no collector invocation or new authority."""
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

STAGE = Path('/run/raspberry-procmon-runtime-budget-20261026')
STATE = Path('/var/lib/raspberry-procmon-runtime-budget-20261026')
BUNDLE = STATE/'bundle'
EXPIRY = 1793138354 + 2133384 / 10_000_000
MANIFEST_SHA = 'c25cbad272d8bc088c9f7143d71e149f8b8ba1472bca35331bd00f0662e2c931'
HELPER_SHA = '7df4d1f378479f3c03bbd5b4efe7420fb2c5ff4661f357881311380f57f33ebb'
TARGETS = {
    'observed_collector.py': '/usr/local/lib/raspberry-procmon-observability/observed_collector.py',
    'raspberry-procmon.service': '/etc/systemd/system/raspberry-procmon.service',
}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def raw(value):
    return (json.dumps(value, sort_keys=True, indent=2)+'\n').encode()


def helper():
    source = STAGE/'sealed_helpers.py'
    # Check ownership/modes before importing the already reviewed fixed helper.
    for path in [source, *source.parents]:
        st = path.lstat()
        need(st.st_uid == 0 and not st.st_mode & 0o022 and not path.is_symlink(), 'unsafe_sealed_helper')
    need(sha(source.read_bytes()) == HELPER_SHA, 'sealed_helper_changed')
    spec = importlib.util.spec_from_file_location('fixed_budget_sealed_helpers', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load(h):
    encoded = h.read(STAGE/'MANIFEST.json')
    need(sha(encoded) == MANIFEST_SHA, 'manifest_changed')
    manifest = json.loads(encoded)
    need(set(manifest['targets']) == set(TARGETS) and manifest['expires_at'] == EXPIRY,
         'manifest_scope_changed')
    candidate = {}
    for name, path in TARGETS.items():
        row = manifest['targets'][name]
        need(row['path'] == path, 'target_path_changed')
        candidate[name] = h.read(STAGE/name)
        need(sha(candidate[name]) == row['after'], 'candidate_changed')
    return manifest, candidate


def baseline(h, manifest, which):
    result = {}
    for name, path in TARGETS.items():
        result[name] = h.read(Path(path))
        need(sha(result[name]) == manifest['targets'][name][which], 'target_baseline_changed')
    for path, expected in manifest['unchanged'].items():
        need(sha(h.read(Path(path))) == expected, 'protected_source_changed')
    return result


def gate():
    need(os.geteuid() == 0 and time.time()+90 < EXPIRY, 'valid_authority_required')
    for path in ['/var/lib/raspberry-admin-executor/revoked',
                 '/var/lib/raspberry-mcp-operations/task-control/revoked']:
        need(not os.path.lexists(path), 'authority_revoked')


@contextlib.contextmanager
def collector_lock():
    path = Path('/var/lib/raspberry-procmon/lock')
    need(not path.is_symlink(), 'unsafe_collector_lock')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def manager():
    result = subprocess.run(['/usr/bin/systemctl', 'show', 'raspberry-procmon.service',
        '-p', 'TimeoutStartUSec', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState'],
        capture_output=True, timeout=5, check=True)
    need(len(result.stdout) < 4096, 'manager_output_limit')
    return dict(line.split('=', 1) for line in result.stdout.decode().splitlines())


def reload_unit():
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], capture_output=True, timeout=10, check=True)


def reports(h):
    return {str(path): sha(h.read(path)) for path in
            Path('/var/lib/raspberry-procmon-acceptance').glob('window-*.json')}


def save(h, name, row):
    need(not os.path.lexists(STATE/name), 'receipt_exists_requires_reconciliation')
    h.atomic(STATE/name, raw(row), 0o600)


def main(action):
    h = helper()
    manifest, candidates = load(h)
    if action == 'status':
        print(json.dumps({'state': 'readonly_reconciliation', 'files': {
            name: sha(h.read(Path(path))) for name, path in TARGETS.items()},
            'manager': manager(), 'intent': (STATE/'intent.json').exists(),
            'applied': (STATE/'applied.json').exists(), 'rollback_intent': (STATE/'rollback-intent.json').exists(),
            'rolled_back': (STATE/'rolled-back.json').exists(), 'automatic_retry': False}))
        return
    gate()
    tasks = h.chains()
    with h.locks(tasks), collector_lock():
        if action in ('preflight', 'apply'):
            need(not STATE.exists(), 'existing_intent_requires_reconciliation')
            before = baseline(h, manifest, 'before')
            old_reports = reports(h)
            need(old_reports == manifest['historical_reports'], 'historical_reports_changed')
            current = manager()
            need(current['MainPID'] == '0' and current['TimeoutStartUSec'] == '7s', 'collector_or_manager_state_changed')
            if action == 'preflight':
                print(json.dumps({'state': 'preflight_passed', 'targets': 2,
                    'new_access': False, 'expiry_unchanged': EXPIRY, 'collector_invoked': False}))
                return
            h.directory(STATE, 0o700)
            h.directory(STATE/'before', 0o700)
            h.directory(BUNDLE, 0o700)
            # Persist rollback code, sources and intent before any production edit.
            for name in ['MANIFEST.json', 'deploy.py', 'sealed_helpers.py', *TARGETS]:
                h.atomic(BUNDLE/name, h.read(STAGE/name))
            for name, data in before.items():
                h.atomic(STATE/'before'/name, data, 0o600)
            save(h, 'intent.json', {'state': 'intent_before_two_file_correction',
                'at': time.time(), 'operation_id': manifest['operation_id'],
                'manifest_sha256': MANIFEST_SHA, 'historical_reports': old_reports,
                'automatic_retry': False})
            try:
                for name, path in TARGETS.items():
                    need(sha(h.read(Path(path))) == manifest['targets'][name]['before'], 'target_changed_before_write')
                    h.atomic(Path(path), candidates[name])
                baseline(h, manifest, 'after')
                # Reload changes the next natural invocation, never starts a collector.
                save(h, 'reload-intent.json', {'at': time.time(), 'automatic_retry': False})
                reload_unit()
                need(manager()['TimeoutStartUSec'] == '20s', 'unit_reload_unconfirmed')
                h.chains()
                need(reports(h) == old_reports, 'historical_reports_changed')
                row = {'state': 'applied_awaiting_natural_cycles', 'at': time.time(),
                    'operation_id': manifest['operation_id'], 'manifest_sha256': MANIFEST_SHA,
                    'targets': 2, 'collector_invoked': False, 'services_restarted': 0,
                    'timer_changed': False, 'CPU_memory_limits_changed': False,
                    'authority_extended': False, 'automatic_retry': False}
                save(h, 'applied.json', row)
                print(json.dumps(row))
            except BaseException:
                save(h, 'unconfirmed.json', {'state': 'reconcile_same_intent_before_any_retry',
                    'at': time.time(), 'automatic_retry': False})
                raise
            return
        need(action == 'rollback', 'fixed_action_required')
        need((STATE/'intent.json').exists() and not (STATE/'rollback-intent.json').exists(), 'rollback_requires_reconciliation')
        # Only this operation's exact before/after states may be restored.
        present = {name: h.read(Path(path)) for name, path in TARGETS.items()}
        before = {name: h.read(STATE/'before'/name, 0o600) for name in TARGETS}
        for name in TARGETS:
            need(sha(present[name]) in (manifest['targets'][name]['before'], manifest['targets'][name]['after']), 'external_edit_requires_reconciliation')
            need(sha(before[name]) == manifest['targets'][name]['before'], 'backup_changed')
        for path, expected in manifest['unchanged'].items():
            need(sha(h.read(Path(path))) == expected, 'protected_source_changed')
        need(all(reports(h).get(k) == v for k, v in manifest['historical_reports'].items()), 'historical_reports_changed')
        save(h, 'rollback-intent.json', {'at': time.time(), 'automatic_retry': False})
        for name, path in TARGETS.items():
            need(sha(h.read(Path(path))) == sha(present[name]), 'target_changed_during_rollback')
            h.atomic(Path(path), before[name])
        reload_unit()
        baseline(h, manifest, 'before')
        need(manager()['TimeoutStartUSec'] == '7s', 'rollback_reload_unconfirmed')
        h.chains()
        row = {'state': 'rolled_back_awaiting_natural_cycle', 'at': time.time(), 'automatic_retry': False,
               'collector_invoked': False, 'services_restarted': 0}
        save(h, 'rolled-back.json', row)
        print(json.dumps(row))


if __name__ == '__main__':
    try:
        if Path(__file__) == BUNDLE/'deploy.py':
            STAGE = BUNDLE
        need(Path(__file__) == STAGE/'deploy.py' and sys.argv[1:] in
             ([value] for value in ['preflight', 'apply', 'status', 'rollback']), 'fixed_entrypoint_required')
        main(sys.argv[1])
    except Exception as exc:
        print(json.dumps({'state': 'not_accepted_or_unconfirmed', 'exception_kind': type(exc).__name__,
              'reason': str(exc) if type(exc) is ValueError else 'withheld', 'automatic_retry': False}))
        raise SystemExit(1)
