"""Fixed six-function Node-RED deployment through admitted administrative tasks."""
import hashlib, importlib.util, json, os, re, stat, subprocess, sys, time
from pathlib import Path

STAGE = Path('/run/raspberry-nodered-dry-run-receipts-20261027')
STATE = Path('/var/lib/raspberry-nodered-dry-run-receipts-20261027')
BUNDLE = STATE / 'bundle'
REVISION_BUNDLE = STATE / 'bundle-revision3'
MANIFEST_SHA = '8704b768e76fd38c5bdbed1f632dbf03ddb6a649b0775ed636acbe8efd961e84'
EXPIRY = 1793138354 + 2133384 / 10_000_000
REPO = Path('/mnt/data/docker')
NODE_IDS = frozenset(('global_observer_diagnostic_build', 'global_observer_dry_run_terminal',
    'host_obs_normalize', 'host_obs_facts', 'host_obs_lifecycle', 'host_obs_test_build'))
SERVICES = ('homeassistant', 'nodered', 'mosquitto', 'portainer', 'appdaemon', 'matter_server', 'zigbee2mqtt')

def need(value, reason):
    if not value:
        raise ValueError(reason)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def raw(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode()

def digest(value):
    return sha(raw(value).rstrip(b'\n'))

def read(path, uid=0, mode=0o600):
    path = Path(path)
    for parent in path.parents:
        need(parent.is_dir() and not parent.is_symlink(), 'unsafe_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == mode
            and info.st_nlink == 1 and info.st_size <= 8 * 1024 * 1024, 'unsafe_file')
        value = os.read(fd, 8 * 1024 * 1024 + 1)
        need(len(value) <= 8 * 1024 * 1024, 'file_limit')
        return value
    finally:
        os.close(fd)

def module(name, m):
    path = STAGE / name
    need(sha(read(path)) == m['files'][name], 'sealed_module_changed')
    spec = importlib.util.spec_from_file_location('sealed_nodered_' + path.stem, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def function_delta(before, after):
    left, right = {n['id']: n for n in before}, {n['id']: n for n in after}
    need(len(left) == len(before) and len(right) == len(after) and left.keys() == right.keys(), 'node_inventory_changed')
    changed = {key for key in left if left[key] != right[key]}
    need(changed == NODE_IDS, 'node_scope_changed')
    for key in changed:
        need(left[key]['type'] == right[key]['type'] == 'function' and
            {k: v for k, v in left[key].items() if k != 'func'} ==
            {k: v for k, v in right[key].items() if k != 'func'}, 'non_function_property_changed')
    return sorted(changed)

def command(args):
    result = subprocess.run(args, capture_output=True, timeout=10)
    need(result.returncode == 0 and len(result.stdout) <= 65536, 'fixed_read_unconfirmed')
    return result.stdout

def services():
    return {name: command(['/usr/bin/docker', 'inspect', '--format',
        '{{.State.Status}} {{.State.StartedAt}}', name]).decode().strip() for name in SERVICES}

def identity():
    return json.loads(command(['/usr/bin/docker', 'inspect', '--format',
        '{"Id":{{json .Id}},"Image":{{json .Image}},"StartedAt":{{json .State.StartedAt}},"Networks":{{json .NetworkSettings.Networks}}}', 'nodered']))

def disk(m):
    row = m['disk_metadata']
    return digest(json.loads(read(REPO / 'nodered/flows.json', row['uid'], row['mode'])))

def api(m, h, phase=None, before=None, after=None, traced=None):
    username = 'admin'
    for line in (REPO / '.env').read_text().splitlines():
        if line.startswith('NODE_RED_ADMIN_USER='):
            username = line.split('=', 1)[1].strip().strip('"\'')
    need(re.fullmatch(r'[a-zA-Z0-9_.@-]{1,64}', username), 'username_invalid')
    request = {'action': 'snapshot' if phase is None else 'deploy_and_replay', 'username': username,
        'password': (REPO / '.local-secrets/node-red-admin-password.txt').read_text().strip()}
    if phase is not None:
        request.update(run_id=m['phases'][phase]['run_id'], trace_expected=traced,
            expected_loaded_sha256=before, proposed_loaded_sha256=digest(after), flows=after,
            journal_dir=str(STATE / phase / 'client-events'))
    result = subprocess.run(['/usr/bin/node', '--max-old-space-size=96', str(STAGE / 'client.cjs')],
        input=json.dumps(request).encode(), capture_output=True, timeout=90, env={'PATH': '/usr/bin:/bin'})
    need(len(result.stdout) < 8 * 1024 * 1024, 'api_output_limit')
    proof = json.loads(result.stdout)
    if phase is not None:
        h.atomic(STATE / phase / 'api-result.json', raw(proof), 0o600)
    need(result.returncode == 0 and proof.get('verified') is True and proof.get('session_revoked') is True,
        'api_outcome_unconfirmed_readonly_reconciliation_required')
    return proof

def load():
    data = read(STAGE / 'MANIFEST.json')
    need(sha(data) == MANIFEST_SHA, 'manifest_changed')
    m = json.loads(data)
    need(m['expires_at'] == EXPIRY and set(m['phases']) == {'apply', 'rollback', 'reapply'} and
        set(m['changed_nodes']) == NODE_IDS, 'manifest_scope_changed')
    for name, expected in m['files'].items():
        need('/' not in name and sha(read(STAGE / name)) == expected, 'staged_source_changed')
    for path, row in m['protected_sources'].items():
        need(sha(read(path, row['uid'], row['mode'])) == row['sha256'], 'reviewed_source_changed')
    before, after = [json.loads(read(STAGE / ('flows.' + version + '.json'))) for version in ('before', 'after')]
    function_delta(before, after)
    need(digest(before) == m['before_loaded_sha256'] and digest(after) == m['after_loaded_sha256'], 'flow_hash_changed')
    if m.get('package_revision') == 3:
        parent_bytes = read(BUNDLE / 'MANIFEST.json')
        need(sha(parent_bytes) == m['parent_manifest_sha256'], 'original_transaction_changed')
        parent = json.loads(parent_bytes)
        for key in ['operation_id', 'expires_at', 'changed_nodes', 'protected_sources', 'disk_metadata',
            'before_loaded_sha256', 'after_loaded_sha256', 'before_disk_sha256', 'new_access', 'new_tools',
            'services_restarted', 'new_listeners', 'physical_effects', 'expiry_extended']:
            need(m[key] == parent[key], 'transaction_scope_changed')
        need(m['phases']['apply'] == parent['phases']['apply'], 'applied_phase_changed')
        need({k: v for k, v in m['files'].items() if k != 'task_admission.py'} ==
            {k: v for k, v in parent['files'].items() if k != 'task_admission.py'}, 'original_payload_changed')
        for phase in ['rollback', 'reapply']:
            need(m['phases'][phase]['create'] == parent['phases'][phase]['create'] and
                m['phases'][phase]['run_id'] == parent['phases'][phase]['run_id'], 'phase_identity_changed')
        need(json.loads(read(STATE / 'apply-intent.json'))['manifest_sha256'] == m['parent_manifest_sha256'] and
            json.loads(read(STATE / 'apply-result.json'))['loaded_sha256'] == m['after_loaded_sha256'],
            'original_application_unconfirmed')
    return m, before, after

def save(h, path, value):
    need(not os.path.lexists(path), 'existing_intent_requires_reconciliation')
    h.atomic(path, raw(value), 0o600)

def main(action):
    m, before, after = load()
    h, admission = module('sealed_helpers.py', m), module('task_admission.py', m)
    if action == 'status':
        print(json.dumps({'state': 'readonly_reconciliation', 'disk_sha256': disk(m),
            'phase_results': {p: (STATE / (p + '-result.json')).exists() for p in m['phases']},
            'automatic_retry': False}))
        return
    need(action in ('preflight', 'revision-preflight', 'apply', 'rollback', 'reapply') and os.geteuid() == 0 and
        time.time() + 300 < EXPIRY, 'valid_root_authority_required')
    for path in ['/var/lib/raspberry-admin-executor/revoked', '/var/lib/raspberry-mcp-operations/task-control/revoked']:
        need(not os.path.lexists(path), 'authority_revoked')
    with admission.locks(h, m, action, preflight=action in ('preflight', 'revision-preflight')) as admission_receipt:
        need(identity() == json.loads(read(STAGE / 'nodered-identity.json')), 'nodered_identity_changed')
        current = services()
        need(all(value.startswith('running ') for value in current.values()), 'household_service_degraded')
        if action == 'revision-preflight':
            need(m.get('package_revision') == 3 and disk(m) == m['after_loaded_sha256'] and
                not (STATE / 'rollback-intent.json').exists() and not (STATE / 'rollback').exists(),
                'revision_baseline_unconfirmed')
            proof = api(m, h)
            need(proof['loaded_sha256'] == m['after_loaded_sha256'], 'loaded_baseline_changed')
            print(json.dumps({'state': 'revision_preflight_passed', 'original_application_preserved': True,
                'own_live_observation_supported': True, 'new_access': False}))
            return
        if action in ('preflight', 'apply'):
            need(not STATE.exists() and disk(m) == m['before_disk_sha256'], 'initial_disk_or_intent_changed')
            if action == 'preflight':
                proof = api(m, h)
                need(proof['loaded_sha256'] == m['before_loaded_sha256'], 'loaded_baseline_changed')
                print(json.dumps({'state': 'preflight_passed', 'changed_functions': 6,
                    'known_published_diagnostic_fragment_drift_preserved': True, 'new_access': False}))
                return
            h.directory(STATE, 0o700)
            h.directory(BUNDLE, 0o700)
            for name in ['apply.py', 'MANIFEST.json', *m['files']]:
                h.atomic(BUNDLE / name, read(STAGE / name), 0o600)
            source, target, traced = m['before_loaded_sha256'], after, True
        elif action == 'rollback':
            need((STATE / 'apply-result.json').exists() and disk(m) == m['after_loaded_sha256'], 'application_unconfirmed')
            source, target, traced = m['after_loaded_sha256'], before, False
        else:
            need((STATE / 'rollback-result.json').exists() and disk(m) == m['before_loaded_sha256'], 'rollback_unconfirmed')
            source, target, traced = m['before_loaded_sha256'], after, True
        need(not (STATE / action).exists(), 'phase_already_consumed')
        save(h, STATE / (action + '-intent.json'), {'state': 'intent_before_node_deployment', 'at': time.time(),
            'phase': action, 'manifest_sha256': MANIFEST_SHA, 'household_before': current,
            'admission': admission_receipt, 'automatic_retry': False})
        h.directory(STATE / action, 0o700)
        h.directory(STATE / action / 'client-events', 0o700)
        proof = api(m, h, action, source, target, traced)
        need(proof['loaded_sha256'] == digest(target) == disk(m), 'loaded_or_persisted_result_unconfirmed')
        need(services() == current and identity() == json.loads(read(STAGE / 'nodered-identity.json')),
            'household_start_times_changed')
        row = {'state': 'confirmed_' + action + '_with_native_full_dry_run', 'at': time.time(), 'phase': action,
            'loaded_sha256': proof['loaded_sha256'], 'revision': proof['revision'], 'changed_functions': 6,
            'replay': proof['replay'], 'session_revoked': proof['session_revoked'], 'services_restarted': 0,
            'admission': admission_receipt,
            'physical_effects': 0, 'new_access_or_expiry': False, 'automatic_retry': False}
        save(h, STATE / (action + '-result.json'), row)
        print(json.dumps(row))

if __name__ == '__main__':
    try:
        if Path(__file__) == BUNDLE / 'apply.py':
            STAGE = BUNDLE
        if Path(__file__) == REVISION_BUNDLE / 'apply.py':
            STAGE = REVISION_BUNDLE
        need(Path(__file__) == STAGE / 'apply.py' and len(sys.argv) == 2, 'fixed_entrypoint_required')
        main(sys.argv[1])
    except Exception as exc:
        print(json.dumps({'state': 'unconfirmed', 'exception_kind': type(exc).__name__,
            'reason': str(exc) if type(exc) is ValueError else 'withheld', 'automatic_retry': False}))
        raise SystemExit(1)
