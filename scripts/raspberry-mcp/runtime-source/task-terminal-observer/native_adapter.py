"""Fixed observe-only transport. No caller-selected paths, mode, process or identity.

Private candidate: no installed entrypoint. Imports only the already sealed
legacy/task bundles after independent root-file/digest verification.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
import types

LIB=Path('/usr/local/lib/raspberry-task-control')
OLD=Path('/usr/local/lib/raspberry-mcp')
POLICY=LIB/'policy.json'
LEGACY=OLD/'codex-control-approval.json'
SOCKET='/run/raspberry-mcp/codex-control.sock'
EXPECTED={'task_control.py','task_store.py','task_rpc.cjs','task-broker.py','task_list.py'}

def need(ok,reason):
    if not ok:raise ValueError(reason)
def decode(raw):
    def unique(rows):
        d={}
        for k,v in rows:need(k not in d,'duplicate_policy_key');d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite_json')))
def root_read(path):
    path=Path(path);need(path.is_absolute() and '..' not in path.parts,'fixed_root_path')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
            s=os.fstat(fd);need(s.st_uid==s.st_gid==0 and not s.st_mode&0o022,'root_ancestor_changed')
        leaf=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    finally:os.close(fd)
    try:
        s=os.fstat(leaf);need(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o644 and 0<s.st_size<=1048576,'sealed_file_changed')
        raw=bytearray()
        while len(raw)<=1048576:
            chunk=os.read(leaf,min(65536,1048577-len(raw)))
            if not chunk:break
            raw.extend(chunk)
        t=os.fstat(leaf);key=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
        need(key(s)==key(t) and len(raw)==s.st_size,'sealed_file_changed_during_read')
        return bytes(raw)
    finally:os.close(leaf)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def checked_bundle():
    old_raw=root_read(LEGACY);new_raw=root_read(POLICY)
    old,new=decode(old_raw),decode(new_raw)
    need(type(old) is dict and type(new) is dict and new.get('legacy_policy_sha256')==sha(old_raw),'legacy_policy_binding_changed')
    need(set(old.get('source_hashes',{}))=={'codex_control.py','codex_control_rpc.cjs'} and set(new.get('source_hashes',{}))==EXPECTED,'sealed_source_scope_changed')
    need(len(new.get('dependencies',{}))<=64,'dependency_scope_too_large')
    sources={}
    for directory,policy in ((OLD,old),(LIB,new)):
        for name,digest in policy['source_hashes'].items():
            raw=root_read(directory/name);need(sha(raw)==digest,'sealed_source_digest_changed');sources[str(directory/name)]=raw
    for path,digest in new['dependencies'].items():need(sha(root_read(path))==digest,'sealed_dependency_digest_changed')
    return old_raw,new_raw,sources

def module(name,raw,path):
    value=types.ModuleType(name);value.__file__=str(path);sys.modules[name]=value
    exec(compile(raw,str(path),'exec'),value.__dict__);return value

class Adapter:
    enforced_timeout_seconds=1.2
    def __init__(self,registered_rows,*,monotonic=time.monotonic,run=subprocess.run):
        self.rows=registered_rows;self.clock=monotonic;self.run=run;self.saved=None
    def policy_check(self):
        need(os.geteuid()==1001,'observer_uid_refused')
        old_raw,new_raw,sources=checked_bundle()
        # Populate only verified modules. No Store instance or DDL is executed.
        previous=module('codex_control_observer_verified',sources[str(OLD/'codex_control.py')],OLD/'codex_control.py')
        store=module('task_store',sources[str(LIB/'task_store.py')],LIB/'task_store.py')
        current=module('task_control_observer_verified',sources[str(LIB/'task_control.py')],LIB/'task_control.py')
        p,legacy=current.policy(previous,observation=True)
        # The same sealed boot/inode/PID/UID remains mandatory after expiry.
        need(legacy['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'observer_boot_changed')
        self.saved=(sha(old_raw),sha(new_raw),legacy)
        self.check_peer(legacy)
        return True
    def check_peer(self,policy):
        before=os.stat(SOCKET,follow_symlinks=False)
        need(stat.S_ISSOCK(before.st_mode) and before.st_uid==1001 and stat.S_IMODE(before.st_mode)==0o600 and [before.st_dev,before.st_ino]==policy['socket_identity'],'control_socket_changed')
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
            peer.settimeout(.15);peer.connect(SOCKET)
            pid,uid,gid=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            need(pid==policy['peer_pid'] and uid==gid==1001,'control_peer_changed')
        after=os.stat(SOCKET,follow_symlinks=False)
        need((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino),'control_socket_changed')
    def __call__(self,q):
        need(self.saved is not None and type(q) is dict and set(q)=={'mode','thread_id','turn_id','operation_id'} and q['mode']=='observe','observe_only_scope_refused')
        rows,_=self.rows()
        need(len(rows)==1 and q=={'mode':'observe','thread_id':rows[0]['thread'],'turn_id':rows[0]['turn'],'operation_id':rows[0]['id']},'unregistered_observation_refused')
        request=q
        task=rows[0].get('task')
        if isinstance(task,str) and task.startswith('workspace:'):
            need(task[len('workspace:'):]==q['thread_id'],'workspace_observation_identity_changed')
            context=decode(rows[0]['result']) if isinstance(rows[0].get('result'),str) else None
            need(isinstance(context,dict) and context.get('route')=='workspace_thread_communication'
                 and context.get('target_thread_id')==q['thread_id']
                 and context.get('profile_preserved') is True
                 and context.get('authority_changed') is False
                 and (context.get('assistant_acknowledged') is None or type(context.get('assistant_acknowledged')) is bool),
                 'workspace_observation_context_unconfirmed')
            request={**q,'mode':'workspace_message_observe','delivery_mode':context.get('delivery_mode'),
                     'expected_turn_id':context.get('expected_turn_id'),
                     'reply_boundary':context.get('reply_boundary',{'state':'unknown','item_id':None}),
                     'known_ack':context.get('acknowledgement_evidence')}
        old_raw,new_raw,_=checked_bundle()
        need((sha(old_raw),sha(new_raw))==self.saved[:2],'policy_changed_during_observation')
        self.check_peer(self.saved[2])
        try:
            result=self.run(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=16',str(LIB/'task_rpc.cjs')],input=json.dumps(request).encode(),capture_output=True,timeout=self.enforced_timeout_seconds,env={'PATH':'/usr/bin:/bin','WS_NO_BUFFER_UTIL':'1','WS_NO_UTF_8_VALIDATE':'1'})
        except subprocess.TimeoutExpired:
            raise TimeoutError('observation_transport_timeout') from None
        need(result.returncode==0 and len(result.stdout)<=16384,'observation_transport_unconfirmed')
        answer=decode(result.stdout)
        need(type(answer) is dict and set(answer)=={'ok','result'} and answer['ok'] is True and type(answer['result']) is dict,'observation_transport_unconfirmed')
        self.check_peer(self.saved[2])
        return answer['result']
