"""Bounded authentication of an existing encrypted copy; never extract or execute it."""
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import sys

MAX_ENCRYPTED_BYTES=512*1024**2
MAX_PLAINTEXT_BYTES=512*1024**2
ALLOWED_OUTER=frozenset(('backup.json','homeassistant.tar.gz','homeassistant.tar','homeassistant.tgz'))

def require(value,reason):
    if not value:raise ValueError(reason)

def authenticate(backup,password):
    from securetar import SecureTarArchive,SecureTarHeader
    info=backup.lstat()
    require(backup.is_file()and not backup.is_symlink()and 0<info.st_size<=MAX_ENCRYPTED_BYTES,'encrypted_input_limit')
    seen=set();proof=None
    with SecureTarArchive(name=backup,mode='r',password=password)as outer:
        for member in outer.tar:
            name=member.name
            while name.startswith('./'):name=name[2:]
            require(name in ALLOWED_OUTER and name not in seen and len(seen)<2,'unexpected_outer_metadata')
            require(member.isfile()and 0<=member.size<=MAX_ENCRYPTED_BYTES,'outer_member_invalid')
            seen.add(name)
            if name=='backup.json':
                require(member.size<=1048576,'outer_metadata_limit');continue
            require(proof is None,'multiple_encrypted_members')
            with outer.tar.extractfile(member)as stream:
                header=SecureTarHeader.from_bytes(stream)
                require(header.version==3,'authenticated_format_required')
                require(type(header.plaintext_size)is int and 0<header.plaintext_size<=MAX_PLAINTEXT_BYTES,'plaintext_size_limit')
            digest=hashlib.sha256();total=0
            with outer.extract_tar(member)as stream:
                while chunk:=stream.read(65536):
                    total+=len(chunk);require(total<=MAX_PLAINTEXT_BYTES,'plaintext_stream_limit');digest.update(chunk)
            require(total==header.plaintext_size,'plaintext_length_unconfirmed')
            proof={'authenticated':True,'securetar_version':3,'complete_plaintext_stream_bytes':total,'plaintext_stream_sha256':digest.hexdigest(),'payloads_executed':False,'archive_extracted':False,'private_content_exported':False}
    require(proof is not None,'encrypted_member_missing')
    return proof

def main():
    require(os.geteuid()==1001 and not sys.argv[1:] and Path(__file__)==Path('/review/authenticate.py'),'fixed_unprivileged_entrypoint_required')
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(60,60))
    resource.setrlimit(resource.RLIMIT_FSIZE,(0,0));resource.setrlimit(resource.RLIMIT_NOFILE,(32,32));signal.alarm(480)
    raw=sys.stdin.buffer.readline(8193);require(0<len(raw)<=8192,'credential_input_limit')
    password=json.loads(raw).get('password');require(isinstance(password,str)and 0<len(password)<=4096,'credential_input_invalid')
    return authenticate(Path('/input/backup.tar'),password)

if __name__=='__main__':
    try:print(json.dumps(main(),sort_keys=True))
    except Exception as exc:
        reason=str(exc)if type(exc)is ValueError and str(exc)in {'encrypted_input_limit','unexpected_outer_metadata','outer_member_invalid','outer_metadata_limit','multiple_encrypted_members','authenticated_format_required','plaintext_size_limit','plaintext_stream_limit','plaintext_length_unconfirmed','encrypted_member_missing','fixed_unprivileged_entrypoint_required','credential_input_limit','credential_input_invalid'}else'authentication_incomplete'
        print(json.dumps({'authenticated':False,'error':reason,'exception_kind':type(exc).__name__,'raw_error_withheld':True,'automatic_retry':False}));raise SystemExit(1)
