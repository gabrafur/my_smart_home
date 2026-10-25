"""Read-only scoped inventory. Never enumerate the daemon's private global history."""
import base64
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

REFERENCES = {
 '${AUTHORIZED_THREAD_ID_1}': 'principal',
 '${AUTHORIZED_THREAD_ID_2}': 'backup',
 '${AUTHORIZED_THREAD_ID_3}': 'coordenacao_meta',
}
UUID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
OP = re.compile(r'[a-f0-9]{32}')
MAX_TASKS = 128

def need(ok,why):
    if not ok: raise ValueError(why)

def valid_time(value, now):
    return type(value) in (int,float) and math.isfinite(value) and 0 <= value <= now+5

def iso(value):
    return datetime.datetime.fromtimestamp(value,datetime.timezone.utc).isoformat() if value is not None else None

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def validate(args):
    need(isinstance(args,dict) and set(args)=={'host','page_size','cursor'} and args['host']=='raspberry','invalid_list_parameters')
    need(type(args['page_size']) is int and 1<=args['page_size']<=16,'invalid_list_page_size')
    need(args['cursor'] is None or isinstance(args['cursor'],str) and 1<=len(args['cursor'])<=512,'invalid_list_cursor')

def read_database(path,tasks,queries):
    tasks.read(path,1001,0o600,1048576)
    need(not any(os.path.lexists(str(path)+suffix) for suffix in ('-wal','-journal')),
         'database_journal_requires_reconciliation')
    db=sqlite3.connect('file:'+str(path)+'?mode=ro&immutable=1',uri=True,timeout=2)
    db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        return [list(map(dict,db.execute(sql))) for sql in queries]
    finally:db.close()

def registry(tasks,now):
    rows={key:{'thread_id':key,'safe_title':title,'title_source':'fixed_reference_alias',
               'origin':'existing_reference','task_id':None,'task_key':None,
               'creation_operation_id':None,'adapter_creation_state':None,
               'created_at':None,'registry_updated_at':None,'operations':[]}
          for key,title in REFERENCES.items()}
    errors=[];truncated=False
    try:
        creations,sends=read_database(tasks.STATE/'jobs.sqlite3',tasks,[
          'SELECT id,task_key,thread,state,created,updated,reconciled FROM tasks ORDER BY created DESC,id DESC LIMIT 129',
          'SELECT id,task,state,turn,created,updated,result,reconciled FROM sends ORDER BY updated DESC,id DESC LIMIT 1025'])
        truncated=len(creations)>MAX_TASKS or len(sends)>1024
        for task in creations[:MAX_TASKS]:
            identifier=task['thread']
            if not isinstance(identifier,str) or not UUID.fullmatch(identifier):continue
            need(OP.fullmatch(task['id']) is not None,'invalid_registry_identity')
            rows[identifier]={'thread_id':identifier,'safe_title':'raspberry-task-'+task['id'],
              'title_source':'adapter_operation_alias_not_daemon_title','origin':'adapter_created',
              'task_id':task['id'],'task_key':task['task_key'],
              'creation_operation_id':task['id'],'adapter_creation_state':task['state'],
              'created_at':task['created'] if valid_time(task['created'],now) else None,
              'registry_updated_at':task['updated'] if valid_time(task['updated'],now) else None,
              'operations':[]}
        by_task={v['task_id']:v for v in rows.values() if v['task_id']}
        for send in sends[:1024]:
            if send['task'] in by_task:by_task[send['task']]['operations'].append(send)
    except (OSError,ValueError,sqlite3.Error):errors.append('adapter_registry_collection_failed')
    try:
        (legacy,)=read_database(tasks.LEGACY_DB,tasks,[
         'SELECT id,thread,state,turn,created,updated,result FROM jobs ORDER BY updated DESC,id DESC LIMIT 65'])
        truncated=truncated or len(legacy)>64
        for send in legacy[:64]:
            if send['thread'] in rows:rows[send['thread']]['operations'].append(send)
    except (OSError,ValueError,sqlite3.Error):errors.append('legacy_registry_collection_failed')
    return list(rows.values()),errors,truncated

def project(raw,observation,now):
    ops=sorted(raw['operations'],key=lambda op:(op['updated'],op['id']),reverse=True)
    executed=[op for op in ops if op['turn'] and op['state'] in ('inProgress','completed','failed','interrupted')]
    latest=ops[0] if ops else None;execution=executed[0] if executed else None
    error=observation.get('collection_error') if isinstance(observation,dict) else 'daemon_metadata_unconfirmed'
    status=observation.get('status') if isinstance(observation,dict) else 'unknown'
    if status not in ('idle','notLoaded','active','systemError'):status='unknown'
    def operation_time(op):
        try:
            result=json.loads(op['result']) if isinstance(op.get('result'),str) else op.get('result') or {}
        except (ValueError,TypeError):return None
        values=[result.get(k) for k in ('started_at','completed_at')]
        times=[x for x in values if valid_time(x,now)]
        return max(times) if times else None
    candidates=[]
    if isinstance(observation,dict) and valid_time(observation.get('updated_at'),now):candidates.append((observation['updated_at'],'daemon_metadata'))
    if valid_time(raw['created_at'],now):candidates.append((raw['created_at'],'adapter_creation_receipt'))
    candidates.extend((operation_time(op),'daemon_turn_receipt') for op in ops if operation_time(op) is not None)
    activity,activity_source=max(candidates) if candidates else (None,'unknown')
    created=raw['created_at']
    if isinstance(observation,dict) and valid_time(observation.get('created_at'),now):created=observation['created_at']
    daemon_ready=bool(isinstance(observation,dict) and not error and status=='idle' and observation.get('can_accept_direct_input') is True)
    admission=('closed' if raw['adapter_creation_state'] in ('cancelled_before_first_send','creation_lost_before_send') else
               'fresh_preflight_required' if raw['origin']=='adapter_created' else 'coordinator_observation_only' if raw['thread_id']=='${AUTHORIZED_THREAD_ID_3}' else 'legacy_fixed_intents_only')
    outcome='unknown'
    if execution:
        try:
            result=json.loads(execution['result']) if isinstance(execution.get('result'),str) else execution.get('result') or {}
            answer=result.get('answer') or {}
            if isinstance(answer,dict) and answer.get('state') in ('complete','blocked','failed','progress','checkpoint'):outcome=answer['state']
        except (ValueError,TypeError):pass
    return {k:v for k,v in raw.items() if k not in ('operations','created_at','registry_updated_at')} | {
      'created_at':iso(created),'last_activity_at':iso(activity),'activity_source':activity_source,
      'state':status,'daemon_can_accept_input':daemon_ready,
      'can_accept_input':daemon_ready and admission!='closed',
      'adapter_send_admission':admission,'fresh_scope_budget_quota_check_required':True,
      'latest_operation_id':latest['id'] if latest else None,
      'latest_operation_state':latest['state'] if latest else None,
      'last_executed_operation_id':execution['id'] if execution else None,
      'last_executed_at':iso(operation_time(execution)) if execution else None,
      'last_execution_observed_at':iso(execution['updated']) if execution and valid_time(execution['updated'],now) else None,
      'adapter_execution_proven':execution is not None,
      'last_executed_outcome':outcome,
      'collection_error':error,'open_link':None,'compatible_platforms':[],
      'link_reason':'not_provided_or_validated_by_integration',
      'notLoaded_is_terminal':False,'observed_at':iso(now)}

def page(rows,args,registry_hash,errors,truncated,now):
    validate(args)
    ordered=sorted(rows,key=lambda r:(r['last_activity_at'] or '',r['thread_id']),reverse=True)
    # Observed time changes on every read; exclude it from the stable page identity.
    order_hash=digest([{k:v for k,v in row.items() if k!='observed_at'} for row in ordered])
    offset=0
    if args['cursor'] is not None:
        try:
            encoded=args['cursor'];need(re.fullmatch('[A-Za-z0-9_-]+',encoded) is not None,'invalid_list_cursor')
            cursor=json.loads(base64.urlsafe_b64decode(encoded+'='*((-len(encoded))%4)))
            need(set(cursor)=={'v','offset','page_size','registry','order'} and type(cursor['v']) is int and cursor['v']==1 and type(cursor['offset']) is int and 0<=cursor['offset']<=130 and cursor['page_size']==args['page_size'],'invalid_list_cursor')
            if cursor['registry']!=registry_hash or cursor['order']!=order_hash:
                return {'observed_at':iso(now),'collection_error':'snapshot_changed','threads':[],
                 'next_cursor':None,'restart_pagination':True,'coverage_partial':True,
                 'ordering':'last_activity_desc_thread_id_desc'}
            offset=cursor['offset']
        except (ValueError,TypeError,KeyError,UnicodeError):raise ValueError('invalid_list_cursor') from None
    chosen=ordered[offset:offset+args['page_size']]
    end=offset+len(chosen);token=None
    if end<len(ordered):
        token=base64.urlsafe_b64encode(json.dumps({'v':1,'offset':end,'page_size':args['page_size'],
          'registry':registry_hash,'order':order_hash},sort_keys=True,separators=(',',':')).encode()).decode().rstrip('=')
    created=sorted((r for r in ordered if r['created_at']),key=lambda r:(r['created_at'],r['thread_id']),reverse=True)
    executed=sorted((r for r in ordered if r['adapter_execution_proven']),key=lambda r:(r['last_executed_at'] or r['last_execution_observed_at'] or '',r['thread_id']),reverse=True)
    summary=lambda row:{'thread_id':row['thread_id'],'creation_operation_id':row['creation_operation_id'],
        'last_executed_operation_id':row['last_executed_operation_id'],
        'last_executed_outcome':row['last_executed_outcome']} if row else None
    return {'source':'authorized_references_and_adapter_registry_plus_daemon_metadata',
      'observed_at':iso(now),'collection_error':'partial_collection_failure' if errors or any(r['collection_error'] for r in ordered) else None,
      'collection_errors':sorted(set(errors)),'coverage_partial':True,
      'coverage':['authorized_fixed_existing_references','adapter_registered_thread_identities_only',
       'no_global_native_thread_enumeration','no_prompts_raw_history_private_titles_logs_or_credentials',
       'point_in_time_metadata_not_execution_or_PC_off_proof'],
      'registry_truncated':truncated,'maximum_registered_tasks':MAX_TASKS,
      'ordering':'last_activity_desc_thread_id_desc','snapshot_hash':order_hash,
      'total_authorized_threads_observed':len(ordered),'page_size':args['page_size'],
      'next_cursor':token,'threads':chosen,'latest_created_thread':summary(created[0] if created else None),
      'latest_executed_thread':summary(executed[0] if executed else None),
      'mutation_performed':False,'assistant_dispatches':0}

def collect(args,tasks,invoke,now=None,admission_closed=False):
    validate(args);now=time.time() if now is None else now
    raw,errors,truncated=registry(tasks,now)
    registry_hash=digest(raw)
    by_id={};deadline=time.monotonic()+12
    for offset in range(0,len(raw),24):
        if time.monotonic()>=deadline:
            errors.append('daemon_metadata_collection_deadline');break
        identifiers=[r['thread_id'] for r in raw[offset:offset+24]]
        try:
            reply=invoke({'mode':'metadata_batch','thread_ids':identifiers})
            values=reply['rows'];need(isinstance(values,list) and len(values)<=24,'metadata_batch_unconfirmed')
            need(all(isinstance(r,dict) and r.get('thread_id') in identifiers for r in values) and
                 len({r['thread_id'] for r in values})==len(values),'metadata_batch_identity_unconfirmed')
            by_id.update({r['thread_id']:r for r in values})
        except (OSError,ValueError,KeyError,TypeError,TimeoutError,subprocess.SubprocessError):
            errors.append('daemon_metadata_collection_failed')
    need(type(admission_closed) is bool,'invalid_internal_admission_state')
    projected=[project(r,by_id.get(r['thread_id']),now) for r in raw]
    if admission_closed:
        for row in projected:
            row['adapter_send_admission']='closed'
            row['can_accept_input']=False
    result=page(projected,args,registry_hash,errors,truncated,now)
    result['administrative_admission_closed']=admission_closed
    return result
