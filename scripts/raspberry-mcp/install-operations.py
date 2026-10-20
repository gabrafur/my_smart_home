#!/usr/bin/env python3
"""Upgrade the existing MCP only; no downloads, credentials, house restarts or Git writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import subprocess
import sys

SOURCE = Path('/mnt/data/docker/scripts/raspberry-mcp')
BASE = Path('/usr/local/lib/raspberry-mcp')
ROOT = Path('/var/lib/raspberry-mcp/root')
STATE = Path('/var/lib/raspberry-mcp-operations')
UNITS = Path('/etc/systemd/system')
DROPIN = UNITS / 'raspberry-mcp@.service.d/60-project-operations.conf'
PINNED = {
    'operations.py': '1dcb3764b6a862a79d490ae400d3db3991404f080661fae0d48ff5f0fc16ac17',
    'expanded-server.mjs': 'c7fa79bbb619e51617328c66e06d89f2481635c057a50c7979b039aaea956307',
    'core.mjs': 'f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2',
    'server.mjs': '1b69e9269cddc289979aabf954a2f8ad5b6b2a2419b42b844df6d72a254fb30c',
}

def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=30, **kwargs)

def hash_file(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Unexpected source or target type')
    return hashlib.sha256(path.read_bytes()).hexdigest()

def preflight():
    if not PINNED or any(hash_file(SOURCE/name) != sha for name,sha in PINNED.items()):
        raise RuntimeError('Source changed after review; nothing installed')
    for name in ('core.mjs','server.mjs'):
        if hash_file(SOURCE/name) != hash_file(ROOT/'app'/name):
            raise RuntimeError('Current isolated MCP differs from reviewed source')
    for path in (BASE, ROOT, ROOT/'app', UNITS, DROPIN.parent):
        if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
            raise RuntimeError('Unsafe installed directory')
    if any(p.exists() or p.is_symlink() for p in (STATE,DROPIN,BASE/'operations.py',BASE/'project-catalog.json',ROOT/'app/expanded-server.mjs',UNITS/'raspberry-mcp-operations.socket',UNITS/'raspberry-mcp-operations@.service')):
        raise RuntimeError('Operations already present; inspect instead of overwriting')
    operator=run('systemctl','show','raspberry-mcp-collect.service','-p','User','--value').stdout.decode().strip()
    account=pwd.getpwnam(operator)
    if account.pw_uid==0 or grp.getgrnam('docker').gr_gid not in os.getgrouplist(operator,account.pw_gid):
        raise RuntimeError('Expected existing collector identity with Docker membership')
    spec=importlib.util.spec_from_file_location('operations',SOURCE/'operations.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tracked=run('git','-C','/mnt/data/docker','ls-files','-z').stdout.decode().split('\0')
    catalog={}
    for name in tracked:
        if not module.allowed(name):
            continue
        # Only admitted committed public content, never private runtime files.
        source=Path('/mnt/data/docker')/name
        fd=module.parent_fd(Path('/mnt/data/docker'),name)
        try:
            current,info=module.read_at(fd,name.split('/')[-1])
        except (ValueError,UnicodeError,OSError):
            continue
        finally:
            os.close(fd)
        committed=run('git','-C','/mnt/data/docker','show','HEAD:'+name).stdout
        if current != committed or info.st_uid != account.pw_uid:
            continue
        key=hashlib.sha256(name.encode()).hexdigest()[:32]
        catalog[key]={'path':name,'sha256':hashlib.sha256(current).hexdigest()}
    if not catalog or len(catalog)>4096:
        raise RuntimeError('Invalid catalog size')
    return account,catalog

def unit_text(operator):
    return f'''[Unit]
Description=Fixed-target Raspberry MCP project broker
[Service]
User={operator}
Group=raspberry-mcp
ExecStart=/usr/bin/python3 -B /usr/local/lib/raspberry-mcp/operations.py
StandardInput=socket
StandardOutput=socket
StandardError=journal
LogNamespace=raspberry-mcp
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateNetwork=yes
PrivateDevices=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadOnlyPaths=/mnt/data/docker
ReadWritePaths=/var/lib/raspberry-mcp-operations /mnt/data/docker/docs /mnt/data/docker/nodered/tools/functions /mnt/data/docker/homeassistant/dashboards
InaccessiblePaths=-/mnt/data/docker/.local-secrets -/mnt/data/docker/.env -/mnt/data/docker/homeassistant/.storage -/mnt/data/docker/homeassistant/secrets.yaml -/mnt/data/docker/nodered/flows_cred.json
MemoryMax=96M
TasksMax=8
RuntimeMaxSec=55
UMask=0077
'''

SOCKET='''[Unit]
Description=Raspberry MCP fixed operations Unix socket
[Socket]
ListenStream=/run/raspberry-mcp/operations.sock
SocketMode=0600
SocketUser=raspberry-mcp
SocketGroup=raspberry-mcp
Accept=yes
MaxConnections=2
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
'''
OVERRIDE='''[Service]
ExecStart=
ExecStart=/usr/bin/node /app/expanded-server.mjs
'''

def main():
    if sys.argv[1:] not in ([],['--check']):
        raise SystemExit('Only --check is accepted')
    account,catalog=preflight()
    print('Preflight passed. Catalog files: '+str(len(catalog)))
    if sys.argv[1:]==['--check']:
        return
    if os.geteuid()!=0:
        raise SystemExit('Run with sudo in your own terminal. Never send the password.')
    created=[]
    def create(path,data):
        with path.open('xb') as stream:stream.write(data)
        path.chmod(0o644)
        created.append(path)
    was_active=run('systemctl','is-active','raspberry-mcp-tunnel.service').stdout.strip()==b'active'
    try:
        STATE.mkdir(mode=0o700)
        os.chown(STATE,account.pw_uid,grp.getgrnam('raspberry-mcp').gr_gid)
        create(BASE/'operations.py',(SOURCE/'operations.py').read_bytes())
        create(BASE/'project-catalog.json',json.dumps(catalog).encode())
        create(ROOT/'app/expanded-server.mjs',(SOURCE/'expanded-server.mjs').read_bytes())
        probe=run('chroot',f'--userspec={pwd.getpwnam("raspberry-mcp").pw_uid}:{grp.getgrnam("raspberry-mcp").gr_gid}',str(ROOT),'/usr/bin/node','/app/expanded-server.mjs',input=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')
        if len(json.loads(probe.stdout)['result']['tools'])!=11:raise RuntimeError('Isolated tool listing failed')
        create(UNITS/'raspberry-mcp-operations.socket',SOCKET.encode())
        create(UNITS/'raspberry-mcp-operations@.service',unit_text(account.pw_name).encode())
        run('systemd-analyze','verify',str(UNITS/'raspberry-mcp-operations.socket'),str(UNITS/'raspberry-mcp-operations@.service'))
        create(DROPIN,OVERRIDE.encode())
        run('systemctl','daemon-reload')
        run('systemctl','enable','--now','raspberry-mcp-operations.socket')
        # Real read-only broker probe using the sole accepted client identity.
        client = "import socket,json; s=socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect('/run/raspberry-mcp/operations.sock'); s.sendall(b'{\"name\":\"project_files\",\"arguments\":{\"host\":\"raspberry\",\"category\":\"docs\",\"offset\":0}}\\n'); r=json.loads(s.makefile().readline()); assert r['ok'] and r['result']['total']>0"
        run('runuser','-u','raspberry-mcp','--','/usr/bin/python3','-c',client)
        run('systemctl','restart','raspberry-mcp-tunnel.service')
        run('systemctl','is-active','--quiet','raspberry-mcp-tunnel.service','raspberry-mcp-operations.socket')
    except Exception:
        subprocess.run(['systemctl','stop','raspberry-mcp-tunnel.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        subprocess.run(['systemctl','disable','--now','raspberry-mcp-operations.socket'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        for path in reversed(created):path.unlink()
        if STATE.exists() and not list(STATE.iterdir()):STATE.rmdir()
        run('systemctl','daemon-reload')
        if was_active:run('systemctl','start','raspberry-mcp-tunnel.service')
        raise
    print('MCP operations installed; tunnel active. Household services were not restarted.')
    print('Refresh plugin tools, then validate project_files and the five diagnostic tools in Eva.')

if __name__=='__main__':
    try:main()
    except Exception:
        raise SystemExit('Installation failed safely. Inspect local state; credentials were not read or printed.')
