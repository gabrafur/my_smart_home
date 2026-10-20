"""Sanitized proof emitted by the actual HA process, only for a fixed nonce."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types
from .auth_gate import AuthGate, Outcome, State
from .release_identity import BUILD_REVISION

def _constant(value):
    if isinstance(value,types.CodeType):return ['code',_normalize(value)]
    if isinstance(value,bytes):return ['bytes',value.hex()]
    if isinstance(value,tuple):return ['tuple',[_constant(x) for x in value]]
    if isinstance(value,frozenset):
        return ['frozenset',sorted((_constant(x) for x in value),key=lambda x:json.dumps(x,sort_keys=True))]
    if value is Ellipsis:return ['ellipsis']
    if isinstance(value,complex):return ['complex',repr(value)]
    return [type(value).__name__,value]

def _normalize(code):
    return {'bytecode':code.co_code.hex(),'constants':[_constant(x) for x in code.co_consts],
        'names':code.co_names,'varnames':code.co_varnames,'freevars':code.co_freevars,
        'cellvars':code.co_cellvars,'args':code.co_argcount,'posonly':code.co_posonlyargcount,
        'kwonly':code.co_kwonlyargcount,'flags':code.co_flags,'exception_table':code.co_exceptiontable.hex()}

def fingerprint(functions):
    rows=[(name,hashlib.sha256(json.dumps(_normalize(fn.__code__),sort_keys=True,separators=(',',':')).encode()).hexdigest())
          for name,fn in sorted(functions.items())]
    return hashlib.sha256(json.dumps([sys.implementation.cache_tag,rows],separators=(',',':')).encode()).hexdigest()

def policy_self_test():
    writes=[];calls=[]
    gate=AuthGate(writes.append)
    gate.cached_session(lambda:Outcome.EXPIRED)
    gate.cached_session(lambda:calls.append('forbidden'))
    gate.submit('prepare_session',lambda:calls.append('forbidden'),explicit_submission=False)
    return gate.state==State.USER and not calls and writes[-1]['state']==State.USER

def read_request(config_dir):
    path=Path(config_dir)/'.mcp-icloud-activation.json'
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>1024:return None
            row=json.loads(os.read(fd,1025))
        finally:os.close(fd)
        if set(row)!={'schema_version','operation_id','release_revision'} or row['schema_version']!=1:return None
        if not re.fullmatch('[a-f0-9]{32}',row['operation_id']) or row['release_revision']!=BUILD_REVISION:return None
        return row
    except (OSError,ValueError,TypeError):return None

def publish(config_dir, functions, *, ha_running, phases, bindings_valid=True):
    request=read_request(config_dir)
    if request is None:return False
    phase_values=set(phases)
    phase=('entry_contained' if phase_values=={'entry_contained'} else
           'entry_ready' if phase_values=={'entry_ready'} else
           'entry_waiting_user' if phase_values and phase_values<={'entry_ready','entry_waiting_user'} else
           'domain_loaded')
    row={'schema_version':1,'source':'homeassistant.main_process.icloud',
         'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'operation_id':request['operation_id'],'release_revision':BUILD_REVISION,
         'loaded_code_sha256':fingerprint(functions),'pid':os.getpid(),
         'process_start_ticks':Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
         'ha_running':ha_running is True,'phase':phase,
         'manual_auth_guard_loaded':bindings_valid is True and policy_self_test(),
         'coverage':['loaded_python_code_objects','in_process_policy_self_test',
                     'no_apple_login_no_location_no_private_data','not_icloud_remote_functional_health']}
    folder=Path(config_dir);tmp=folder/('.mcp-icloud-proof.tmp.'+str(os.getpid()))
    try:
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,'wb') as out:
                out.write(json.dumps(row,separators=(',',':')).encode());out.flush();os.fsync(out.fileno())
            os.replace(tmp,folder/'.mcp-icloud-proof.json')
            dfd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(dfd)
            finally:os.close(dfd)
        finally:
            if tmp.exists():tmp.unlink()
        return True
    except OSError:return False
