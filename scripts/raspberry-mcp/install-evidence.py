#!/usr/bin/env python3
"""Upgrade read-only evidence on the existing sixteen-tool MCP; no new permissions or writes."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import subprocess
import sys

SOURCE=Path('/mnt/data/docker/scripts/raspberry-mcp')
BASE=Path('/usr/local/lib/raspberry-mcp')
APP=Path('/var/lib/raspberry-mcp/root/app')
UNITS=Path('/etc/systemd/system')
NEW_HASHES = {'maintenance_evidence.py': '6ae953c5f22f477bab0c7dd62f4b25e16db6e51b91bb90085e8c5ec3c6622e57', 'evidence-broker.py': 'f872caea49d7901ce5322421852c4d3b129714c37fe2a9b1b9532434e3b944fc', 'evidence-server.mjs': '8e1b8f728ea3748cecb1f4fed1ea67d89ae6eb6faaa146c977477a1f6ad63827'}
OLD_HASHES = {
 'operations.py':'eb12ce62774172dcfadab9da2d0e34a50f4abd5bfef14bbaf2648295d8325167',
 'expanded-server.mjs':'c7fa79bbb619e51617328c66e06d89f2481635c057a50c7979b039aaea956307',
 'maintenance_diagnostics.py':'cdaf8d6ba3d2c932dc78dacbbf52b7e5ccc9e3e004857bb5baa7a6545f2103ca',
 'diagnostics-server.mjs':'cf6d8488e636214575f0c2841f2d30d38da736d0f24bd7df454752f6e9fa96f7',
 'core.mjs':'f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2',
 'server.mjs':'1b69e9269cddc289979aabf954a2f8ad5b6b2a2419b42b844df6d72a254fb30c',
}
FRONT_DROP=UNITS/'raspberry-mcp@.service.d/90-evidence.conf'
BROKER_DROP=UNITS/'raspberry-mcp-operations@.service.d/90-evidence.conf'

def run(*args,**kwargs):
    return subprocess.run(args,check=True,capture_output=True,timeout=30,**kwargs)

def safe_directory(path):
    if path.is_symlink() or not path.is_dir() or path.stat().st_uid!=0 or path.stat().st_mode&0o022:
        raise RuntimeError('unsafe_directory')

def sha(path):
    if path.is_symlink() or not path.is_file():raise RuntimeError('unsafe_file')
    return hashlib.sha256(path.read_bytes()).hexdigest()

def preflight():
    if set(NEW_HASHES)!={'maintenance_evidence.py', 'evidence-broker.py', 'evidence-server.mjs'}:
        raise RuntimeError('release_not_pinned')
    for name,expected in NEW_HASHES.items():
        if sha(SOURCE/name)!=expected:raise RuntimeError('reviewed_source_changed')
    for name,expected in OLD_HASHES.items():
        installed=(BASE if name.endswith('.py') else APP)/name
        if sha(installed)!=expected:raise RuntimeError('installed_version_changed')
    for path in (BASE,APP,UNITS,FRONT_DROP.parent):safe_directory(path)
    if BROKER_DROP.parent.exists():safe_directory(BROKER_DROP.parent)
    targets=[BASE/'maintenance_evidence.py',BASE/'evidence-broker.py',APP/'evidence-server.mjs',FRONT_DROP,BROKER_DROP]
    if any(p.exists() or p.is_symlink() for p in targets):raise RuntimeError('already_present_inspect_before_reinstall')
    run('systemctl','is-active','--quiet','raspberry-mcp-tunnel.service','raspberry-mcp-operations.socket')
    return targets

def main():
    if sys.argv[1:] not in ([],['--check']):raise RuntimeError('invalid_arguments')
    preflight()
    if sys.argv[1:]==['--check']:
        print('Evidence preflight passed; no changes made.');return
    if os.geteuid()!=0:raise RuntimeError('sudo_required_in_local_terminal')
    created=[];created_dir=False
    def create(path,content):
        with path.open('xb') as stream:
            created.append(path);stream.write(content);stream.flush();os.fsync(stream.fileno())
        path.chmod(0o644)
    try:
        for name in NEW_HASHES:
            create((APP if name.endswith('.mjs') else BASE)/name,(SOURCE/name).read_bytes())
        client=f'{pwd.getpwnam("raspberry-mcp").pw_uid}:{grp.getgrnam("raspberry-mcp").gr_gid}'
        result=run('chroot','--userspec='+client,str(APP.parent),'/usr/bin/node','/app/evidence-server.mjs',input=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')
        if len(json.loads(result.stdout)['result']['tools'])!=16:raise RuntimeError('isolated_listing_failed')
        if not BROKER_DROP.parent.exists():BROKER_DROP.parent.mkdir(mode=0o755);created_dir=True
        create(BROKER_DROP,b'[Service]\nExecStart=\nExecStart=/usr/bin/python3 -B /usr/local/lib/raspberry-mcp/evidence-broker.py\n')
        create(FRONT_DROP,b'[Service]\nExecStart=\nExecStart=/usr/bin/node /app/evidence-server.mjs\n')
        run('systemctl','daemon-reload')
        # The socket is unchanged. New accepts use the additive broker entry point.
        probe="import socket,json; s=socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect('/run/raspberry-mcp/operations.sock'); s.sendall(b'{\"name\":\"backup_results\",\"arguments\":{\"host\":\"raspberry\"}}\\n'); r=json.loads(s.makefile().readline()); assert r['ok'] and r['result']['schema_version']=='1.1.0' and r['result']['data']['git']['evidence']['collection_error'] is None"
        run('runuser','-u','raspberry-mcp','--','/usr/bin/python3','-c',probe)
        run('systemctl','restart','raspberry-mcp-tunnel.service')
        run('systemctl','is-active','--quiet','raspberry-mcp-tunnel.service','raspberry-mcp-operations.socket')
    except Exception:
        # Old code and original drop-ins were never changed. Rollback only files
        # created by this execution; no source/catalog/proposal/household changes.
        for path in reversed(created):path.unlink()
        if created_dir:BROKER_DROP.parent.rmdir()
        run('systemctl','daemon-reload')
        run('systemctl','restart','raspberry-mcp-tunnel.service')
        raise
    print('MCP evidence installed; tunnel active; 16 tools. Household services unchanged.')

if __name__=='__main__':
    try:main()
    except Exception:
        raise SystemExit('Evidence installation stopped. No credentials printed. Inspect preflight or rollback locally.')
