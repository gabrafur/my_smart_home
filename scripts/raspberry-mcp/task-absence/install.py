"""Root operator: typed absence for codex_task_status and two more read-only states.

Verbs: selftest (no Root, sources only), prepare, apply, verify, rollback.
private-content-route.mjs moves from v4 to v5 (append-only change of the final export);
the state route and policy are replaced compare-and-swap. Every previous byte is kept
beside this file for rollback. No service is restarted: the frontend loads the route per
connection and the state broker reads its policy per request. No automatic retry.
"""
import hashlib, json, os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = Path('/var/lib/raspberry-mcp/root/app')
LIB = Path('/usr/local/lib/raspberry-ha-states')
ROUTE = APP / 'private-content-route.mjs'
V4_SHA256 = '6a8daa3c85f1ab8d7f8c33d47f3a926ee387e1a2891e5711bd21fc6c0b40e3b2'
V4_TAIL = 'export function makePrivateContentRoute(...args){return makeStatesRoute('
# name -> (target, repository source, installed sha256 or None when new, new sha256)
FILES = {
    'task-absence-route.mjs': (APP / 'task-absence-route.mjs', 'task-absence/task-absence-route.mjs', None, 'ac7ce5db10154e8d7955d8d39d1e38e04acfb3134d625b9a488fb53ca7f12fb1'),
    'states-route.mjs': (APP / 'states-route.mjs', 'ha-states/states-route.mjs', 'df2283df095bd90e526282bd3389d67a16ab7b32b8a2705bc990680081a2e38b', '58033209d2dc400dd94b58a6a1ce633205237f7cf46820d4afe079ad5a3e9a8f'),
    'policy.json': (LIB / 'policy.json', 'ha-states/policy.json', '1de175b557300e8ce963e4e03318874e711c402f0fd22b76d09690e9a7444705', 'b0dfa83338ca355118c0e6e48076ecf57b76681fe22ef668287b52ce4a2a7f67'),
}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def source(name):
    bundled = HERE / 'sources' / name
    path = bundled if bundled.is_file() else HERE.parent / FILES[name][1]
    body = path.read_bytes()
    need(sha(body) == FILES[name][3], 'source_hash_' + name.replace('.', '_').replace('-', '_'))
    return body


def derive(v4):
    """Pure: v4 route bytes -> v5 route bytes."""
    text = v4.decode()
    need(sha(v4) == V4_SHA256, 'private_content_route_not_v4')
    need(text.count(V4_TAIL) == 1 and text.endswith(';}\n') and 'task-absence' not in text, 'private_content_route_anchor')
    head, tail = text.split(V4_TAIL)
    return (head + '// Typed absence for codex_task_status; see task-absence-route.mjs.\n'
            "import {makeTaskAbsenceRoute} from './task-absence-route.mjs';\n"
            + V4_TAIL.replace('return makeStatesRoute(', 'return makeTaskAbsenceRoute(makeStatesRoute(')
            + tail[:-len(';}\n')] + ');}\n').encode()


def write(path, body, mode):
    tmp = path.with_name('.' + path.name + '.task-absence-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(body); handle.flush(); os.fsync(handle.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode); os.replace(tmp, path)


def selftest():
    for name in FILES:
        source(name)
    return {'state': 'sources_match', 'files': sorted(FILES)}


def prepare():
    need(os.geteuid() == 0, 'root_required')
    for name, (path, _, before, _) in FILES.items():
        source(name)
        need((not path.exists()) if before is None else sha(path.read_bytes()) == before, 'installed_bytes_' + name)
    after = derive(ROUTE.read_bytes())
    return {'state': 'prepared', 'route_before': V4_SHA256, 'route_after': sha(after)}


def apply():
    plan = prepare()
    saved = HERE / 'BEFORE'
    saved.mkdir(mode=0o700)
    (saved / ROUTE.name).write_bytes(ROUTE.read_bytes())
    for name, (path, _, before, _) in FILES.items():
        if before is not None:
            (saved / name).write_bytes(path.read_bytes())
    # The wrapper is written last, after the module it imports exists.
    for name, (path, *_) in FILES.items():
        write(path, source(name), 0o644)
    write(ROUTE, derive((saved / ROUTE.name).read_bytes()), 0o644)
    return dict(plan, state='applied')


def verify():
    need(os.geteuid() == 0, 'root_required')
    files = {name: sha(path.read_bytes()) == after for name, (path, _, _, after) in FILES.items()}
    route = ROUTE.read_bytes() == derive((HERE / 'BEFORE' / ROUTE.name).read_bytes())
    return {'state': 'verified' if route and all(files.values()) else 'not_verified', 'files': files, 'route_v5': route}


def rollback():
    need(os.geteuid() == 0, 'root_required')
    saved = HERE / 'BEFORE'
    need((saved / ROUTE.name).is_file(), 'nothing_to_roll_back')
    write(ROUTE, (saved / ROUTE.name).read_bytes(), 0o644)
    for name, (path, _, before, _) in FILES.items():
        if before is None:
            path.unlink(missing_ok=True)
        else:
            write(path, (saved / name).read_bytes(), 0o644)
    return {'state': 'rolled_back_to_v4', 'route_restored': sha(ROUTE.read_bytes()) == V4_SHA256}


if __name__ == '__main__':
    verb = sys.argv[1]
    actions = {'selftest': selftest, 'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}
    need(verb in actions, 'verb')
    print(json.dumps(actions[verb](), sort_keys=True))
