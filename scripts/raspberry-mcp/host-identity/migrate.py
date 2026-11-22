"""Root operator: move installed MCP components from personal identifiers to logical roles.

Verbs: prepare (read-only plan), apply, verify, rollback. One invocation per verb; no
automatic retry; nothing is restarted.

What changes on the Raspberry (compare-and-swap against the exact previously published
bytes, pinned below by sha256; any other installed byte refuses with `installed_bytes_unexpected`):

* codex-account-status: broker.cjs derives the control socket from HOME; the unit's
  User=/Group= are rendered for the `host_operator` account.
* codex-peer-reenroll (only when installed): reenroll.py derives the operator home from the
  sealed enrollment uid; the unit's ConditionPathExists is rendered for that home.
* ha-lights: the household action `workstation_primary` replaces the former personal
  target key in policy.json and lights-route.mjs. Optional deprecated aliases come from a
  Root-owned private JSON file (HA_LIGHTS_LEGACY_ACTION_ALIASES_FILE, e.g.
  {"<old_key>": "workstation_primary"}) and are rendered into BOTH the installed policy
  and route, so connections opened before the change, and assistant prompts that still
  name the old key, keep working during the migration window.

The host_operator account comes from RASPBERRY_HOST_OPERATOR or SUDO_USER (host_operator.py).
Sources are read from this repository checkout and pinned by sha256, so the reviewed operator
hash covers what gets installed. Before-images and the applied alias set are kept in STATE.
Afterwards `systemctl daemon-reload` is run (unit files only, no service restart). The MCP
frontend loads the new route on its next connection; restarting raspberry-mcp-tunnel.service
to force that needs the owner's explicit approval and is NOT done here.
"""
import hashlib
import json
import os
import re
import socket
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MCP = HERE.parent
sys.path.insert(0, str(MCP))
import host_operator  # noqa: E402

STATE = Path('/var/lib/raspberry-mcp-host-identity')
APP = Path('/var/lib/raspberry-mcp/root/app')
UNITS = Path('/etc/systemd/system')
LIGHTS_SOCK = '/run/raspberry-mcp/ha-lights.sock'
ALIAS_ENV = 'HA_LIGHTS_LEGACY_ACTION_ALIASES_FILE'
ALIAS_LINE = 'const LEGACY_ACTION_ALIASES=Object.freeze({});'
KEY = re.compile(r'[a-z0-9_]{1,48}\Z')

# installed path -> (component, source relative to scripts/raspberry-mcp, previous sha256,
#                    source template sha256, how the bytes are produced)
FILES = {
    Path('/usr/local/lib/raspberry-codex-account-status/broker.cjs'): (
        'codex-account-status', 'codex-account-status/broker.cjs',
        '487c8996f737ab4d0819052a33df4c57424bfc139e38064b751b532a2d236658',
        '5c415be18b76623b798eae88bebe3edaab0cdea7d31fd44847a7a7570adbedcf', 'copy'),
    UNITS / 'raspberry-codex-account-status@.service': (
        'codex-account-status', 'codex-account-status/raspberry-codex-account-status@.service',
        '6b90e15abb2fecd5245e67628f9bdf961b94e117fe7cdcffeef8631de04063af',
        'bb66cd72b82a5bb24c616995f00971491549f6066ed06a88201d761c9fac90c0', 'operator'),
    Path('/usr/local/lib/raspberry-task-peer-reenroll/reenroll.py'): (
        'codex-peer-reenroll', 'codex-peer-reenroll/reenroll.py',
        '322ce512a3c84e4ad5bdfd9dbe0a65bf7bc884376435cf448eb964ef40f4f8c8',
        '06acbb2e4575f7c6534296f99eb854e2b0f6d5b9b64f1eacca2f6685149eb022', 'copy'),
    UNITS / 'raspberry-task-peer-reenroll.service': (
        'codex-peer-reenroll', 'codex-peer-reenroll/raspberry-task-peer-reenroll.service',
        '29ece5d42e427f25bf49608802338e8642a9e87f16aa94355098ec3e9c8331a7',
        '051d7a4dc1052d4cfca1fed55f2eb0d5927a07117530e7d10c7b7f1b18044672', 'operator'),
    Path('/usr/local/lib/raspberry-ha-lights/policy.json'): (
        'ha-lights', 'ha-lights/policy.json',
        'a7d12204e252b0c1be0d8936ae5766b562d1e9e1fd4174ebec2368f3c2423c00',
        '96865b2780477fb186046b6dff543c7784cda6b6f273812149d77064bfdf4c33', 'policy'),
    APP / 'lights-route.mjs': (
        'ha-lights', 'ha-lights/lights-route.mjs',
        'f387f7728fda7f8878fd502639e3a730da9989f28fded4ab9de1058c91b1bd67',
        '589a1e6832520807f729bdb1d5731cf6fa7ee5e262169149cf11e6cfd77aca12', 'route'),
}
# Components that may legitimately be absent (never installed) are skipped, not created.
OPTIONAL = {'codex-peer-reenroll'}


class Refused(Exception):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


# ---------- pure rendering (unit tested) ----------

def validate_aliases(aliases, policy):
    need(type(aliases) is dict and len(aliases) <= 4, 'alias_file_shape')
    actions = policy.get('actions', {})
    for old, new in aliases.items():
        need(type(old) is str and KEY.fullmatch(old) and type(new) is str, 'alias_key_invalid')
        need(old not in actions and old not in policy.get('targets', {}), 'alias_collides_with_registered_key')
        need(new in actions, 'alias_target_not_registered')
    need(len(actions) + len(aliases) <= 16, 'alias_exceeds_action_limit')
    return dict(sorted(aliases.items()))


def render_policy(template, aliases):
    """Tracked policy -> installed policy with each alias registered as a copy of its target."""
    if not aliases:
        return template
    policy = json.loads(template)
    for old, new in validate_aliases(aliases, policy).items():
        policy['actions'][old] = dict(policy['actions'][new])
    return (json.dumps(policy, ensure_ascii=False, indent=1) + '\n').encode()


def render_route(template, aliases):
    """Tracked route -> installed route with the deprecated aliases rendered into one line."""
    text = template.decode()
    need(text.count(ALIAS_LINE) == 1, 'route_alias_anchor')
    if not aliases:
        return template
    rendered = 'const LEGACY_ACTION_ALIASES=Object.freeze(%s);' % json.dumps(
        dict(sorted(aliases.items())), separators=(',', ':'))
    return text.replace(ALIAS_LINE, rendered).encode()


def produce(kind, template, operator, aliases, policy_template):
    if kind == 'copy':
        return template
    if kind == 'operator':
        return host_operator.render(template, operator)
    if kind == 'policy':
        return render_policy(template, aliases)
    validate_aliases(aliases, json.loads(policy_template))
    return render_route(template, aliases)


# ---------- host side ----------

def template(rel, pinned):
    body = (MCP / rel).read_bytes()
    need(sha(body) == pinned, 'source_pin_mismatch:' + rel)
    return body


def load_aliases(environ=os.environ):
    path = environ.get(ALIAS_ENV)
    if not path:
        return {}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        st = os.fstat(handle.fileno())
        need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and st.st_size <= 4096,
             'alias_file_unsealed')
        return json.loads(handle.read())


def write(path, body, mode=0o644):
    tmp = path.with_name('.' + path.name + '.host-identity-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(body); handle.flush(); os.fsync(handle.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode); os.replace(tmp, path)


def applied_aliases():
    try:
        return json.loads((STATE / 'applied-aliases.json').read_text())
    except FileNotFoundError:
        return {}


def desired(operator, aliases):
    policy_template = template(FILES[Path('/usr/local/lib/raspberry-ha-lights/policy.json')][1],
                               FILES[Path('/usr/local/lib/raspberry-ha-lights/policy.json')][3])
    return {path: produce(kind, template(rel, pinned), operator, aliases, policy_template)
            for path, (_, rel, _, pinned, kind) in FILES.items()}


def plan(operator, aliases):
    """Per installed file: legacy (previous bytes), current (already migrated), absent or refused."""
    want = desired(operator, aliases)
    was = desired(operator, applied_aliases()) if (STATE / 'applied-aliases.json').exists() else {}
    rows, absent = {}, set()
    for path, (component, _, previous, _, _) in FILES.items():
        if not path.exists():
            need(component in OPTIONAL, 'installed_file_missing:' + str(path))
            absent.add(component); rows[path] = 'absent'; continue
        body = path.read_bytes()
        rows[path] = ('legacy' if sha(body) == previous else 'current' if body == want[path]
                      else 'migrated_other_aliases' if was.get(path) == body else 'unexpected')
        need(rows[path] != 'unexpected', 'installed_bytes_unexpected:' + str(path))
    for path, (component, *_) in FILES.items():
        need(component not in absent or rows[path] == 'absent', 'component_partially_installed:' + component)
    return rows, want


def systemctl(*args):
    return subprocess.run(['/usr/bin/systemctl', *args], capture_output=True, text=True, timeout=60)


def actions_read():
    s = socket.socket(socket.AF_UNIX); s.settimeout(25); s.connect(LIGHTS_SOCK)
    s.sendall(json.dumps({'name': 'ha_actions_read', 'arguments': {'host': 'raspberry'}}).encode() + b'\n')
    s.shutdown(socket.SHUT_WR); out = b''
    while True:
        block = s.recv(65536)
        if not block:
            break
        out += block
    return json.loads(out)


def context():
    need(os.geteuid() == 0, 'root_required')
    try:
        operator = host_operator.resolve()
    except host_operator.OperatorUnresolved as error:
        raise Refused(str(error)) from None
    return operator, load_aliases()


def prepare():
    operator, aliases = context()
    rows, want = plan(operator, aliases)
    return {'state': 'prepared', 'host_operator': 'resolved', 'aliases': len(aliases),
            'files': {str(p): {'installed': r, 'after': sha(want[p]) if r != 'absent' else None} for p, r in rows.items()}}


def apply():
    operator, aliases = context()
    rows, want = plan(operator, aliases)
    STATE.mkdir(mode=0o700, exist_ok=True)
    for path, row in rows.items():
        before = STATE / ('BEFORE-' + path.name)
        if row == 'legacy' and not before.exists():
            before.write_bytes(path.read_bytes()); os.chmod(before, 0o600)
    for path, row in rows.items():
        if row != 'absent' and path.read_bytes() != want[path]:
            write(path, want[path])
    (STATE / 'applied-aliases.json').write_text(json.dumps(dict(sorted(aliases.items()))) + '\n')
    reload = systemctl('daemon-reload')
    return dict(verify(), reload=reload.returncode, new_mcp_connection_required=True,
                note='the next MCP connection loads the new route; restarting the tunnel needs owner approval')


def verify():
    operator, _ = context()
    aliases = applied_aliases()
    rows, want = plan(operator, aliases)
    files = {str(p): r == 'current' or r == 'absent' for p, r in rows.items()}
    read = actions_read()
    keys = [row.get('target') for row in read.get('actions', [])] if isinstance(read.get('actions'), list) else []
    ok = all(files.values()) and 'workstation_primary' in keys and read.get('collection_error') in (None, '')
    return {'state': 'verified' if ok else 'not_verified', 'files': files, 'aliases': len(aliases),
            'workstation_primary_registered': 'workstation_primary' in keys, 'broker_error': read.get('collection_error')}


def rollback():
    need(os.geteuid() == 0 and STATE.exists(), 'nothing_to_roll_back')
    restored = []
    for path in FILES:
        before = STATE / ('BEFORE-' + path.name)
        if before.exists():
            write(path, before.read_bytes()); restored.append(str(path))
    systemctl('daemon-reload')
    return {'state': 'rolled_back', 'restored': restored}


if __name__ == '__main__':
    verb = sys.argv[1] if len(sys.argv) == 2 else ''
    try:
        if verb not in ('prepare', 'apply', 'verify', 'rollback'):
            raise Refused('verb')
        print(json.dumps({'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}[verb](),
                         sort_keys=True))
    except Refused as error:
        print(json.dumps({'state': 'refused', 'reason': str(error)}))
        sys.exit(2)
