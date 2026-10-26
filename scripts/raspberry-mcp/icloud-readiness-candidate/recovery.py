"""Fixed recovery for a confirmed pre-write failure; original receipt is immutable."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import struct

ORIGINAL = Path('/var/lib/raspberry-admin-executor')
STATE = ORIGINAL / '__OPERATOR_LEGACY_RECOVERY_STATE__'
EXECUTOR = Path('/usr/local/lib/raspberry-admin-executor/executor.py')
EXPECTED = '2f1d95bec4488c3a62f17027c01e5983866d534c6d2b049dad1093d7f72e1628'
ORIGINAL_ROW = {'__OPERATOR_BOUND_HISTORICAL_RECEIPT__': True}


def trusted(path, expected=None):
    for parent in reversed(path.parents):
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('unsafe_root_parent')
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or s.st_nlink != 1 or s.st_size > 65536:
            raise ValueError('unsafe_root_file')
        raw = os.read(fd,65537)
        if expected and hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('sealed_source_changed')
        return raw
    finally:
        os.close(fd)


def load_executor():
    trusted(EXECUTOR,EXPECTED)
    spec = importlib.util.spec_from_file_location('sealed_original_executor',EXECUTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # All recovery backups, receipts and audit entries have a separate root directory.
    mod.STATE = STATE
    return mod


def dispatch(q, mod, backend, original):
    if q == mod.READINESS_REQUEST:
        return mod.readiness(q, backend)
    mod.validate(q)
    if q['tool'] in ('admin_action_status','admin_action_reconcile'):
        return {'receipt':original,'recovery_receipt':backend.load(),
                'observation':backend.observation(),'automatic_retry':False,
                'replay_performed':False,'original_receipt_preserved':True}
    if q['tool'] == 'admin_action_revoke':
        mod.atomic(ORIGINAL/'revoked',b'revoked\n')
        return {'revoked':True,'receipts_preserved':True}
    # Only this exact confirmed, terminal, pre-write failure admits a recovery.
    mod.need(original == ORIGINAL_ROW,'original_failure_not_eligible')
    mod.need(not (ORIGINAL/'revoked').exists(),'revoked')
    result = mod.handle(q,backend)
    return {'receipt':original,'recovery_receipt':result,
            'original_receipt_preserved':True,'automatic_retry':False}


def serve():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    os.umask(0o077)
    mod = load_executor()
    sock = socket.fromfd(0,socket.AF_UNIX,socket.SOCK_STREAM)
    _,uid,_ = struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
    mod.need(uid == pwd.getpwnam('__OPERATOR_BROKER_ACCOUNT__').pw_uid,'broker_identity_refused')
    sock.settimeout(3)
    raw = bytearray()
    while b'\n' not in raw:
        chunk = sock.recv(1024)
        mod.need(chunk and len(raw)+len(chunk)<=2048,'request_limit')
        raw.extend(chunk)
    mod.need(raw.count(b'\n')==1 and raw.endswith(b'\n'),'one_request_only')
    q = json.loads(raw, object_pairs_hook=mod.unique_request)
    if q != mod.READINESS_REQUEST:
        mod.validate(q)
    # Share the original lock, including with any pre-existing executor instance.
    fd = os.open(ORIGINAL/'executor.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        s = os.fstat(fd)
        mod.need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1
                 and stat.S_IMODE(s.st_mode)==0o600,'unsafe_lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        original = None if q == mod.READINESS_REQUEST else json.loads(trusted(ORIGINAL/'receipt.json'))
        backend = mod.Backend()
        reply = dispatch(q,mod,backend,original)
    finally:
        os.close(fd)
    os.write(2,json.dumps({'event':'fixed_setuid_recovery_request_handled',
                          'tool':q['tool'],'automatic_retry':False}).encode()+b'\n')
    sock.sendall(json.dumps(reply).encode()+b'\n')


if __name__ == '__main__':
    try:
        serve()
    except Exception:
        os.write(2,b'{"event":"fixed_setuid_recovery_refused_or_unconfirmed","automatic_retry":false}\n')
        os.write(1,b'{"error":"refused_or_reconciliation_required","automatic_retry":false}\n')
        raise SystemExit(1)
