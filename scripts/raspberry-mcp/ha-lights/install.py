"""Root operator for the household lighting MCP tools (verbs: prepare, apply, verify, rollback).

Installs the fixed broker, its policy and socket units, the lighting route and the
private-content route overlay. Before-images are kept in the operator directory; the
pinned maintenance entry, every other frontend file and all existing units stay
untouched. One invocation per verb; no automatic retry.
"""
import hashlib, json, os, shutil, socket, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'sources'
APP = Path('/var/lib/raspberry-mcp/root/app')
LIB = Path('/usr/local/lib/raspberry-ha-lights')
UNITS = Path('/etc/systemd/system')
ROUTE = APP / 'private-content-route.mjs'
SOCK = '/run/raspberry-mcp/ha-lights.sock'
NEW = {LIB / 'broker.py': 'broker.py', LIB / 'policy.json': 'policy.json', APP / 'lights-route.mjs': 'lights-route.mjs',
       UNITS / 'raspberry-ha-lights.socket': 'raspberry-ha-lights.socket',
       UNITS / 'raspberry-ha-lights@.service': 'raspberry-ha-lights@.service'}
BEFORE = HERE / 'BEFORE-private-content-route.mjs'


def sha(b):
    return hashlib.sha256(b).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def overlay():
    sys.path.insert(0, str(SRC))
    import overlay as o
    return o


def write(path, body, mode=0o644):
    tmp = path.with_name('.' + path.name + '.ha-lights-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode)
    os.replace(tmp, path)


def systemctl(*args):
    return subprocess.run(['/usr/bin/systemctl', *args], capture_output=True, text=True, timeout=60)


def broker_read():
    s = socket.socket(socket.AF_UNIX); s.settimeout(25); s.connect(SOCK)
    s.sendall(json.dumps({'name': 'ha_lights_read', 'arguments': {'host': 'raspberry'}}).encode() + b'\n')
    s.shutdown(socket.SHUT_WR); out = b''
    while True:
        b = s.recv(65536)
        if not b: break
        out += b
    return json.loads(out)


def prepare():
    need(os.geteuid() == 0, 'root_required')
    o = overlay()
    route = ROUTE.read_bytes()
    need(sha(route) == o.BASELINE, 'private_content_route_baseline_changed')
    need(not any(p.exists() for p in NEW), 'targets_already_present_inspect')
    need(not os.path.exists(SOCK), 'socket_already_present')
    after = o.derive(route)
    return {'state': 'prepared', 'route_before': sha(route), 'route_after': sha(after),
            'files': {str(p): sha((SRC / n).read_bytes()) for p, n in NEW.items()}}


def apply():
    plan = prepare()
    route = ROUTE.read_bytes()
    BEFORE.write_bytes(route)
    LIB.mkdir(mode=0o755, exist_ok=True); os.chown(LIB, 0, 0); os.chmod(LIB, 0o755)
    for path, name in NEW.items():
        write(path, (SRC / name).read_bytes())
    write(ROUTE, overlay().derive(route))
    reload = systemctl('daemon-reload')
    enable = systemctl('enable', '--now', 'raspberry-ha-lights.socket')
    time.sleep(1)
    return dict(plan, state='applied' if reload.returncode == enable.returncode == 0 else 'uncertain',
                reload=reload.returncode, enable=enable.returncode, enable_err=enable.stderr[-400:])


def verify():
    need(os.geteuid() == 0, 'root_required')
    o = overlay()
    files = {str(p): sha(p.read_bytes()) == sha((SRC / n).read_bytes()) for p, n in NEW.items()}
    route_ok = sha(ROUTE.read_bytes()) == sha(o.derive(BEFORE.read_bytes()))
    active = systemctl('is-active', 'raspberry-ha-lights.socket').stdout.strip()
    read = broker_read()
    lights = {r['target']: r['state'] for r in read.get('lights', [])}
    return {'state': 'verified' if all(files.values()) and route_ok and active == 'active' and read.get('state') == 'observed' else 'not_verified',
            'files': files, 'route_overlay': route_ok, 'socket': active, 'broker_state': read.get('state'),
            'broker_error': read.get('collection_error'), 'lights': lights}


def rollback():
    need(os.geteuid() == 0 and BEFORE.exists(), 'nothing_to_roll_back')
    systemctl('disable', '--now', 'raspberry-ha-lights.socket')
    write(ROUTE, BEFORE.read_bytes())
    for path in NEW:
        if path.exists(): path.unlink()
    if LIB.exists() and not any(LIB.iterdir()): LIB.rmdir()
    systemctl('daemon-reload')
    return {'state': 'rolled_back', 'route_restored': sha(ROUTE.read_bytes())}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    print(json.dumps({'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}[verb](), sort_keys=True))
