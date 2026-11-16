"""Root operator: upgrade the installed lighting route from v1 to v2 (verbs: prepare, apply, verify, rollback).

v2 records every lighting call in the frontend audit and adds a household_lights block
to maintenance_capabilities. Compare-and-swap on the exact v1 bytes; the original
private-content route before-image comes from the first install.
"""
import hashlib, json, os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'sources'
APP = Path('/var/lib/raspberry-mcp/root/app')
ROUTE, LIGHTS = APP / 'private-content-route.mjs', APP / 'lights-route.mjs'
ORIGINAL = HERE / 'BEFORE-private-content-route.mjs'
V1_LIGHTS = '597e75186419991000266523ff101b5caf770b1829e909aac26d7cabbd89f0b0'
SAVED = HERE / 'BEFORE-V1'


def sha(b):
    return hashlib.sha256(b).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def overlay():
    sys.path.insert(0, str(SRC))
    import overlay as o
    return o


def write(path, body):
    tmp = path.with_name('.' + path.name + '.ha-lights-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def plan():
    need(os.geteuid() == 0, 'root_required')
    o = overlay()
    original = ORIGINAL.read_bytes()
    need(sha(original) == o.BASELINE, 'original_before_image')
    need(sha(LIGHTS.read_bytes()) == V1_LIGHTS, 'installed_lights_route_not_v1')
    need(ROUTE.read_bytes() == o.derive(original, o.TAIL_V1), 'installed_overlay_not_v1')
    return o, original


def prepare():
    o, original = plan()
    return {'state': 'prepared', 'lights_after': sha((SRC / 'lights-route.mjs').read_bytes()),
            'route_after': sha(o.derive(original))}


def apply():
    o, original = plan()
    SAVED.mkdir(mode=0o700, exist_ok=True)
    (SAVED / 'lights-route.mjs').write_bytes(LIGHTS.read_bytes())
    (SAVED / 'private-content-route.mjs').write_bytes(ROUTE.read_bytes())
    write(LIGHTS, (SRC / 'lights-route.mjs').read_bytes())
    write(ROUTE, o.derive(original))
    return dict(verify(), state='applied')


def verify():
    o = overlay()
    ok = (sha(LIGHTS.read_bytes()) == sha((SRC / 'lights-route.mjs').read_bytes())
          and ROUTE.read_bytes() == o.derive(ORIGINAL.read_bytes()))
    return {'state': 'verified' if ok else 'not_verified', 'lights': sha(LIGHTS.read_bytes()), 'route': sha(ROUTE.read_bytes())}


def rollback():
    need(os.geteuid() == 0 and SAVED.exists(), 'nothing_to_roll_back')
    write(LIGHTS, (SAVED / 'lights-route.mjs').read_bytes())
    write(ROUTE, (SAVED / 'private-content-route.mjs').read_bytes())
    return {'state': 'rolled_back_to_v1'}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'rollback'), 'verb')
    print(json.dumps({'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}[verb](), sort_keys=True))
