#!/usr/bin/env python3
"""Adjust only the MCP broker task budget, with three real read-only probes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

BASE=Path('/etc/systemd/system/raspberry-mcp-operations@.service.d')
TARGET=BASE/'80-diagnostics-task-budget.conf'
CONTENT=b'[Service]\nTasksMax=32\n'

def run(*args,**kwargs):
    return subprocess.run(args,check=True,capture_output=True,timeout=30,**kwargs)

def main():
    if os.geteuid()!=0:raise RuntimeError('sudo_required')
    if BASE.is_symlink() or BASE.stat().st_uid!=0 or BASE.stat().st_mode&0o022:raise RuntimeError('unsafe_directory')
    if TARGET.exists() or TARGET.is_symlink():raise RuntimeError('already_present_inspect')
    source=Path('/usr/local/lib/raspberry-mcp/maintenance_diagnostics.py')
    if source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest()!='cdaf8d6ba3d2c932dc78dacbbf52b7e5ccc9e3e004857bb5baa7a6545f2103ca':raise RuntimeError('version_changed')
    override=BASE/'70-diagnostics.conf'
    if override.is_symlink() or override.read_bytes()!=b'[Service]\nExecStart=\nExecStart=/usr/bin/python3 -B /usr/local/lib/raspberry-mcp/diagnostics-broker.py\n':raise RuntimeError('entry_point_changed')
    with TARGET.open('xb') as stream:stream.write(CONTENT);stream.flush();os.fsync(stream.fileno())
    TARGET.chmod(0o644)
    try:
        run('systemctl','daemon-reload')
        client='''import socket,json
for service in ('homeassistant','nodered','mosquitto'):
 s=socket.socket(socket.AF_UNIX);s.settimeout(12);s.connect('/run/raspberry-mcp/operations.sock')
 s.sendall((json.dumps({'name':'service_diagnostics','arguments':{'host':'raspberry','service':service}})+'\\n').encode())
 r=json.loads(s.makefile().readline());s.close()
 assert r['ok'], 'broker_failed'
 evidence=r['result']['evidence']['container']
 assert evidence['collection_error'] is None and evidence['data']['service']==service, 'collection_failed'
 print(json.dumps({'service':service,'observed_at':evidence['observed_at'],'state':evidence['state'],'collection_error':None}))
'''
        result=run('runuser','-u','raspberry-mcp','--','/usr/bin/python3','-c',client)
        # Output is a fixed projection from the probe, never Docker stderr/logs.
        for line in result.stdout.decode().splitlines():print(json.dumps(json.loads(line)))
    except Exception:
        TARGET.unlink();run('systemctl','daemon-reload');raise
    print('MCP broker task budget fixed; three service collections passed. No service restarted.')

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Task budget fix stopped or rolled back. No raw logs or credentials printed.')
