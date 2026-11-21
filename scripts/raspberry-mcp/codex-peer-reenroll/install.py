"""Root operator: install the Codex peer re-enrollment service and timer.

Verbs: prepare (read-only), apply, verify, status (read-only registry provenance proof of
the currently enrolled binary), rollback. Sources are pinned by sha256 below, so the
reviewed operator hash covers what gets installed. Nothing is restarted: the timer only
adds a periodic check; the enrollment changes only through reenroll.py's own guards.
One invocation per verb; no automatic retry.
"""
import hashlib, json, os, subprocess, sys, time
from pathlib import Path

SRC = Path('/mnt/data/docker/scripts/raspberry-mcp/codex-peer-reenroll')
LIB = Path('/usr/local/lib/raspberry-task-peer-reenroll')
UNITS = Path('/etc/systemd/system')
STATUS = Path('/var/lib/raspberry-task-peer-reenroll/status.json')
FILES = {
    LIB / 'reenroll.py': ('reenroll.py', '322ce512a3c84e4ad5bdfd9dbe0a65bf7bc884376435cf448eb964ef40f4f8c8'),
    UNITS / 'raspberry-task-peer-reenroll.service':
        ('raspberry-task-peer-reenroll.service', '29ece5d42e427f25bf49608802338e8642a9e87f16aa94355098ec3e9c8331a7'),
    UNITS / 'raspberry-task-peer-reenroll.timer':
        ('raspberry-task-peer-reenroll.timer', '6dcb741ee2b97d7b9c35559d04e83f29ae7a2db80abaaddcc037c8e12b6a7018'),
}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def need(ok, reason):
    if not ok:
        raise SystemExit(json.dumps({'state': 'refused', 'reason': reason}))


def source(name, expected):
    body = (SRC / name).read_bytes()
    need(sha(body) == expected, 'source_pin_mismatch:' + name)
    return body


def write(path, body, mode=0o644):
    tmp = path.with_name('.' + path.name + '.reenroll-install-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as h:
        h.write(body); h.flush(); os.fsync(h.fileno())
    os.chown(tmp, 0, 0); os.chmod(tmp, mode); os.replace(tmp, path)


def systemctl(*args, timeout=60):
    return subprocess.run(['/usr/bin/systemctl', *args], capture_output=True, text=True, timeout=timeout)


def prepare():
    need(os.geteuid() == 0, 'root_required')
    need(not any(p.exists() for p in FILES) and not LIB.exists(), 'targets_already_present_inspect')
    need(Path('/run/raspberry-task-peer-attest.lock').exists(), 'attestor_lock_missing')
    return {'state': 'prepared', 'files': {str(p): s for p, (_, s) in FILES.items()},
            'sources_ok': all(source(n, s) is not None for n, s in FILES.values())}


def apply():
    plan = prepare()
    LIB.mkdir(mode=0o755); os.chown(LIB, 0, 0); os.chmod(LIB, 0o755)
    for path, (name, expected) in FILES.items():
        write(path, source(name, expected))
    reload = systemctl('daemon-reload')
    enable = systemctl('enable', '--now', 'raspberry-task-peer-reenroll.timer')
    return dict(plan, state='applied' if reload.returncode == enable.returncode == 0 else 'uncertain',
                reload=reload.returncode, enable=enable.returncode, enable_err=enable.stderr[-400:])


def verify():
    need(os.geteuid() == 0 and LIB.exists(), 'nothing_applied')
    files = {str(p): p.exists() and sha(p.read_bytes()) == s for p, (_, s) in FILES.items()}
    timer = systemctl('is-active', 'raspberry-task-peer-reenroll.timer').stdout.strip()
    run = systemctl('start', 'raspberry-task-peer-reenroll.service', timeout=120)
    time.sleep(1)
    status = json.loads(STATUS.read_text()) if STATUS.exists() else {}
    ok = all(files.values()) and timer == 'active' and run.returncode == 0 and status.get('state') == 'current'
    return {'state': 'verified' if ok else 'not_verified', 'files': files, 'timer': timer, 'run_rc': run.returncode,
            'service_state': status.get('state'), 'reason': status.get('reason'),
            'enrolled_sha256': status.get('enrolled_sha256'), 'live_sha256': status.get('live_sha256')}


def status():
    """Read-only provenance proof: the enrolled binary equals the npm registry build."""
    need(os.geteuid() == 0 and (LIB / 'reenroll.py').exists(), 'nothing_applied')
    run = subprocess.run(['/usr/bin/systemd-run', '--wait', '--pipe', '--quiet', '--collect',
                          '--unit', 'raspberry-task-peer-reenroll-provenance',
                          '--property', 'ProtectSystem=strict', '--property', 'ProtectHome=read-only',
                          '--property', 'StateDirectory=raspberry-task-peer-reenroll',
                          '--property', 'NoNewPrivileges=yes', '--property', 'MemoryMax=96M',
                          '--property', 'Nice=15', '--property', 'IOSchedulingClass=idle',
                          '/usr/bin/python3', '-I', '-S', '-B', str(LIB / 'reenroll.py'), 'check-provenance'],
                         capture_output=True, text=True, timeout=160)
    try:
        out = json.loads(run.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        out = {'state': 'unknown', 'stdout': run.stdout[-400:]}
    return dict(out, rc=run.returncode, stderr=run.stderr[-400:])


def rollback():
    need(os.geteuid() == 0, 'root_required')
    systemctl('disable', '--now', 'raspberry-task-peer-reenroll.timer')
    for path in FILES:
        if path.exists(): path.unlink()
    if LIB.exists() and not any(LIB.iterdir()): LIB.rmdir()
    systemctl('daemon-reload')
    # The state directory (status and previous enrollments) is kept as evidence.
    return {'state': 'rolled_back', 'removed': [str(p) for p in FILES if not p.exists()]}


if __name__ == '__main__':
    verb = sys.argv[1]
    need(verb in ('prepare', 'apply', 'verify', 'status', 'rollback'), 'verb')
    print(json.dumps({'prepare': prepare, 'apply': apply, 'verify': verify, 'status': status,
                      'rollback': rollback}[verb](), sort_keys=True))
