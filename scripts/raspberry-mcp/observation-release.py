"""Install the Raspberry read-only observation release from a reviewed bundle.

Stage this file, observation-route.mjs, the three changed Python sources and
the two reviewed catalog scripts in a root-owned directory by basename.
Use plan, apply, verify or rollback. Policies retain their existing fields.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
LIB = Path('/usr/local/lib')
TASK = LIB / 'raspberry-task-control'
MCP = LIB / 'raspberry-mcp'
APP = Path('/var/lib/raspberry-mcp/root/app')
ROUTE = APP / 'private-content-route.mjs'
OVERLAY = APP / 'observation-route.mjs'
GUARD = Path('/etc/systemd/system/raspberry-component-guard@.service')
ENROLLMENT = Path('/etc/raspberry-task-control/peer-attestor-enrollment.json')
REPAIR_POLICY = LIB / 'raspberry-repair-control/policy.json'
COMPONENT_POLICY = LIB / 'raspberry-component-repair/policy.json'
CATALOG = MCP / 'project-catalog.json'
TREE = Path('/mnt/data/docker')
SOURCES = (TASK / 'task_control.py', TASK / 'task_list.py', MCP / 'maintenance_evidence.py')
EXPECTED = {
    SOURCES[0]: '3567ca7790047bfb94507f32584e8444d29d9266dcde38a92cbc23d84e6ba0d2',
    SOURCES[1]: '4107e5b3fd81a0aa32ae097552e9c8b08271c29d4521cce5f9e1f05fb5bdbf7c',
    SOURCES[2]: 'ef6bd74c4125d7442427796a71dd06134318bb5e0f8f28eb04aef0bd6c7a99c8',
    ROUTE: 'dc8d3d52395b0062886a70361271919fb9f0f30f09e8ba287e9482490d122f27',
}
ALIASES = ('scripts/git-backup.sh', 'scripts/process-git-backup-request.sh')
BINDING = re.compile(rb'\$\{[A-Z][A-Z0-9_]+\}')
ROLLBACK_TARGETS = {*SOURCES, ROUTE, OVERLAY, CATALOG, GUARD, ENROLLMENT,
                    REPAIR_POLICY, COMPONENT_POLICY, TASK / 'task-policy-v2.json'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sealed(path):
    meta = path.lstat()
    need(stat.S_ISREG(meta.st_mode) and meta.st_uid == meta.st_gid == 0 and
         meta.st_nlink == 1 and not meta.st_mode & 0o022 and meta.st_size <= 1048576,
         'unsealed_release_input')
    return path.read_bytes(), stat.S_IMODE(meta.st_mode)


def render(path, installed):
    base, _ = sealed(HERE / (path.name + '.before'))
    candidate, _ = sealed(HERE / path.name)
    need(digest(base) == EXPECTED[path], 'public_baseline_changed')
    if path == SOURCES[0]:
        # The public export wraps the numbers so they parse before binding.
        for wrapper, placeholder in ((b'int', b'${ADMIN_DELEGATE_UID}'),
                                     (b'float', b'${ADMIN_DELEGATION_EXPIRES_AT}')):
            encoded = wrapper + b"('" + placeholder + b"')"
            base = base.replace(encoded, placeholder)
            candidate = candidate.replace(encoded, placeholder)
    placeholders = list(dict.fromkeys(BINDING.findall(base)))
    if not placeholders:
        need(installed == base, 'installed_source_changed')
        return candidate
    pattern = re.escape(base)
    for i, placeholder in enumerate(placeholders):
        marker = re.escape(placeholder)
        parts = pattern.split(marker)
        pattern = parts[0] + (b'(?P<p%d>[A-Za-z0-9_./:-]{1,256})' % i) + (b'(?P=p%d)' % i).join(parts[1:])
    match = re.fullmatch(pattern, installed)
    need(match is not None, 'installed_source_changed')
    for i, placeholder in enumerate(placeholders):
        candidate = candidate.replace(placeholder, match['p%d' % i])
    need(not BINDING.search(candidate), 'unresolved_host_binding')
    return candidate


def replace_pin(policy, before, after):
    old, new = digest(before).encode(), digest(after).encode()
    need(policy.count(old) == 1, 'expected_dependency_pin_changed')
    return policy.replace(old, new)


def plan():
    rows = {}

    def change(path, update):
        before, mode = sealed(path)
        after = update(before)
        rows[path] = (before, after, mode)
        return before, after

    sources = {path: change(path, lambda raw, path=path: render(path, raw)) for path in SOURCES}
    for path, (_, after) in sources.items():
        compile(after, str(path), 'exec')

    def repin(raw, dependencies):
        for before, after in dependencies:
            raw = replace_pin(raw, before, after)
        return raw

    v2 = change(TASK / 'task-policy-v2.json', lambda raw: repin(raw, [sources[p] for p in SOURCES[:2]]))
    repair = change(REPAIR_POLICY, lambda raw: repin(raw, [sources[SOURCES[0]], sources[SOURCES[2]]]))
    component = change(COMPONENT_POLICY, lambda raw: repin(raw, [sources[SOURCES[0]], repair]))
    change(GUARD, lambda raw: replace_pin(raw, *component))
    change(ENROLLMENT, lambda raw: replace_pin(raw, *v2))

    def catalog(raw):
        data = json.loads(raw)
        for target in ALIASES:
            source, _ = sealed(HERE / Path(target).name)
            need(source == (TREE / target).read_bytes(), 'reviewed_catalog_source_changed')
            matches = [row for row in data.values() if row['path'] == target]
            need(len(matches) == 1, 'catalog_target_changed')
            matches[0]['sha256'] = digest(source)
        return (json.dumps(data, separators=(',', ':')) + '\n').encode()

    change(CATALOG, catalog)
    overlay, _ = sealed(HERE / OVERLAY.name)
    need(not os.path.lexists(OVERLAY), 'observation_overlay_exists')
    rows[OVERLAY] = (None, overlay, 0o644)

    def frontend(raw):
        need(digest(raw) == EXPECTED[ROUTE], 'private_frontend_baseline_changed')
        return (
            raw.replace(b'export function makePrivateContentRoute(', b'function makePreviousPrivateContentRoute(')
            + b"\nimport {makeObservationRoute} from './observation-route.mjs';\n"
            + b"export function makePrivateContentRoute(...args) {\n"
            + b"  return makeObservationRoute(makePreviousPrivateContentRoute(...args), args[2], args[3]);\n}\n")

    change(ROUTE, frontend)
    return rows


def write(path, data, mode):
    fd, filename = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, path)
    finally:
        Path(filename).unlink(missing_ok=True)


def expect(path, raw):
    need(not os.path.lexists(path) if raw is None else sealed(path)[0] == raw, 'deployment_compare_mismatch')


def recorded():
    folder = HERE / 'rollback'
    data, _ = sealed(folder / 'manifest.json')
    rows = {}
    for i, row in enumerate(json.loads(data)):
        path = Path(row['path'])
        need(path in ROLLBACK_TARGETS and path not in rows, 'rollback_target_changed')
        before = sealed(folder / f'before-{i}')[0] if row['before'] else None
        after = sealed(folder / f'after-{i}')[0]
        rows[path] = before, after, row['mode']
    need(set(rows) == ROLLBACK_TARGETS, 'rollback_targets_incomplete')
    return rows


def apply(rows):
    folder = HERE / 'rollback'
    folder.mkdir(mode=0o700)
    manifest = []
    for i, (path, (before, after, mode)) in enumerate(rows.items()):
        expect(path, before)
        if before is not None:
            write(folder / f'before-{i}', before, 0o600)
        write(folder / f'after-{i}', after, 0o600)
        manifest.append({'path': str(path), 'before': before is not None, 'mode': mode})
    write(folder / 'manifest.json', json.dumps(manifest).encode(), 0o600)
    completed = []
    try:
        for path, (before, after, mode) in rows.items():
            expect(path, before)
            write(path, after, mode)
            completed.append(path)
        for path, (_, after, _) in rows.items():
            expect(path, after)
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=15)
    except BaseException:
        for path in reversed(completed):
            restore(path, *rows[path])
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=15)
        raise


def restore(path, before, after, mode):
    expect(path, after)
    if before is None:
        path.unlink()
    else:
        write(path, before, mode)


if __name__ == '__main__':
    verb, = sys.argv[1:]
    need(os.geteuid() == 0 and HERE.stat().st_uid == 0 and not HERE.stat().st_mode & 0o077,
         'private_root_release_directory_required')
    if verb in ('plan', 'apply'):
        rows = plan()
        if verb == 'apply':
            apply(rows)
    else:
        need(verb in ('verify', 'rollback'), 'unknown_release_verb')
        rows = recorded()
        for path, (_, after, _) in rows.items():
            expect(path, after)
        if verb == 'rollback':
            for path, row in reversed(rows.items()):
                restore(path, *row)
            subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=15)
    print(json.dumps({'state': verb, 'files': len(rows)}))
