"""Unprivileged, strictly framed client of the existing root socket."""
import json
import socket
import catalog

SOCKET = '/run/raspberry-admin-executor.sock'


def request(tool, args):
    if tool == 'storage_metadata_observe':
        if args != {'host': 'raspberry'}:
            raise ValueError('storage_scope_refused')
    else:
        catalog.validate(tool, args)
    packet = {'tool': tool, **args}
    raw = bytearray()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(20)
        s.connect(SOCKET)
        s.sendall(json.dumps(packet).encode()+b'\n')
        while b'\n' not in raw:
            part = s.recv(4096)
            if not part or len(raw)+len(part) > 32768:
                raise ValueError('storage_response_unconfirmed')
            raw.extend(part)
    line, rest = bytes(raw).split(b'\n', 1)
    if rest:
        raise ValueError('storage_response_unconfirmed')
    value = json.loads(line)
    if type(value) is not dict:
        raise ValueError('storage_response_unconfirmed')
    return value
