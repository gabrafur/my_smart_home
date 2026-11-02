"""Uninstalled closed client of the existing executor socket; no new socket."""
import json
import socket
import controller

SOCKET = '/run/raspberry-admin-executor.sock'
TIMEOUT_SECONDS = 48


def request(tool, args):
    if tool in ('binding_metadata_observe', 'binding_native_preflight_observe'):
        if args != {'host': 'raspberry'}:
            raise ValueError('fixed_binding_metadata_request_required')
    else:
        controller.validate(tool, args)
    packet = (json.dumps({'tool': tool, **args}, allow_nan=False) + '\n').encode()
    if len(packet) > 4096:
        raise ValueError('binding_request_size_limit')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        # Remains below the existing frontend's 50-second broker deadline.
        peer.settimeout(TIMEOUT_SECONDS)
        peer.connect(SOCKET)
        peer.sendall(packet)
        raw = bytearray()
        while b'\n' not in raw:
            chunk = peer.recv(4096)
            if not chunk or len(raw) + len(chunk) > 32768:
                raise ValueError('binding_response_unconfirmed')
            raw.extend(chunk)
    line, rest = bytes(raw).split(b'\n', 1)
    if rest:
        raise ValueError('binding_response_unconfirmed')
    value = json.loads(line)
    if type(value) is not dict:
        raise ValueError('binding_response_unconfirmed')
    return value
