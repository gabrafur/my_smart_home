"""Root operator: install the read-only Home Assistant state broker and route (verbs: prepare, apply, verify, rollback).

private-content-route.mjs moves from the v3 overlay (lighting + Codex account) to v4, which
also wraps the state route outermost. Compare-and-swap on the exact installed v3 bytes; the
v3 bytes are kept beside this file for rollback. maintenance-entry.mjs and every policy-pinned
file stay untouched. No service is restarted: the frontend loads the route per connection.
One invocation per verb; no automatic retry.
"""
import hashlib, json, os, socket, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'sources'
APP = Path('/var/lib/raspberry-mcp/root/app')
ROUTE = APP / 'private-content-route.mjs'
LIB = Path('/usr/local/lib/raspberry-ha-states')
UNITS = Path('/etc/systemd/system')
SAVED = HERE / 'BEFORE-V3-private-content-route.mjs'
SOCK = '/run/raspberry-mcp/ha-states.sock'
V3_SHA256 = 'ac1e597a48d1830ce72cde52bf4a788d3b62e536f6e604b93937a0912fe1a6d3'
V3_TAIL = ("export function makePrivateContentRoute(...args){return makeAccountRoute(makeLightsRoute(makePrivateContentRouteBase(...args),"
           "undefined,args[3]),undefined,args[3]);}\n")
V4_TAIL = ("// Read-only Home Assistant state tool (ha_states_read); see states-route.mjs.\n"
           "import {makeStatesRoute} from './states-route.mjs';\n"
           "export function makePrivateContentRoute(...args){return makeStatesRoute(makeAccountRoute(makeLightsRoute("
           "makePrivateContentRouteBase(...args),undefined,args[3]),undefined,args[3]),undefined,args[3]);}\n")
NEW = {LIB / 'broker.py': 'broker.py', LIB / 'policy.json': 'policy.json', APP / 'states-route.mjs': 'states-route.mjs',
       UNITS / 'raspberry-ha-states.socket': 'raspberry-ha-states.socket',
       UNITS / 'raspberry-ha-states@.service': 'raspberry-ha-states@.service'}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def derive(v3):
    """Pure: v3 route bytes -> v4 route bytes (append-only change of the final export)."""
    text = v3.decode()
    need(sha(v3) == V3_SHA256, 'private_content_route_not_v3')
    need(text.endswith(V3_TAIL) and text.count(V3_TAIL) == 1 and 'states-route' not in text, 'private_content_route_anchor')
    return (text[:-len(V3_TAIL)] + V4_TAIL).encode()


def write(path, body, mode=0o644):
    tmp = path.with_name('.' + path.name + '.ha-states-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode); os.replace(tmp, path)


def systemctl(*args):
    return subprocess.run(['/usr/bin/systemctl', *args], capture_output=True, text=True, timeout=60)


def broker_read():
    s = socket.socket(socket.AF_UNIX); s.settimeout(25); s.connect(SOCK)
    s.sendall(json.dumps({'name': 'ha_states_read', 'arguments': {'host': 'raspberry', 'entity_id': 'sensor.raspberry_pi_load_5m'}}).encode() + b'\n')
    s.shutdown(socket.SHUT_WR); out = b''
    while True:
        b = s.recv(65536)
        if not b: break
        out += b
    return json.loads(out)


def prepare():
    need(os.geteuid() == 0, 'root_required')
    route = ROUTE.read_bytes()
    after = derive(route)
    need(not any(p.exists() for p in NEW) and not os.path.exists(SOCK), 'targets_already_present_inspect')
    need(Path('/mnt/data/docker/.local-secrets/ha-lights-token.txt').is_file(), 'credential_source_missing')
    return {'state': 'prepared', 'route_before': sha(route), 'route_after': sha(after),
            'files': {str(p): sha((SRC / n).read_bytes()) for p, n in NEW.items()}}


def apply():
    plan = prepare()
    route = ROUTE.read_bytes()
    SAVED.write_bytes(route)
    LIB.mkdir(mode=0o755, exist_ok=True); os.chown(LIB, 0, 0); os.chmod(LIB, 0o755)
    for path, name in NEW.items():
        write(path, (SRC / name).read_bytes())
    write(ROUTE, derive(route))
    reload = systemctl('daemon-reload')
    enable = systemctl('enable', '--now', 'raspberry-ha-states.socket')
    time.sleep(1)
    return dict(plan, state='applied' if reload.returncode == enable.returncode == 0 else 'uncertain',
                reload=reload.returncode, enable=enable.returncode, enable_err=enable.stderr[-400:])


def verify():
    need(os.geteuid() == 0 and SAVED.exists(), 'nothing_applied')
    files = {str(p): sha(p.read_bytes()) == sha((SRC / n).read_bytes()) for p, n in NEW.items()}
    route_ok = ROUTE.read_bytes() == derive(SAVED.read_bytes())
    active = systemctl('is-active', 'raspberry-ha-states.socket').stdout.strip()
    read = broker_read()
    row = (read.get('entities') or [{}])[0]
    return {'state': 'verified' if all(files.values()) and route_ok and active == 'active' and read.get('state') == 'observed' else 'not_verified',
            'files': files, 'route_v4': route_ok, 'socket': active, 'broker_state': read.get('state'),
            'broker_error': read.get('collection_error'), 'sample': {k: row.get(k) for k in ('entity_id', 'available', 'age_seconds')}}


def rollback():
    need(os.geteuid() == 0 and SAVED.exists(), 'nothing_to_roll_back')
    systemctl('disable', '--now', 'raspberry-ha-states.socket')
    write(ROUTE, SAVED.read_bytes())
    for path in NEW:
        if path.exists(): path.unlink()
    if LIB.exists() and not any(LIB.iterdir()): LIB.rmdir()
    systemctl('daemon-reload')
    return {'state': 'rolled_back_to_v3', 'route_restored': sha(ROUTE.read_bytes()) == V3_SHA256}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    print(json.dumps({'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}[verb](), sort_keys=True))
