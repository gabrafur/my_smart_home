"""Root operator: install the read-only Codex account status broker and route (verbs: prepare, apply, verify, rollback).

private-content-route.mjs moves from the lighting v2 overlay to v3, which also wraps the
account route. Compare-and-swap on the exact v2 bytes; original before-image comes from the
first lighting install. Nothing pinned by any policy changes.

The service unit is a template: User=/Group= are rendered for the host_operator account
(RASPBERRY_HOST_OPERATOR or SUDO_USER, see host_operator.py); no account name is tracked.
"""
import hashlib, json, os, subprocess, sys, tempfile, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
SRC = HERE / 'sources'
APP = Path('/var/lib/raspberry-mcp/root/app')
ROUTE = APP / 'private-content-route.mjs'
LIB = Path('/usr/local/lib/raspberry-codex-account-status')
UNITS = Path('/etc/systemd/system')
ORIGINAL = HERE / 'BEFORE-private-content-route.mjs'
SAVED = HERE / 'BEFORE-V2'
SOCK = '/run/raspberry-mcp/codex-account.sock'
NEW = {LIB / 'broker.cjs': 'broker.cjs', APP / 'account-route.mjs': 'account-route.mjs',
       UNITS / 'raspberry-codex-account-status.socket': 'raspberry-codex-account-status.socket',
       UNITS / 'raspberry-codex-account-status@.service': 'raspberry-codex-account-status@.service'}
TAIL_V3 = ("export function makePrivateContentRoute(...args){return makeAccountRoute(makeLightsRoute(makePrivateContentRouteBase(...args),"
           "undefined,args[3]),undefined,args[3]);}\n")
IMPORT = "import {makeAccountRoute} from './account-route.mjs';\n"
def sha(b): return hashlib.sha256(b).hexdigest()
def operator_module():
    for folder in (SRC, HERE.parent):
        if (folder / 'host_operator.py').exists(): sys.path.insert(0, str(folder)); break
    import host_operator as h; return h
def body(name):
    raw = (SRC / name).read_bytes()
    if not name.endswith('.service'): return raw
    h = operator_module()
    try: return h.render(raw, h.resolve())
    except h.OperatorUnresolved as e: need(False, str(e))
def need(ok, reason):
    if not ok: raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))
def overlay():
    sys.path.insert(0, str(SRC)); import overlay as o; return o
def v3(o, original):
    return o.derive(original, o.HEADER + IMPORT + TAIL_V3)
def write(path, body, mode=0o644):
    tmp = path.with_name('.' + path.name + '.account-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as h: h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode); os.replace(tmp, path)
def systemctl(*a): return subprocess.run(['/usr/bin/systemctl', *a], capture_output=True, text=True, timeout=60)
def prepare():
    need(os.geteuid() == 0, 'root_required'); o = overlay(); original = ORIGINAL.read_bytes()
    need(sha(original) == o.BASELINE, 'original_before_image')
    need(ROUTE.read_bytes() == o.derive(original), 'installed_route_not_lighting_v2')
    need(not any(p.exists() for p in NEW) and not os.path.exists(SOCK), 'targets_already_present_inspect')
    body('raspberry-codex-account-status@.service')  # resolve host_operator before any write
    return o, original
def apply():
    o, original = prepare()
    SAVED.mkdir(mode=0o700, exist_ok=True); (SAVED / 'private-content-route.mjs').write_bytes(ROUTE.read_bytes())
    LIB.mkdir(mode=0o755, exist_ok=True); os.chown(LIB, 0, 0); os.chmod(LIB, 0o755)
    for path, name in NEW.items(): write(path, body(name))
    write(ROUTE, v3(o, original))
    r1 = systemctl('daemon-reload'); r2 = systemctl('enable', '--now', 'raspberry-codex-account-status.socket'); time.sleep(1)
    return dict(verify(), reload=r1.returncode, enable=r2.returncode)
def verify():
    o = overlay()
    files = {str(p): sha(p.read_bytes()) == sha(body(n)) for p, n in NEW.items()}
    route = ROUTE.read_bytes() == v3(o, ORIGINAL.read_bytes())
    active = systemctl('is-active', 'raspberry-codex-account-status.socket').stdout.strip()
    return {'state': 'verified' if all(files.values()) and route and active == 'active' else 'not_verified', 'files': files, 'route_v3': route, 'socket': active}
def rollback():
    need(os.geteuid() == 0 and SAVED.exists(), 'nothing_to_roll_back')
    systemctl('disable', '--now', 'raspberry-codex-account-status.socket')
    write(ROUTE, (SAVED / 'private-content-route.mjs').read_bytes())
    for p in NEW:
        if p.exists(): p.unlink()
    systemctl('daemon-reload'); return {'state': 'rolled_back_to_lighting_v2'}
if __name__ == '__main__':
    verb = sys.argv[1]; need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    fn = {'prepare': lambda: (prepare(), {'state': 'prepared'})[1], 'apply': apply, 'verify': verify, 'rollback': rollback}[verb]
    print(json.dumps(fn(), sort_keys=True))
