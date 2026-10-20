#!/usr/bin/env python3
"""Apply this reviewed protocol/session repair only. Never reads runtime credentials."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

SOURCE = Path('/mnt/data/docker/scripts/raspberry-mcp')
BACKUP = Path('/var/backups/raspberry-mcp/protocol-session-20261019')
DROPIN = Path('/etc/systemd/system/raspberry-mcp@.service.d/50-session-lifetime.conf')
CONTENT = b'[Service]\n# Persistent stdio connection; retain memory, task, network and message limits.\nRuntimeMaxSec=infinity\n'
FILES = [
    ('core.mjs', '/usr/local/lib/raspberry-mcp/core.mjs', '317deaea155b658edbad5fd1202d245e35964b0d753cec2726bc24a056a803c6', 'f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2'),
    ('core.mjs', '/var/lib/raspberry-mcp/root/app/core.mjs', '317deaea155b658edbad5fd1202d245e35964b0d753cec2726bc24a056a803c6', 'f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2'),
    ('relay.py', '/usr/local/lib/raspberry-mcp/relay.py', '15dd075ddd019c3a01ae2b071170926fe799565ed11fb9a16f2ccae187dec3c1', '73c52432207b32501397ea60fa5f050d341ff3cddff63156dabfedd7a79e362f'),
]

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def systemctl(*args):
    result = subprocess.run(['systemctl', *args], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('systemctl failed: ' + args[0])

def main():
    if sys.argv[1:] not in [[], ['--check']]:
        raise SystemExit('Only --check is accepted.')
    for name, target, old, new in FILES:
        src, dst = SOURCE / name, Path(target)
        if src.is_symlink() or dst.is_symlink() or dst.parent.is_symlink():
            raise SystemExit('Unexpected symlink; no changes.')
        if digest(src) != new or digest(dst) != old:
            raise SystemExit('Unexpected code digest; no changes.')
        if dst.stat().st_uid != 0 or dst.stat().st_mode & 0o022:
            raise SystemExit('Unexpected installed permissions; no changes.')
    if DROPIN.exists() or DROPIN.is_symlink() or DROPIN.parent.is_symlink() or BACKUP.exists():
        raise SystemExit('Existing repair/backup; inspect instead of overwriting.')
    if sys.argv[1:] == ['--check']:
        print('Preflight passed: three fixed code files and one MCP session override only.')
        return
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo in your own terminal; never share the password.')
    BACKUP.mkdir(parents=True, mode=0o700)
    for index, (_, target, _, _) in enumerate(FILES):
        shutil.copy2(target, BACKUP / str(index))
    systemctl('stop', 'raspberry-mcp-tunnel.service')
    try:
        for name, target, _, new in FILES:
            dst = Path(target)
            temp = dst.with_name(dst.name + '.repair-new')
            with temp.open('xb') as stream:
                stream.write((SOURCE / name).read_bytes())
            temp.chmod(0o644)
            os.replace(temp, dst)
            if digest(dst) != new:
                raise RuntimeError('Installed digest mismatch.')
        DROPIN.parent.mkdir(exist_ok=True)
        with DROPIN.open('xb') as stream:
            stream.write(CONTENT)
        DROPIN.chmod(0o644)
        systemctl('daemon-reload')
        systemctl('start', 'raspberry-mcp-tunnel.service')
        systemctl('is-active', '--quiet', 'raspberry-mcp-tunnel.service')
    except Exception:
        systemctl('stop', 'raspberry-mcp-tunnel.service')
        for index, (_, target, _, _) in enumerate(FILES):
            shutil.copy2(BACKUP / str(index), target)
        if DROPIN.exists() and DROPIN.read_bytes() == CONTENT:
            DROPIN.unlink()
        systemctl('daemon-reload')
        raise
    print('MCP repair applied; tunnel active. Credentials and household services untouched.')
    print('Backups: ' + str(BACKUP))

if __name__ == '__main__':
    main()
