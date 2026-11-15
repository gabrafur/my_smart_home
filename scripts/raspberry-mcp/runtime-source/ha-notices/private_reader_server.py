"""Socket-activated, unprivileged reader using the EXISTING collector UID.

No token credential, shell, free path, listening loop or write operation.
Kernel SO_PEERCRED admits only the existing operations UID and primary GID.
"""
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import resource
import socket
import struct
import sys

LIBRARY=Path('/usr/local/lib/raspberry-ha-notices')
MAX_INPUT=16384
MAX_OUTPUT=20000
# Machine-private Root composition supplies this internal binding.
OPERATIONS_UID=None


def serve(connection,handler,expected_uid,expected_gid):
    if connection.family!=socket.AF_UNIX:raise ValueError('unix_private_reader_required')
    _,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
    if(uid,gid)!=(expected_uid,expected_gid):raise ValueError('private_reader_peer_refused')
    connection.settimeout(2);raw=bytearray()
    while b'\n'not in raw:
        part=connection.recv(min(4096,MAX_INPUT+1-len(raw)))
        if not part:raise ValueError('private_request_incomplete')
        raw.extend(part)
        if len(raw)>MAX_INPUT:raise ValueError('private_request_limit')
    line,extra=bytes(raw).split(b'\n',1)
    if extra.strip():raise ValueError('one_private_request_only')
    args=json.loads(line)
    if type(args)is not dict or set(args)!={'arguments'}or type(args['arguments'])is not dict:raise ValueError('fixed_private_request')
    result=handler(args['arguments'])
    reply=json.dumps({'ok':True,'result':result},ensure_ascii=False,separators=(',',':')).encode('utf8')+b'\n'
    if len(reply)>MAX_OUTPUT:raise ValueError('private_reply_limit')
    connection.sendall(reply)


def main():
    if not(sys.flags.isolated and sys.flags.no_site and len(sys.argv)==1):raise ValueError('fixed_private_reader_invocation')
    if type(OPERATIONS_UID)is not int or OPERATIONS_UID<=0:raise ValueError('private_reader_binding_not_composed')
    observer=pwd.getpwnam('raspberry-ha-notices').pw_uid
    if os.getuid()!=observer or os.geteuid()!=observer or observer==0:raise ValueError('existing_observer_identity_required')
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(3,3))
    resource.setrlimit(resource.RLIMIT_AS,(96*1024*1024,96*1024*1024))
    resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
    # The module is Root-owned, its source and policy pins are checked again
    # before data access by evidence(). No user module path is accepted.
    path=LIBRARY/'private_content_reader.py';spec=importlib.util.spec_from_file_location('private_fixed_reader',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    with socket.socket(fileno=os.dup(0))as connection:
        serve(connection,module.evidence,OPERATIONS_UID,grp.getgrnam('raspberry-mcp').gr_gid)


if __name__=='__main__':
    try:main()
    except Exception:
        # No source body, exception, paths or credentials go to the journal.
        raise SystemExit(2)from None
