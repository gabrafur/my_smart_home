"""Root operator for gateway_derive.py (verbs: prepare, apply, verify, rollback); CAS, before-images kept."""
import hashlib, json, os, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
GATEWAY = Path('/usr/local/lib/raspberry-maintenance/gateway.py')
OWNER = Path('/etc/raspberry-maintenance/owner-policy.json')
BEFORE = HERE / 'before'
def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))
def mod():
    sys.path.insert(0, str(HERE / 'sources'))
    import gateway_derive
    return gateway_derive
def write(path, body):
    st = path.stat(); fd, tmp = tempfile.mkstemp(prefix='.gw-rollback-', dir=path.parent)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o777); os.replace(tmp, path)
def sha(b): return hashlib.sha256(b).hexdigest()
def prepare():
    need(os.geteuid() == 0, 'root_required')
    g, o = GATEWAY.read_bytes(), OWNER.read_bytes()
    ga, oa = mod().derive(g, o)
    return g, o, ga, oa
def apply():
    need(not BEFORE.exists(), 'existing_apply_inspect')
    g, o, ga, oa = prepare()
    BEFORE.mkdir(mode=0o700); (BEFORE / 'gateway.py').write_bytes(g); (BEFORE / 'owner-policy.json').write_bytes(o)
    need(OWNER.read_bytes() == o, 'owner_changed'); write(OWNER, oa)
    need(GATEWAY.read_bytes() == g, 'gateway_changed'); write(GATEWAY, ga)
    return {'state': 'applied', 'gateway': sha(ga), 'owner_policy': sha(oa)}
def verify():
    ga, oa = mod().derive((BEFORE / 'gateway.py').read_bytes(), (BEFORE / 'owner-policy.json').read_bytes())
    ok = GATEWAY.read_bytes() == ga and OWNER.read_bytes() == oa
    return {'state': 'verified' if ok else 'not_verified'}
def rollback():
    need(os.geteuid() == 0 and BEFORE.exists(), 'nothing_to_roll_back')
    write(GATEWAY, (BEFORE / 'gateway.py').read_bytes()); write(OWNER, (BEFORE / 'owner-policy.json').read_bytes())
    return {'state': 'rolled_back'}
if __name__ == '__main__':
    verb = sys.argv[1]; need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    fn = {'prepare': lambda: dict(state='prepared', after=sha(prepare()[2])), 'apply': apply, 'verify': verify, 'rollback': rollback}[verb]
    print(json.dumps(fn(), sort_keys=True))
