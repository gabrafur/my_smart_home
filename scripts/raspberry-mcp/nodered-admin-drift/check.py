#!/usr/bin/env python3
"""Read-only drift check of the sealed Node-RED administration chain.

The administration guard and the closed metadata reader pin facts that other
changes can silently invalidate: the exact table set of four coordination
ledgers, the Node-RED container identity and image, its Compose files label,
its bridge address and the container directory identities pinned for the
native session cleanup. It also reports own admin sessions whose token was
not revoked (the automatic cleanup normally closes them within ten minutes). When any of them drifts, the next preflight or apply
fails closed (for example ``ledger_schema_tables_unknown``), usually at the
moment a deploy is needed. This check finds the drift beforehand.

It runs as Root, opens ledgers read-only, never reads rows, credentials or
policy secrets, and writes one sanitized status document (table and column
names, states and short hashes only). Remediation is the documented re-binding
procedure; this check never changes the chain.
"""
import ast
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

GUARD = Path('/usr/local/lib/raspberry-nodered-admin/native_guard.py')
ADMIN_POLICY = Path('/usr/local/lib/raspberry-nodered-admin/policy.json')
READER = Path('/usr/local/lib/raspberry-nodered-runtime-metadata/reader.py')
READER_POLICY = Path('/usr/local/lib/raspberry-nodered-runtime-metadata/policy.json')
STATUS = Path('/var/lib/raspberry-nodered-admin-drift/status.json')
SESSIONS = Path('/var/lib/raspberry-nodered-admin/sessions')
PROOF_INDEX = Path('/var/lib/raspberry-nodered-admin/session-cleanup-proof-index')
UNREVOKED_GRACE = 1800
UNREVOKED_WINDOW = 7 * 86400
LABEL = 'com.docker.compose.project.config_files'
FORMAT = '{{json .Id}}|{{json .Image}}|{{json (index .Config.Labels "' + LABEL + '")}}|' \
         '{{json (index .NetworkSettings.Networks "docker_default").IPAddress}}'


def literal(source, name):
    """Return a top-level literal assignment without executing the guard."""
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError('guard_literal_missing:' + name)


def ledger_paths(source):
    """The guard keeps ledger paths in an anonymous dict next to SCHEMAS; find it by its keys."""
    schemas = literal(source, 'SCHEMAS')
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Dict) and node.keys and all(isinstance(k, ast.Constant) for k in node.keys):
            keys = {k.value for k in node.keys}
            if keys == set(schemas) and all(isinstance(v, ast.Constant) and str(v.value).startswith('/')
                                            for v in node.values):
                return {k.value: v.value for k, v in zip(node.keys, node.values)}
    raise ValueError('guard_ledger_paths_missing')


def live_schema(path):
    db = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=5)
    try:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {t: [r[1] for r in db.execute('PRAGMA table_info("' + t.replace('"', '') + '")')] for t in tables}
    finally:
        db.close()


def compare_schema(expected, live):
    """Pure comparison: names only, never rows."""
    extra = sorted(set(live) - set(expected))
    missing = sorted(set(expected) - set(live))
    columns = sorted(t for t in set(live) & set(expected) if live[t] != expected[t].split())
    return {'state': 'aligned' if not (extra or missing or columns) else 'drift',
            'extra_tables': extra, 'missing_tables': missing, 'column_changes': columns}


def compare_container(live, reader_policy, reader_source, admin_policy):
    identity, image, label, address = live
    checks = {
        'container_identity': identity == reader_policy.get('container_id'),
        'container_image': image == reader_policy.get('image'),
        'compose_label': label is not None and (LABEL + "':'" + label + "'") in reader_source,
        'backend_address': address == admin_policy.get('backend', {}).get('host'),
    }
    return {name: 'aligned' if ok else 'drift' for name, ok in checks.items()}


def compare_guard_pins(guard_sha, admin_policy):
    pins = (admin_policy.get('sources', {}).get('native_guard.py'),
            admin_policy.get('native_guard_producer', {}).get('source_sha256'))
    return 'aligned' if all(pin == guard_sha for pin in pins) else 'drift'


def compare_cleanup_pins(admin_policy, ancestors):
    pins = admin_policy.get('session_cleanup_recovery', {}).get('runtime_source_parent_pins')
    if not pins:
        return 'aligned'
    names = sorted({name for value in pins.values() for name in value})
    live = ancestors(names)
    return 'aligned' if all(live.get(n) == v for value in pins.values() for n, v in value.items()) else 'drift'


def unrevoked_sessions(sessions, now):
    """Own sessions with an unconfirmed revoke and no cleanup proof, past the automatic cleanup grace."""
    count = sum(1 for receipt, proven in sessions
                if receipt.get('security_cleanup_confirmed') is False and not proven
                and type(receipt.get('observed_at')) in (int, float)
                and UNREVOKED_GRACE <= now - receipt['observed_at'] <= UNREVOKED_WINDOW)
    return {'state': 'drift' if count else 'aligned', 'count': count}


def live_ancestors(names):
    pid = subprocess.run(['/usr/bin/docker', 'inspect', '--format', '{{.State.Pid}}', 'nodered'],
                         capture_output=True, timeout=15, check=True).stdout.decode().strip()
    if not pid.isdigit() or int(pid) <= 1:
        raise ValueError('nodered_pid_unknown')
    result = {}
    for name in names:
        info = os.stat('/proc/' + pid + '/root' + name, follow_symlinks=False)
        result[name] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode & 0o7777]
    return result


def own_sessions():
    rows = []
    for entry in SESSIONS.iterdir():
        if entry.name.endswith('.receipt.json'):
            sid = entry.name[:-len('.receipt.json')]
            rows.append((json.loads(entry.read_bytes()), (PROOF_INDEX / (sid + '.json')).exists()))
    return rows


def build(read=lambda p: p.read_bytes(), schema=live_schema, docker=None, clock=time.time,
          ancestors=None, sessions=None):
    guard = read(GUARD)
    source = guard.decode()
    admin = json.loads(read(ADMIN_POLICY))
    reader_policy = json.loads(read(READER_POLICY))
    reader_source = read(READER).decode()
    expected = literal(source, 'SCHEMAS')
    ledgers = {}
    for name, path in ledger_paths(source).items():
        try:
            ledgers[name] = compare_schema(expected[name], schema(path))
        except sqlite3.Error:
            ledgers[name] = {'state': 'unknown', 'collection_error': 'ledger_unreadable'}
    try:
        container = compare_container(docker(), reader_policy, reader_source, admin)
    except Exception:  # Docker unavailable is unknown, never aligned.
        container = {'state': 'unknown', 'collection_error': 'container_inspect_failed'}
    try:
        cleanup_pins = compare_cleanup_pins(admin, ancestors) if ancestors else 'unknown'
    except Exception:
        cleanup_pins = 'unknown'
    try:
        unrevoked = unrevoked_sessions(sessions(), clock()) if sessions else {'state': 'unknown'}
    except Exception:
        unrevoked = {'state': 'unknown', 'collection_error': 'sessions_unreadable'}
    checks = {'ledger_schemas': ledgers, 'container': container,
              'guard_pins': compare_guard_pins(hashlib.sha256(guard).hexdigest(), admin),
              'session_cleanup_pins': cleanup_pins, 'unrevoked_own_sessions': unrevoked}
    states = [v['state'] for v in ledgers.values()] + \
             ([container['state']] if 'state' in container else list(container.values())) + \
             [checks['guard_pins'], cleanup_pins, unrevoked['state']]
    overall = 'drift' if 'drift' in states else 'unknown' if 'unknown' in states else 'aligned'
    return {'schema_version': 1, 'source': 'nodered_admin_chain_drift_check',
            'observed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(clock())),
            'state': overall, 'checks': checks,
            'guard_sha256_prefix': hashlib.sha256(guard).hexdigest()[:12],
            'remediation': 'docs/raspberry-mcp/reference/nodered-administration.md',
            'changes_chain': False}


def docker_inspect():
    out = subprocess.run(['/usr/bin/docker', 'inspect', '--format', FORMAT, 'nodered'],
                         capture_output=True, timeout=15, check=True).stdout.decode().strip()
    return tuple(json.loads(v) for v in out.split('|'))


def write_status(value, path=STATUS):
    path.parent.mkdir(mode=0o755, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.status-')
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write('\n')
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def main():
    status = build(docker=docker_inspect, ancestors=live_ancestors, sessions=own_sessions)
    write_status(status)
    print(json.dumps({'state': status['state']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
