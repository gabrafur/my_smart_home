"""Root operator for derive.py.

prepare/apply/verify/rollback: install the patched native_binding.py and move its pins
(compare-and-swap, before-images kept beside the operator).
recover: after install, check the live afterimages and services of ONE fixed own
rollback that is uncertain only in a start phase, then write its immutable completion
proof once. Nothing is replayed or restarted.
"""
import hashlib, json, os, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
C = Path('/etc/raspberry-maintenance')
STATE = Path('/var/lib/raspberry-maintenance-install')
PATHS = {'native_binding': Path('/usr/local/lib/raspberry-maintenance-installer/native_binding.py'),
         'owner_policy': C / 'owner-policy.json', 'install_enrollment': C / 'install-enrollment.json',
         'package_enrollment_approval': C / 'package-enrollment-approval.json',
         'catalogue_manifest': C / 'catalogue-manifest.json', 'bootstrap_manifest': C / 'bootstrap-manifest.json'}
ORDER = ('owner_policy', 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest', 'bootstrap_manifest', 'native_binding')
BEFORE = HERE / 'before'
OP = 'a07905fd68a3a82c79c5802d39473e86'
SOURCES = {'client_events_worker': '/usr/local/lib/raspberry-mcp-events/worker.py',
           'client_continuation_policy': '/usr/local/lib/raspberry-task-terminal-observer/client-policy.json',
           'client_repair_projection': '/usr/local/lib/raspberry-repair-control/event_projection.mjs',
           'client_frontend_projection': '/var/lib/raspberry-mcp/root/app/event_projection.mjs'}
REFERENCES = {'repair': '/usr/local/lib/raspberry-repair-control/policy.json',
              'component': '/usr/local/lib/raspberry-component-repair/policy.json',
              'job': '/etc/systemd/system/raspberry-component-job@.service',
              'validate': '/etc/systemd/system/raspberry-component-validate@.service',
              'guard': '/etc/systemd/system/raspberry-component-guard@.service'}
UNITS = {'events': 'raspberry-mcp-events.service', 'socket': 'raspberry-mcp.socket', 'tunnel': 'raspberry-mcp-tunnel.service'}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def derive_mod():
    sys.path.insert(0, str(HERE / 'sources'))
    import derive
    return derive


def current():
    return {k: p.read_bytes() for k, p in PATHS.items()}


def write(path, body, mode=None):
    st = path.stat() if path.exists() else None
    fd, tmp = tempfile.mkstemp(prefix='.rb-completion-', dir=path.parent)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, st.st_uid if st else 0, st.st_gid if st else 0)
    os.chmod(tmp, (st.st_mode & 0o777) if st else mode)
    os.replace(tmp, path)


def prepare():
    need(os.geteuid() == 0, 'root_required')
    before = current()
    after = derive_mod().derive(before)
    return before, after, {'state': 'prepared', 'before': {k: sha(v) for k, v in before.items()}, 'after': {k: sha(v) for k, v in after.items()}}


def apply():
    need(not BEFORE.exists(), 'existing_apply_inspect')
    before, after, plan = prepare()
    BEFORE.mkdir(mode=0o700)
    for k, v in before.items():
        (BEFORE / k).write_bytes(v)
    written = []
    try:
        for k in ORDER:
            need(PATHS[k].read_bytes() == before[k], k + '_changed_during_apply')
            write(PATHS[k], after[k]); written.append(k)
        state = 'applied'
    except SystemExit as stop:
        state = 'stopped_partial'; plan['reason'] = str(stop)
    except Exception as error:
        state = 'uncertain_partial'; plan['reason'] = type(error).__name__
    return dict(plan, state=state, written=written)


def verify():
    after = derive_mod().derive({k: (BEFORE / k).read_bytes() for k in PATHS})
    live = current()
    return {'state': 'verified' if all(live[k] == after[k] for k in PATHS) else 'not_verified',
            'mismatch': [k for k in PATHS if live[k] != after[k]]}


def recover():
    need(os.geteuid() == 0 and verify()['state'] == 'verified', 'patched_native_binding_not_installed')
    base = STATE / 'client-lifecycle'
    target = base / 'rollback-completions' / (OP + '.json')
    need(not target.exists(), 'existing_proof_observe_only')
    need(not (base / 'revoke-fence.json').exists(), 'revoke_fence_present')
    life_raw = (base / 'operations' / (OP + '.json')).read_bytes()
    file_raw = (STATE / 'receipts' / (OP + '.json')).read_bytes()
    refs_raw = (base / 'source-refs' / (OP + '.json')).read_bytes()
    life, file, refs = json.loads(life_raw), json.loads(file_raw), json.loads(refs_raw)
    need(life['state'] == 'uncertain_observe_only' and life['verb'] == 'rollback'
         and life['phase'] in ('events_start_pending', 'socket_start_pending', 'tunnel_start_pending'), 'lifecycle_not_start_uncertain_rollback')
    need(file['state'] == 'own_rollback_configuration_only' and file['own_sources_restored'] is True, 'file_receipt_not_restored')
    need(refs['state'] == 'references_restored' and refs['restore'] is True, 'references_not_restored')
    live_sources = {slot: sha(Path(p).read_bytes()) for slot, p in SOURCES.items()}
    live_refs = {k: sha(Path(p).read_bytes()) for k, p in REFERENCES.items()}
    need(live_sources == file['rollback_after_hashes'], 'live_sources_differ')
    need(live_refs == refs['after_hashes'], 'live_references_differ')
    services = {}
    for key, unit in UNITS.items():
        r = subprocess.run(['/usr/bin/systemctl', 'is-active', unit], capture_output=True, text=True, timeout=10)
        services[key] = r.stdout.strip()
    need(services == {'events': 'active', 'socket': 'active', 'tunnel': 'active'}, 'services_not_active')
    proof = {'source': 'Root_observed_own_rollback_completion_v1', 'operation_id': OP,
             'own_operation_id': life['own_operation_id'], 'package_id': life['package_id'],
             'lifecycle_sha256': sha(life_raw), 'file_sha256': sha(file_raw), 'references_sha256': sha(refs_raw),
             'live_sources': live_sources, 'live_references': live_refs, 'services': services,
             'worker_sha256': live_sources['client_events_worker'], 'observed_at': time.time()}
    folder = base / 'rollback-completions'
    if not folder.exists():
        folder.mkdir(mode=0o700)
    os.chown(folder, 0, 0); os.chmod(folder, 0o700)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as h:
        h.write(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()); h.flush(); os.fsync(h.fileno())
    return {'state': 'proof_written', 'operation_id': OP, 'services': services}


def rollback():
    need(os.geteuid() == 0 and BEFORE.exists(), 'nothing_to_roll_back')
    for k in reversed(ORDER):
        write(PATHS[k], (BEFORE / k).read_bytes())
    return {'state': 'rolled_back', 'live': {k: sha(v) for k, v in current().items()}}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'recover', 'rollback'), 'verb')
    fn = {'prepare': lambda: prepare()[2], 'apply': apply, 'verify': verify, 'recover': recover, 'rollback': rollback}[verb]
    print(json.dumps(fn(), sort_keys=True))
