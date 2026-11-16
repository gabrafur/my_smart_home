"""Root operator for derive.py (verbs: prepare, apply, verify, rollback). Before-images are
kept beside the operator; every write is compare-and-swap on the derived baseline."""
import hashlib, json, os, sqlite3, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
C = Path('/etc/raspberry-maintenance')
PATHS = {'fixed_installer': Path('/usr/local/lib/raspberry-maintenance-installer/fixed_installer.py'),
         'owner_policy': C / 'owner-policy.json', 'install_enrollment': C / 'install-enrollment.json',
         'package_enrollment_approval': C / 'package-enrollment-approval.json',
         'catalogue_manifest': C / 'catalogue-manifest.json', 'bootstrap_manifest': C / 'bootstrap-manifest.json'}
ORDER = ('owner_policy', 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest', 'bootstrap_manifest', 'fixed_installer')
WORKER = HERE / 'sources' / 'events-worker.py'
BEFORE = HERE / 'before'


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


def quiet():
    db = sqlite3.connect('file:/var/lib/raspberry-maintenance/core/operations.sqlite3?mode=ro', uri=True)
    try:
        return db.execute("SELECT COUNT(*) FROM operations WHERE state IN ('dispatching','uncertain')").fetchone()[0] == 0
    finally:
        db.close()


def write(path, body):
    st = path.stat()
    fd, tmp = tempfile.mkstemp(prefix='.installer-broad-', dir=path.parent)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, path)


def prepare():
    need(os.geteuid() == 0, 'root_required')
    before = current()
    after = derive_mod().derive(before, WORKER.read_bytes())
    need(quiet(), 'unresolved_maintenance_operation')
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
    before = {k: (BEFORE / k).read_bytes() for k in PATHS}
    after = derive_mod().derive(before, WORKER.read_bytes())
    live = current()
    return {'state': 'verified' if all(live[k] == after[k] for k in PATHS) else 'not_verified',
            'mismatch': [k for k in PATHS if live[k] != after[k]]}


def rollback():
    need(os.geteuid() == 0 and BEFORE.exists(), 'nothing_to_roll_back')
    for k in reversed(ORDER):
        write(PATHS[k], (BEFORE / k).read_bytes())
    return {'state': 'rolled_back', 'live': {k: sha(v) for k, v in current().items()}}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    fn = {'prepare': lambda: prepare()[2], 'apply': apply, 'verify': verify, 'rollback': rollback}[verb]
    print(json.dumps(fn(), sort_keys=True))
