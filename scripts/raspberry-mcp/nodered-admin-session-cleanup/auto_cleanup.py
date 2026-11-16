"""Root timer: revoke this administration's own Node-RED token when the in-call revoke could not run.

An apply holds the shared locks for most of the unit's 45 s budget. Its token revoke
then has a reserve that ends 20 s after process start, so a lock taken by any other
holder at that instant leaves the write token valid for 7 days and blocks every new
admin session with ``owned_session_cleanup_unconfirmed``. This job closes that gap
with the installed native route only (``RootCoordinator.recover_session_native``):

- one session per run, the oldest own unconfirmed session with a token fingerprint
  journal (``owned_fingerprint``), at least 120 s old;
- one finite permit (15 min), one store read, one revoke, no login, no flow access;
- the native cleanup runs at most once per session: once its intent is recorded it is
  never repeated and an uncertain outcome stays for owner inspection; a refusal before
  that point (lock busy, stale pins) is retried on later runs, at most three times.

Revoking an own token only removes access. Nothing here grants or widens access.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import time

NATIVE = Path('/usr/local/lib/raspberry-nodered-admin')
NATIVE_STATE = Path('/var/lib/raspberry-nodered-admin')
STATE = Path('/var/lib/raspberry-nodered-admin-session-cleanup')
MIN_AGE = 120
MAX_AGE = 7 * 86400


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def select(sessions, evidence, covered, attempted, now):
    """Pure choice of at most one session id. ``sessions`` maps id -> (receipt, token_meta)."""
    eligible = []
    for sid, (receipt, own) in sessions.items():
        if sid in attempted or covered(sid):
            continue
        if type(receipt) is not dict or receipt.get('security_cleanup_confirmed') is not False:
            continue
        if receipt.get('login_confirmed') is not True or type(own) is not dict:
            continue
        if own.get('source') != 'own_nodered_admin_token_fingerprint_v1' or own.get('session_id') != sid:
            continue
        if own.get('raw_token_persisted') is not False or own.get('requested_scope') not in ('read', '*'):
            continue
        seen = receipt.get('observed_at')
        if type(seen) not in (int, float) or not (MIN_AGE <= now - seen <= MAX_AGE):
            continue
        if (evidence.get(sid) or {}).get('token_received') is not True:
            continue
        eligible.append((seen, sid))
    return min(eligible)[1] if eligible else None


def record(name, value):
    path = STATE / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n')
        handle.flush()
        os.fsync(handle.fileno())


def main():
    need(os.geteuid() == 0, 'root_required')
    st = STATE.lstat()
    need(st.st_uid == 0 and (st.st_mode & 0o777) == 0o700, 'private_state_required')
    policy_sha = hashlib.sha256((NATIVE / 'policy.json').read_bytes()).hexdigest()
    import importlib.util
    spec = importlib.util.spec_from_file_location('fixed_session_cleanup_bootstrap', NATIVE / 'bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    modules = bootstrap.load_verified(policy_sha)
    co = modules['coordination']
    coordinator = co.RootCoordinator()
    sessions, evidence = {}, {}
    for entry in (NATIVE_STATE / 'sessions').iterdir():
        if not entry.name.endswith('.token.json'):
            continue
        sid = entry.name[:-len('.token.json')]
        if not co.valid_id(sid) or not (NATIVE_STATE / 'sessions' / (sid + '.receipt.json')).exists():
            continue
        sessions[sid] = (co.sealed_json(NATIVE_STATE / 'sessions' / (sid + '.receipt.json')), co.sealed_json(entry))
        side = NATIVE_STATE / 'session-cleanup-evidence' / (sid + '.json')
        if side.exists():
            evidence[sid] = co.sealed_json(side)
    names = [p.name for p in STATE.iterdir()]
    attempted = {n.split('.')[0] for n in names if n.endswith('.intent.json')}
    attempted |= {sid for sid in {n.split('.')[0] for n in names}
                  if sum(n.startswith(sid + '.refused-') for n in names) >= 3}
    now = time.time()
    sid = select(sessions, evidence, coordinator._cleanup_recovery_covers, attempted, now)
    if sid is None:
        return {'state': 'nothing_to_clean', 'revocations': 0}
    cleanup = secrets.token_hex(16)
    receipt_raw = co.checked_read(NATIVE_STATE / 'sessions' / (sid + '.receipt.json'))
    own_raw = co.checked_read(NATIVE_STATE / 'sessions' / (sid + '.token.json'))
    own = co.decode(own_raw)
    try:
        prepare_permit(co, coordinator, cleanup, sid, receipt_raw, own_raw, own)
    except Exception as error:
        refused = sum(n.startswith(sid + '.refused-') for n in names) + 1
        record('%s.refused-%d.json' % (sid, refused), {'session_id': sid, 'cleanup_id': cleanup, 'at': now,
               'reason': str(error)[:120] if type(error) is ValueError else type(error).__name__})
        raise
    record(sid + '.intent.json', {'session_id': sid, 'cleanup_id': cleanup, 'at': now, 'automatic_retry': False})
    result = coordinator.recover_session_native(cleanup, sid)
    outcome = {'session_id': sid, 'cleanup_id': cleanup, 'state': result.get('state'),
               'proven': coordinator._cleanup_recovery_covers(sid), 'revocations': len(result.get('outcomes', [])),
               'automatic_retry': False}
    record(sid + '.outcome.json', outcome)
    return outcome


def prepare_permit(co, coordinator, cleanup, sid, receipt_raw, own_raw, own):
    """Finite permit from one native store read under the shared locks; no HTTP."""
    adapter = co.SessionCleanupNativeIO(coordinator, cleanup, sid, 'original')
    with adapter.native_lease():
        store = adapter._read_runtime('/data/.sessions.json', 1048576, session_store=True)
        selected = co.sc_select_owned(store, [own['token_sha256']], expected_user=coordinator.document['backend']['username'],
                                      requested_scope=own['requested_scope'])
        need(len(selected) == 1, 'exact_owned_token_record_required')
        username = coordinator.document['backend']['username']
        meta = co.sc_digest({'user_sha256': hashlib.sha256(username.encode()).hexdigest(), 'client': 'node-red-admin',
                             'scope': [own['requested_scope']], 'expires_ms': selected[0].expires_ms})
        observed = coordinator.clock()
        permit = {'schema': 'finite_nodered_session_cleanup_permit_v1', 'cleanup_id': cleanup, 'session_id': sid,
                  'kind': 'owned_fingerprint', 'token_hashes': [own['token_sha256']],
                  'requested_scope': own['requested_scope'], 'client': 'node-red-admin', 'user': username,
                  'original_block_sha256': hashlib.sha256(co.checked_read(co.CLEANUP_BLOCK)).hexdigest(),
                  'original_receipt_sha256': hashlib.sha256(receipt_raw).hexdigest(),
                  'ownership_evidence_sha256': hashlib.sha256(own_raw).hexdigest(),
                  'backend_identity_sha256': coordinator.document['backend']['identity_sha256'],
                  'root_policy_sha256': coordinator.root_policy_sha256,
                  'source_pins_sha256': co.digest(coordinator.document['sources']),
                  'observed_at': observed, 'expires_at': observed + 900,
                  'token_metadata_sha256': {own['token_sha256']: meta}}
        co.atomic_create(NATIVE_STATE / 'session-cleanup-permits' / (cleanup + '.json'), permit)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:
        print(json.dumps({'state': 'unconfirmed_inspect', 'reason': str(error)[:120] if type(error) is ValueError else None,
                          'exception_kind': type(error).__name__, 'automatic_retry': False}))
        raise SystemExit(1)
