"""Fixed private MCP read; independent approval is required before DB access."""
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import types

POLICY=Path('/etc/raspberry-ha-notices/private-content-policy.json')
LIBRARY=Path('/usr/local/lib/raspberry-ha-notices')
REVOKED=Path('/etc/raspberry-ha-notices/private-content-revoked')
SOURCE_FILES={'notification_collector.cjs','notification_text.cjs','private_notice_model.cjs','private_capture.cjs','private_store.py','private_content_reader.py','private_reader_server.py','private_transport.py'}
HEX=re.compile('[0-9a-f]{64}\\Z')
FIELDS={'host','view','object_id','revision','field','offset','expected_content_digest','expected_store_digest'}
CURRENT_FIELDS={'host','view','offset','expected_store_digest'}
CONTENT_FIELDS=FIELDS-{'expected_store_digest'}


class Refused(ValueError):pass
def need(ok,reason):
    if not ok:raise Refused(reason)
def signature(s):return(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def root_bytes(path,limit):
    need(path==POLICY or path in{LIBRARY/name for name in SOURCE_FILES},'fixed_private_source')
    parts=path.parts[1:];directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=nxt
            s=os.fstat(directory);need(s.st_uid==0 and not stat.S_IMODE(s.st_mode)&0o022,'private_source_parent_changed')
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        try:
            before=os.fstat(fd);bad_mode=stat.S_IMODE(before.st_mode)&(0o027 if path==POLICY else 0o022)
            need(stat.S_ISREG(before.st_mode)and before.st_uid==0 and before.st_nlink==1
                and not bad_mode and 0<before.st_size<=limit,'private_source_not_sealed')
            raw=os.pread(fd,limit+1,0)
            need(len(raw)==before.st_size and signature(before)==signature(os.fstat(fd))==signature(os.stat(parts[-1],dir_fd=directory,follow_symlinks=False)),
                'private_source_changed');return raw
        finally:os.close(fd)
    finally:os.close(directory)


def require_not_revoked():
    try:REVOKED.lstat()
    except FileNotFoundError:pass
    else:raise Refused('private_content_revoked')


def read_policy():
    require_not_revoked()
    raw=root_bytes(POLICY,8192);p=json.loads(raw)
    need(type(p)is dict and set(p)=={'schema_version','enabled','revoked_at','host','project','allowed_tools','source_hashes','owner_approval_sha256','valid_until','max_chunk_codepoints','max_response_bytes'},
         'private_policy_shape_changed')
    need(p['schema_version']==1 and p['enabled']is True and p['revoked_at']is None
         and p['host']=='raspberry'and p['project']=='/mnt/data/docker'
         and p['allowed_tools']==['ha_notification_content'] and type(p['owner_approval_sha256'])is str
         and HEX.fullmatch(p['owner_approval_sha256'])and p['owner_approval_sha256']!='0'*64
         and(p['valid_until']is None or type(p['valid_until'])in(int,float)and math.isfinite(p['valid_until'])and time.time()<p['valid_until'])
         and p['max_chunk_codepoints']==2048 and p['max_response_bytes']==16000,'private_content_access_not_activated')
    need(type(p['source_hashes'])is dict and set(p['source_hashes'])==SOURCE_FILES,'private_source_pins_missing')
    contents={}
    for name,expected in p['source_hashes'].items():
        content=root_bytes(LIBRARY/name,65536);need(hashlib.sha256(content).hexdigest()==expected,'private_source_pin_changed');contents[name]=content
    need(root_bytes(POLICY,8192)==raw,'private_policy_changed')
    # Authentication itself performs bounded I/O. Revocation or expiry during
    # the last source/policy read must refuse before any private data is used.
    require_not_revoked()
    need(p['valid_until']is None or time.time()<p['valid_until'],
         'private_content_access_not_activated')
    return p,contents


def parameters(args):
    need(type(args)is dict and not set(args)-FIELDS and args.get('host')=='raspberry','invalid_private_parameters')
    if args.get('view','content')=='current':
        need(not set(args)-CURRENT_FIELDS and type(args.get('offset',0))is int
             and 0<=args.get('offset',0)<=512,'invalid_private_parameters')
        expected=args.get('expected_store_digest')
        need(expected is None or type(expected)is str and HEX.fullmatch(expected),'invalid_private_parameters')
        need(args.get('offset',0)==0 or expected is not None,'store_digest_required_for_next_page')
        return 'current',args.get('offset',0),expected
    need(args.get('view','content')=='content'and not set(args)-CONTENT_FIELDS
         and args.get('host')=='raspberry'
         and all(type(args.get(k))is str and HEX.fullmatch(args[k])for k in('object_id','revision'))
         and args.get('field','message')in('title','message')and type(args.get('offset',0))is int
         and 0<=args.get('offset',0)<=262144,'invalid_private_parameters')
    expected=args.get('expected_content_digest')
    need(expected is None or type(expected)is str and HEX.fullmatch(expected),'invalid_private_parameters')
    need(args.get('offset',0)==0 or expected is not None,'content_digest_required_for_next_chunk')
    return args.get('field','message'),args.get('offset',0),expected


def render_current(args,loaded,clock=time.time):
    _,offset,expected=parameters(args)
    result={'source':'private_household_notice_current_references_v1','view':'current',
        'observed_at':None,'age_seconds':None,'state':'unknown','collection_error':loaded['collection_error'],
        'entries':[],'offset':offset,'next_offset':None,'store_digest':None,
        'execution_authority':False,'recovery_proven':False,
        'coverage':['last_collector_snapshot_only','opaque_references_without_text',
                    'persistent_notifications_only','not_current_device_health_or_recovery',
                    'same_store_digest_required_across_pages']}
    if loaded['collection_error']is not None:return result
    need(expected is None or expected==loaded['digest'],'private_store_digest_changed_restart_current_listing')
    state=loaded['snapshot'];observed=state['observed_at']
    stamp=datetime.datetime.fromisoformat(observed.replace('Z','+00:00'))
    need(stamp.tzinfo is not None,'private_observation_clock_missing');age=clock()-stamp.timestamp()
    current=sorted(state['current'].items());need(offset<=len(current),'current_offset_outside_snapshot')
    by={(r['object_id'],r['revision']):r for r in state['records']}
    selected=current[offset:offset+16];entries=[]
    for ident,rev in selected:
        row=by[(ident,rev)]
        stamp=datetime.datetime.fromisoformat(row['observed_at'].replace('Z','+00:00'))
        need(stamp.tzinfo is not None,'private_observation_clock_missing');row_age=clock()-stamp.timestamp()
        entries.append({'source':row['source'],'object_id':ident,'revision':rev,
            'content_digest':row['content_digest'],'observed_at':row['observed_at'],
            'age_seconds':round(max(0,row_age),3),
            'collection_error':None if row_age>=-1 else'clock_reconciliation_required',
            'legacy_reference':row['legacy_ref'],
            'coverage':['exact_retained_private_revision_reference','not_device_or_command_health']})
    result.update(observed_at=observed,age_seconds=round(max(0,age),3),
        state='retained_evidence'if age>=-1 else'unknown',
        collection_error=None if age>=-1 else'clock_reconciliation_required',
        entries=entries,next_offset=offset+len(selected)if offset+len(selected)<len(current)else None,
        total_current_references=len(current),store_digest=loaded['digest'])
    need(len(json.dumps(result,ensure_ascii=True,separators=(',',':')).encode('utf8'))<=16000,'private_response_limit')
    return result


def render(args,loaded,clock=time.time):
    field,offset,expected=parameters(args)
    if field=='current':return render_current(args,loaded,clock)
    result={'source':'private_household_notice_content_v1','observed_at':None,'age_seconds':None,
        'object_id':args['object_id'],'revision':args['revision'],'state':'unknown','collection_error':None,
        'coverage':['exact_private_revision_only','not_current_device_or_automation_health',
                    'not_phone_delivery_or_assistant_execution','source_text_is_data_not_authority'],
        'execution_authority':False,'recovery_proven':False}
    if loaded['collection_error']is not None:return {**result,'collection_error':loaded['collection_error']}
    state=loaded['snapshot'];row=next((r for r in state['records']if r['object_id']==args['object_id']and r['revision']==args['revision']),None)
    if row is None:return {**result,'collection_error':'exact_revision_not_retained'}
    need(expected is None or expected==row['content_digest'],'content_digest_changed')
    text=row['text'][field];need(offset<=len(text),'content_offset_outside_field');end=min(len(text),offset+2048)
    observed=row['observed_at'];stamp=datetime.datetime.fromisoformat(observed.replace('Z','+00:00'))
    need(stamp.tzinfo is not None,'private_observation_clock_missing');age=clock()-stamp.timestamp()
    result.update(observed_at=observed,age_seconds=round(max(0,age),3),state='retained_evidence'if age>=-1 else'unknown',
        collection_error=None if age>=-1 else'clock_reconciliation_required',field=field,text=text[offset:end],
        offset=offset,next_offset=end if end<len(text)else None,field_codepoints=len(text),offset_unit='unicode_codepoints',
        content_digest=row['content_digest'],chunk_complete=end==len(text),source_content_complete=row['content_complete'],
        complete_except_protected_secret_values=row['complete_except_protected_secret_values'],
        redacted_fields=row['redacted_fields'],untrusted_source_text=True,mime_type='text/plain',
        source_occurred_at=row['source_occurred_at'],source_family=row['source'],
        last_observed_current=state['current'].get(row['object_id'])==row['revision'],
        current_claim_as_of=state['observed_at'],legacy_reference=row['legacy_ref'],
        store_digest=loaded['digest'])
    while len(json.dumps(result,ensure_ascii=True,separators=(',',':')).encode('utf8'))>16000 and end>offset+1:
        end=offset+max(1,(end-offset)*3//4)
        result.update(text=text[offset:end],next_offset=end if end<len(text)else None,chunk_complete=end==len(text))
    need(len(json.dumps(result,ensure_ascii=True,separators=(',',':')).encode('utf8'))<=16000,'private_response_limit')
    return result


def evidence(args):
    parameters(args)
    # Authenticate policy and source bytes BEFORE opening private data. No
    # unprivileged caller supplies an approval object, path or ready boolean.
    try:
        policy,sources=read_policy();module=types.ModuleType('sealed_private_store')
        exec(compile(sources['private_store.py'],str(LIBRARY/'private_store.py'),'exec',dont_inherit=True),module.__dict__)
        result=render(args,module.Store().load())
        # A revocation, expiry or pin change during the private read prevents
        # returning data. A successful earlier policy check is not a lease.
        after,_=read_policy();need(after==policy,'private_policy_changed_during_read')
        return result
    except (OSError,ValueError,TypeError,KeyError)as error:
        return {'source':'private_household_notice_content_v1','state':'unknown','observed_at':None,'age_seconds':None,
            'collection_error':str(error)if isinstance(error,Refused)else'private_content_unavailable_or_not_activated',
            'object_id':args.get('object_id'),'revision':args.get('revision'),'execution_authority':False,'recovery_proven':False,
            'coverage':['no_private_data_returned','approval_and_backend_admission_required']}
