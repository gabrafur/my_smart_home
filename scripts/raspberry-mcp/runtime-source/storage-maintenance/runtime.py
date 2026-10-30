"""Fixed sandbox bindings and policy for the proposed root storage extension.

Not installed by importing this module. No scheduling or caller paths.
"""
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import catalog
import maintenance
import observation

INPUTS = Path('/run/raspberry-storage-inputs')
STATE = maintenance.STATE
FILES = ('catalog.py', 'client.py', 'maintenance.py', 'observation.py',
         'runtime.py', 'server.py', 'broker.py', 'route.mjs', 'entry.mjs')


def approval(*, metadata=False):
    p = maintenance.POLICY
    s = p.lstat()
    maintenance.need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1
                     and stat.S_IMODE(s.st_mode) == 0o644, 'storage_policy_identity_changed')
    value = maintenance.read_json(p)
    maintenance.need(value.get('metadata_approved') is True and value.get('project') == '/mnt/data/docker'
                     and value.get('recurring_execution_enabled') is False,
                     'specific_storage_policy_approval_required')
    hashes = value.get('source_hashes')
    maintenance.need(type(hashes) is dict and set(hashes) == set(FILES), 'storage_source_scope_changed')
    for name, expected in hashes.items():
        f = Path(__file__).with_name(name)
        info = f.lstat()
        maintenance.need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                         and stat.S_IMODE(info.st_mode) == 0o644
                         and hashlib.sha256(f.read_bytes()).hexdigest() == expected,
                         'storage_source_identity_changed')
    if value.get('expires_at') is not None:
        maintenance.need(type(value['expires_at']) in (int, float) and time.time() < value['expires_at'],
                         'storage_policy_expired')
    if not metadata:
        maintenance.policy()  # Existing engine also verifies limits and its own source.
    return value


def engine():
    # These bindings are installed only after exact scope approval. The real
    # project and all other home paths remain inaccessible to this root unit.
    scopes = {name: (INPUTS/relative, age, pattern)
              for name, relative, (_, age, pattern) in (
                  ('npm_logs', 'npm/_logs', maintenance.SCOPES['npm_logs']),
                  ('npm_temporary', 'npm/_cacache/tmp', maintenance.SCOPES['npm_temporary']))}
    return maintenance.Maintenance(scopes=scopes,
        resource_gate=lambda: maintenance.resources(INPUTS/'metrics'),
        common_lock=INPUTS/'daily-maintenance.lock')


def atomic(path, value, *, owner=0):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False)+'\n').encode()
    maintenance.need(len(raw) <= 16384, 'storage_metadata_output_limit')
    target = path.with_name(path.name+'.new')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, owner, owner)
        with os.fdopen(os.dup(fd), 'wb') as out:
            out.write(raw);out.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(target, path)
    d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(d)
    finally:
        os.close(d)


def admission():
    result = {'source': 'sealed_root_storage_policy_and_revocation_state',
              'observed_at': datetime.now(timezone.utc).isoformat(), 'age_seconds': 0,
              'collection_error': None, 'execution_active': False, 'restore_active': False,
              'recurring_execution_enabled': False, 'interface_confirmations_required': True,
              'coverage': ['fixed_cache_scopes_only_not_general_administrative_authority',
                           'admission_is_not_an_execution_receipt']}
    try:
        p = maintenance.policy(allow_revoked=True)
        result.update(restore_active=True, execution_active=not (STATE/'revoked').exists(),
                      expires_at=p.get('expires_at'), allowed_scopes=list(catalog.SCOPES))
    except (OSError, ValueError):
        result['collection_error'] = 'storage_execution_admission_unavailable'
    return result


def observe():
    approval(metadata=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    s = STATE.lstat()
    maintenance.need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o700,
                     'storage_state_identity_changed')
    fd = os.open(STATE/'observation.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = None
        try:
            old = maintenance.read_json(STATE/'observation.json', limit=16384)
            age = time.time()-datetime.fromisoformat(old['observed_at']).timestamp()
            if 0 <= age < 60:
                # Reuse without changing the source clock or running a second scan.
                return {'state': 'existing_sample_reused', 'source': 'fixed_storage_observation_cache',
                        'observed_at': old['observed_at'], 'age_seconds': round(age, 3),
                        'collection_error': None, 'coverage': ['source_clock_not_refreshed_on_read', 'no_cleanup'],
                        'maintenance_admission': admission()}
        except (OSError, ValueError, KeyError, TypeError):
            pass
        roots = {
            'recorder': tuple(INPUTS/name for name in ('recorder.db', 'recorder-wal', 'recorder-shm')),
            'backups': (INPUTS/'backups',), 'snapshots': (INPUTS/'backups',),
            'recovery_workspace': (Path('/var/lib/raspberry-seven-service-recovery'),),
            'logs': (Path('/var/log'), INPUTS/'zigbee-log', INPUTS/'mqtt-log'),
            'tools': tuple(INPUTS/name for name in ('vscode', 'cursor', 'codex')),
            'caches': (INPUTS/'npm', INPUTS/'pip'), 'checkout': (INPUTS/'checkout',)}
        def docker_not_exposed(now):
            return observation.envelope('metadata_sandbox_without_Docker_control_socket', None, now, None,
                'current_Docker_aggregate_not_exposed', 'unknown',
                ['historical_aggregate_retained_in_existing_Storage_Health_report', 'no_Docker_API_or_prune'])
        value = observation.collect(roots=roots, filesystem=INPUTS/'metrics',
                                    report=INPUTS/'storage-report.json', docker_reader=docker_not_exposed)
        value['growth'] = observation.growth(old, value)
        atomic(INPUTS/'metrics/observation.json', value, owner=1001)
        atomic(STATE/'observation.json', value)
        return {'state': 'bounded_storage_metadata_observed', 'source': 'fixed_storage_observation_cache',
                'observed_at': value['observed_at'], 'age_seconds': 0, 'collection_error': None,
                'coverage': ['bounded_metadata_measurement', 'no_cleanup'],
                'maintenance_admission': admission()}
    finally:
        os.close(fd)


def dispatch(tool, args):
    if tool == 'storage_metadata_observe':
        maintenance.need(args == {'host': 'raspberry'}, 'storage_scope_refused')
        return observe()
    verb, scope, operation = catalog.validate(tool, args)
    approval(metadata=True)
    e = engine()
    if verb == 'plan':
        return e.plan(scope, operation)
    if verb == 'status':
        # A different action cannot redirect a known plan to another scope.
        plan = maintenance.read_json(e.op_path(operation)/'plan.json')
        maintenance.need(plan['scope'] == scope, 'operation_id_conflict')
        return e.status(operation)
    if verb == 'revoke':
        return e.revoke()
    if verb == 'restore':
        return e.restore(scope, operation)
    return e.execute(scope, operation)
