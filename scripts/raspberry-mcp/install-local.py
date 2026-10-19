#!/usr/bin/env python3
"""Install only the approved local stdio isolation. No tunnel/key/network setup."""
import grp
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

BASE = Path('/usr/local/lib/raspberry-mcp')
ROOT = Path('/var/lib/raspberry-mcp/root')
SOURCE = Path(__file__).resolve().parent
UNIT_DIR = Path('/etc/systemd/system')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def main():
    if os.geteuid() != 0:
        sys.exit('Run this installer with sudo in your own Raspberry terminal.')
    operator = os.environ.get('SUDO_USER', '')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', operator) or operator == 'root':
        sys.exit('A non-root SUDO_USER is required for the existing collector permissions.')
    account = pwd.getpwnam(operator)
    docker_gid = grp.getgrnam('docker').gr_gid
    if docker_gid not in os.getgrouplist(operator, account.pw_gid):
        sys.exit('Collector operator must already have Docker access; no groups will be expanded.')
    names = ['raspberry-mcp.socket', 'raspberry-mcp@.service',
             'raspberry-mcp-collect.service', 'raspberry-mcp-collect.timer']
    if BASE.exists() or ROOT.parent.exists() or any((UNIT_DIR / n).exists() for n in names):
        sys.exit('Existing installation found; inspect before updating. Nothing changed.')
    for name in ['raspberry-mcp', 'raspberry-mcp-tunnel']:
        try:
            pwd.getpwnam(name)
        except KeyError:
            pass
        else:
            sys.exit('Existing service identity found; inspect before updating. Nothing changed.')
    if not Path('/usr/bin/node').is_file():
        sys.exit('System Node is required.')
    # No network downloads or package installation in this privileged installer.
    run('groupadd', '--system', 'raspberry-mcp')
    for name in ['raspberry-mcp', 'raspberry-mcp-tunnel']:
        run('useradd', '--system', '--no-create-home', '--gid', 'raspberry-mcp',
            '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name)
    BASE.mkdir(parents=True)
    for name in ['core.mjs', 'server.mjs', 'collect.mjs', 'publish.mjs', 'relay.py']:
        shutil.copyfile(SOURCE / name, BASE / name)
        (BASE / name).chmod(0o644)
    # Copy only the executable, linked libraries and Node's externalized JS builtins.
    libraries = run('ldd', '/usr/bin/node', capture_output=True).stdout
    paths = {'/usr/bin/node', *re.findall(r'(/[\w/+.\-]+)', libraries)}
    for name in sorted(paths):
        source = Path(name)
        if source.is_file():
            target = ROOT / name.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for name in ['acorn', 'acorn-walk', 'cjs-module-lexer', 'undici', 'busboy', 'streamsearch']:
        source = Path('/usr/share/nodejs') / name
        if source.is_dir():
            shutil.copytree(source, ROOT / 'usr/share/nodejs' / name, symlinks=False)
    for name in ['core.mjs', 'server.mjs']:
        target = ROOT / 'app' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(BASE / name, target)
    (ROOT / 'run/raspberry-mcp').mkdir(parents=True)
    # Safe chroot probe: ping/list only, no residential source or socket.
    probe = run('chroot', f'--userspec={pwd.getpwnam("raspberry-mcp").pw_uid}:{grp.getgrnam("raspberry-mcp").gr_gid}', str(ROOT),
                '/usr/bin/node', '/app/server.mjs', input='{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
                capture_output=True)
    import json
    if len(json.loads(probe.stdout)['result']['tools']) != 5:
        sys.exit('Isolation probe failed. No services enabled.')
    write(Path('/etc/tmpfiles.d/raspberry-mcp.conf'),
          f'd /run/raspberry-mcp 0750 {operator} raspberry-mcp -\n')
    write(UNIT_DIR / names[0], '''[Unit]
Description=Raspberry read-only MCP local Unix socket
[Socket]
ListenStream=/run/raspberry-mcp/mcp.sock
SocketMode=0660
SocketUser=raspberry-mcp-tunnel
SocketGroup=raspberry-mcp
Accept=yes
MaxConnections=4
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
''')
    write(UNIT_DIR / names[1], f'''[Unit]
Description=Isolated Raspberry read-only MCP connection
[Service]
User=raspberry-mcp
Group=raspberry-mcp
RootDirectory={ROOT}
BindReadOnlyPaths=/run/raspberry-mcp
ExecStart=/usr/bin/node /app/server.mjs
StandardInput=socket
StandardOutput=socket
StandardError=journal
LogNamespace=raspberry-mcp
PrivateNetwork=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=64M
TasksMax=32
RuntimeMaxSec=120
UMask=0077
''')
    write(UNIT_DIR / names[2], f'''[Unit]
Description=Publish bounded Raspberry diagnostic snapshot
[Service]
Type=oneshot
User={operator}
Group=raspberry-mcp
ExecStart=/usr/bin/node {BASE}/publish.mjs
TimeoutStartSec=15
Nice=15
IOSchedulingClass=idle
MemoryMax=64M
TasksMax=32
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/run/raspberry-mcp
StandardOutput=null
StandardError=journal
UMask=0027
''')
    write(UNIT_DIR / names[3], '''[Unit]
Description=Refresh Raspberry diagnostic snapshot every five minutes
[Timer]
OnBootSec=60
OnUnitActiveSec=5min
Unit=raspberry-mcp-collect.service
[Install]
WantedBy=timers.target
''')
    write(Path('/etc/systemd') / ('journald@' + 'raspberry-mcp.conf.d') / 'limits.conf', '''[Journal]
Storage=persistent
SystemMaxUse=6M
SystemMaxFileSize=2M
MaxRetentionSec=7day
''')
    run('systemd-analyze', 'verify', *(str(UNIT_DIR / n) for n in names))
    run('systemd-tmpfiles', '--create', '/etc/tmpfiles.d/raspberry-mcp.conf')
    run('systemctl', 'daemon-reload')
    try:
        run('systemctl', 'start', 'raspberry-mcp-collect.service')
        run('systemctl', 'enable', '--now', 'raspberry-mcp.socket', 'raspberry-mcp-collect.timer')
    except subprocess.CalledProcessError:
        subprocess.run(['systemctl', 'disable', '--now', 'raspberry-mcp.socket', 'raspberry-mcp-collect.timer'], check=False)
        raise
    print('Local socket and collector enabled. No tunnel, credential or ChatGPT connection created.')


if __name__ == '__main__':
    main()
