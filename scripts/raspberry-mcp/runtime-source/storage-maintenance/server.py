"""Root socket-activation trampoline. Existing requests retain the old executor."""
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import time

LEGACY = Path('/usr/local/lib/raspberry-admin-recovery/recovery.py')
POLICY = Path('/usr/local/lib/raspberry-mcp-storage/approval.json')


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_request_key')
        result[key] = value
    return result


def classify(raw):
    q = json.loads(raw, object_pairs_hook=unique)
    if type(q) is not dict:
        raise ValueError('storage_request_invalid')
    tool = q.get('tool')
    new = tool == 'storage_metadata_observe' or (type(q.get('action')) is str
                                                and q['action'].startswith('storage_'))
    return q, new


def legacy_identity():
    p = POLICY.lstat();s = LEGACY.lstat()
    if (p.st_uid != 0 or stat.S_IMODE(p.st_mode) != 0o644 or not stat.S_ISREG(p.st_mode)
            or p.st_nlink != 1 or p.st_size > 32768
            or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o644 or not stat.S_ISREG(s.st_mode)
            or s.st_nlink != 1 or s.st_size > 131072):
        raise ValueError('legacy_executor_identity_changed')
    policy = json.loads(POLICY.read_bytes())
    if hashlib.sha256(LEGACY.read_bytes()).hexdigest() != policy.get('legacy_executor_sha256'):
        raise ValueError('legacy_executor_identity_changed')


def main():
    if os.geteuid() != 0:
        raise ValueError('root_socket_activation_required')
    with socket.socket(fileno=0) as peer:
        peer.settimeout(5)
        _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 1001:
            raise ValueError('unexpected_peer')
        end = time.monotonic()+2
        while True:
            raw = peer.recv(4097, socket.MSG_PEEK)
            if not raw or len(raw) > 4096:
                raise ValueError('storage_request_limit')
            if b'\n' in raw:
                line, rest = raw.split(b'\n', 1)
                if rest:
                    raise ValueError('multiple_requests_refused')
                break
            if time.monotonic() > end:
                raise ValueError('incomplete_request')
            time.sleep(.01)
        q, new = classify(line)
        if not new:
            # The original socket frame is still untouched. No request value
            # controls the executor path or arguments; no existing action is reinterpreted.
            legacy_identity()
            peer.detach()
            os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', '-B', str(LEGACY)])
        consumed = peer.recv(len(raw))
        if consumed != raw:
            raise ValueError('request_frame_changed')
        import runtime
        tool = q.pop('tool', None)
        try:
            reply = runtime.dispatch(tool, q)
        except Exception as exc:
            reason = str(exc) if type(exc) is ValueError and str(exc).replace('_', '').isalnum() and len(str(exc)) < 80 else 'storage_operation_unconfirmed'
            reply = {'state': 'unavailable', 'source': 'fixed_storage_executor',
                     'observed_at': runtime.datetime.now(runtime.timezone.utc).isoformat(),
                     'age_seconds': 0, 'collection_error': reason, 'automatic_retry': False,
                     'coverage': ['no_raw_exception_paths_or_contents', 'no_replay_after_uncertain_execution']}
        encoded = (json.dumps(reply, allow_nan=False)+'\n').encode()
        if len(encoded) > 32768:
            raise ValueError('storage_response_limit')
        peer.sendall(encoded)


if __name__ == '__main__':
    # -I -S excludes project import paths; only this sealed root source directory.
    import sys
    sys.path.insert(0, '/usr/local/lib/raspberry-mcp-storage')
    try:
        main()
    except Exception:
        os.write(1, b'{"state":"unavailable","collection_error":"storage_transport_unconfirmed","automatic_retry":false}\n')
