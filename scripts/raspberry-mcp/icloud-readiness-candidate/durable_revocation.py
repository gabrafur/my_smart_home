"""Fixed additive revocation persistence. No service restart or caller paths."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

STAGE = Path('/__OPERATOR_STAGE__/icloud-readiness')
STATE = Path('/var/lib/raspberry-icloud-revocation-20261026-r1')
ADMIN = Path('/usr/local/lib/raspberry-admin-executor/policy.json')
REPAIR = Path('/usr/local/lib/raspberry-repair-control/policy.json')
RULE = Path('/etc/tmpfiles.d/raspberry-icloud-readiness.conf')
LINK = Path('/run/raspberry-icloud-read/revoked')
DURABLE = Path('/var/lib/raspberry-icloud-access')
FLAG = DURABLE / 'revoked'
EXPIRY = 0
BEFORE = {str(ADMIN): '2e08f6a7b4f6c6ba5d7455088c0fdb75630e83631ce30dd7a74f4d678d1dcaac', str(REPAIR): '8f63148719baf17d0013818f24c7d0436ab6b15adeae0d8619456786ea388a3e'}
CONTENT = b'd /run/raspberry-icloud-read 0755 root root -\nd /var/lib/raspberry-icloud-access 0755 root root -\nL /run/raspberry-icloud-read/revoked - - - - /var/lib/raspberry-icloud-access/revoked\n'


def model():
    source = STAGE / 'apply.py'
    assert source.stat().st_uid == 0 and source.stat().st_mode & 0o777 == 0o644 and not source.is_symlink()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == '7df4d1f378479f3c03bbd5b4efe7420fb2c5ff4661f357881311380f57f33ebb'
    spec = importlib.util.spec_from_file_location('sealed_readiness_installer', STAGE / 'apply.py')
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def proposed(a, r, digest):
    admin = json.loads(a); repair = json.loads(r)
    assert admin['expires_at'] == repair['expires_at'] == EXPIRY
    assert admin['readiness_scope']['enabled'] is True
    assert str(RULE) not in admin['dependencies']
    admin['dependencies'][str(RULE)] = digest(CONTENT)
    out = (json.dumps(admin, indent=2, sort_keys=True) + '\n').encode()
    repair['dependencies'][str(ADMIN)] = digest(out)
    return out, (json.dumps(repair, indent=2, sort_keys=True) + '\n').encode()


def main(action):
    m = model(); m.need(os.geteuid() == 0 and time.time() + 30 < EXPIRY, 'root_and_validity_required')
    tasks = m.chains()
    with m.locks(tasks):
        if action == 'rollback':
            receipt = json.loads(m.read(STATE / 'receipt.json', 0o600))
            m.need(not (STATE / 'rollback-intent.json').exists(), 'rollback_intent_requires_reconciliation')
            m.need(not FLAG.exists(), 'revocation_must_not_be_removed_or_bypassed')
            for p, digest in receipt['after'].items():
                m.need(m.sha(m.read(Path(p))) == digest, 'later_dependency_change_requires_reconciliation')
            m.need(LINK.is_symlink() and os.readlink(LINK) == str(FLAG), 'revocation_link_changed')
            m.atomic(STATE / 'rollback-intent.json', m.raw({'at': time.time(), 'automatic_retry': False}), 0o600)
            m.atomic(ADMIN, m.read(STATE / 'admin-before.json', 0o600))
            m.atomic(REPAIR, m.read(STATE / 'repair-before.json', 0o600))
            LINK.unlink(); RULE.unlink(); m.sync(LINK.parent); m.sync(RULE.parent)
            m.chains(); m.root_backend()
            m.atomic(STATE / 'rollback-receipt.json', m.raw({'state': 'rolled_back_additive_rule_only', 'at': time.time(), 'services_restarted': 0, 'persistent_revocation_directory_preserved': True}), 0o600)
            print('{"state":"rolled_back_additive_rule_only","services_restarted":0}'); return
        m.need(action in ('preflight', 'apply-approved'), 'fixed_action_required')
        m.need(not STATE.exists(), 'existing_intent_requires_reconciliation')
        data = {p: m.read(Path(p)) for p in BEFORE}
        m.need(all(m.sha(data[p]) == digest for p, digest in BEFORE.items()), 'baseline_changed')
        m.need(not any(os.path.lexists(p) for p in (RULE, LINK, DURABLE)), 'existing_revocation_state_requires_reconciliation')
        a, r = proposed(data[str(ADMIN)], data[str(REPAIR)], m.sha)
        m.need(subprocess.run(['/usr/bin/systemctl', 'is-active', 'raspberry-admin-executor.socket'], capture_output=True, timeout=3).returncode == 0, 'existing_admin_socket_inactive')
        m.need(subprocess.run(['/usr/bin/systemctl', 'is-enabled', 'raspberry-admin-executor.socket'], capture_output=True, timeout=3).returncode == 0, 'existing_admin_socket_not_enabled')
        old_receipts = m.historical_receipts()
        if action == 'preflight':
            print(json.dumps({'state': 'preflight_passed', 'new_permissions': 0, 'services_restarted': 0, 'expiry': EXPIRY, 'rule_sha256': m.sha(CONTENT)})); return
        m.directory(STATE, 0o700)
        m.atomic(STATE / 'admin-before.json', data[str(ADMIN)], 0o600)
        m.atomic(STATE / 'repair-before.json', data[str(REPAIR)], 0o600)
        m.atomic(STATE / 'intent.json', m.raw({'at': time.time(), 'authority': 'latest_user_access_authorization_20261026', 'expiry': EXPIRY, 'automatic_retry': False, 'before': BEFORE, 'historical_receipts': old_receipts}), 0o600)
        m.atomic(RULE, CONTENT)
        subprocess.run(['/usr/bin/systemd-tmpfiles', '--create', str(RULE)], check=True, capture_output=True, timeout=5)
        m.need(LINK.is_symlink() and os.readlink(LINK) == str(FLAG) and not LINK.exists(), 'revocation_link_unconfirmed')
        m.need(DURABLE.is_dir() and DURABLE.stat().st_uid == 0 and DURABLE.stat().st_mode & 0o777 == 0o755, 'persistent_directory_unconfirmed')
        m.atomic(ADMIN, a); m.atomic(REPAIR, r)
        m.chains(); m.root_backend()
        m.need(m.historical_receipts() == old_receipts, 'historical_receipts_changed')
        after = {str(ADMIN): m.sha(a), str(REPAIR): m.sha(r), str(RULE): m.sha(CONTENT)}
        m.atomic(STATE / 'receipt.json', m.raw({'state': 'installed_pending_actual_MCP_read', 'at': time.time(), 'expires_at': EXPIRY, 'after': after, 'historical_receipts': old_receipts, 'services_restarted': 0, 'new_permissions': 0, 'revocation_target': str(FLAG), 'no_revocation_cleared': True, 'automatic_retry': False}), 0o600)
        print(json.dumps({'state': 'installed_pending_actual_MCP_read', 'services_restarted': 0, 'new_permissions': 0, 'expires_at': EXPIRY}))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('fixed_action_required')
        main(sys.argv[1])
    except Exception as exc:
        print(json.dumps({'state': 'not_accepted', 'exception_class': type(exc).__name__, 'raw_error_withheld': True, 'automatic_retry': False})); sys.exit(1)
