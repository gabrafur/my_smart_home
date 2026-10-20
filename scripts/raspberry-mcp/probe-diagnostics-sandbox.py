#!/usr/bin/env python3
"""One-shot read-only comparison of the broker task budget. No raw stderr."""
import json
import os
from pathlib import Path
import subprocess
import sys
import socket

def child():
    sys.path.insert(0,'/usr/local/lib/raspberry-mcp')
    import maintenance_diagnostics as diagnostics
    left,right=socket.socketpair()
    os.dup2(left.fileno(),0)
    reports=[]
    def record(argv):
        result=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env=diagnostics.ENV,timeout=5)
        raw=result.stderr.decode('utf8',errors='replace').lower()
        reports.append({'returncode':result.returncode,
            'thread_limit':any(x in raw for x in ('failed to create new os thread','newosproc','resource temporarily unavailable')),
            'permission_warning':'permission denied' in raw,
            'output_fields':len(result.stdout.decode('utf8',errors='replace').strip().split('|'))})
        if result.returncode:raise ValueError('collector_failed')
        return result.stdout.decode('utf8')
    try:
        row=diagnostics.service_diagnostics('homeassistant',record)
        print(json.dumps({'command':reports,'evidence':row}))
    finally:
        left.close();right.close()
    return

def old_simple_probe():
    try:
        result=subprocess.run(['/usr/bin/docker','inspect','--format','{{.State.Status}}','homeassistant'],
            stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env={'PATH':'/usr/bin:/bin','DOCKER_HOST':'unix:///var/run/docker.sock'},timeout=5)
        raw=result.stderr.decode('utf8',errors='replace').lower()
        reasons=[]
        for key,terms in {'thread_limit':['failed to create new os thread','newosproc','resource temporarily unavailable'],
             'permission_denied':['permission denied','operation not permitted'],
             'socket_unavailable':['cannot connect to the docker daemon','no such file or directory'],
             'memory_limit':['out of memory','cannot allocate memory']}.items():
            if any(term in raw for term in terms):reasons.append(key)
        output=result.stdout.decode('utf8',errors='replace').strip()
        print(json.dumps({'returncode':result.returncode,'recognized_errors':reasons,
                         'state':output if output in ('running','exited','paused','restarting','dead','created') else 'unknown'}))
    except subprocess.TimeoutExpired:print(json.dumps({'error':'timeout'}))
    except OSError:print(json.dumps({'error':'command_unavailable'}))

def main():
    if sys.argv[1:]==['--child']:child();return
    if sys.argv[1:] or os.geteuid()!=0:raise SystemExit('Run this fixed probe with sudo locally.')
    script=Path(__file__).resolve()
    for limit in (8,32):
        args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=raspberry-mcp-diagnostic-probe-'+str(limit)]
        properties=['User=gabriel','Group=raspberry-mcp','NoNewPrivileges=yes','CapabilityBoundingSet=',
          'ProtectSystem=strict','ProtectHome=yes','PrivateNetwork=yes','PrivateDevices=yes','PrivateTmp=yes',
          'RestrictAddressFamilies=AF_UNIX','RestrictSUIDSGID=yes','LockPersonality=yes',
          'ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectControlGroups=yes',
          'MemoryMax=96M','TasksMax='+str(limit),'RuntimeMaxSec=15',
          'InaccessiblePaths=-/mnt/data/docker/.local-secrets -/mnt/data/docker/.env -/mnt/data/docker/homeassistant/.storage -/mnt/data/docker/homeassistant/secrets.yaml -/mnt/data/docker/nodered/flows_cred.json']
        for value in properties:args+=['--property='+value]
        args+=['/usr/bin/python3','-B',str(script),'--child']
        result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=25)
        try:row=json.loads(result.stdout)
        except (ValueError,UnicodeError):row={'error':'probe_failed','exit_code':result.returncode}
        print(json.dumps({'tasks_max':limit,'result':row}))

if __name__=='__main__':main()
