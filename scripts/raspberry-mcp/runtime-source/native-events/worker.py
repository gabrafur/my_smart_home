"""Fixed subscription service; no HA token, shell, model invocation or public listener."""
import datetime
import hashlib
import fcntl
import json
import math
import os
from pathlib import Path
import pwd
import resource
import re
import selectors
import signal
import socket
import sqlite3
import stat
import struct
import time

from registry import Registry, PROJECT, canonical
from webhook import Refused

ROOT=Path('/var/lib/raspberry-mcp-events')
SOCKET='/run/raspberry-mcp-events/events.sock'
SNAPSHOT=Path('/var/lib/raspberry-ha-notices/public/snapshot.json')
# Proposed fixed read-only bind; deployment and source publisher need separate approval.
TERMINAL_SNAPSHOT=Path('/run/raspberry-mcp-events-inputs/task-terminal-observer/snapshot.json')
PRINCIPAL='raspberry_docker_owner'
MAX_FRAME=16384


def safe_json(path, maximum, uid, mode, unique_keys=False):
    parent=os.open('/',os.O_PATH|os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:-1]:
            nxt=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            os.close(parent);parent=nxt
        fd=os.open(Path(path).name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=uid or stat.S_IMODE(before.st_mode)!=mode or before.st_nlink!=1 or before.st_size>maximum:
                raise Refused('unsafe_snapshot')
            with os.fdopen(os.dup(fd),'rb') as stream:raw=stream.read(maximum+1)
            after=os.fstat(fd)
            if len(raw)>maximum or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise Refused('snapshot_changed')
            def unique(pairs):
                value={}
                for key,item in pairs:
                    if key in value:raise Refused('duplicate_snapshot_key')
                    value[key]=item
                return value
            return json.loads(raw,object_pairs_hook=unique if unique_keys else None,
                              parse_constant=(lambda _: (_ for _ in ()).throw(Refused('nonfinite_snapshot'))) if unique_keys else None)
        finally:os.close(fd)
    finally:os.close(parent)



CLIENT_POLICY=Path('/usr/local/lib/raspberry-task-terminal-observer/client-policy.json')
CLIENT_POLICY_EXPECTED = {'schema_version': 1, 'kind': 'client_incident_and_task_continuation_v1', 'enabled': True, 'client_neutral': True, 'target': 'raspberry:/mnt/data/docker', 'allowed_tools': ['codex_task_create', 'codex_task_send', 'codex_task_status', 'codex_task_reconcile', 'codex_task_list'], 'identity_recipe': {'creation': 'ha_object_id_prefix_32', 'task_key_prefix': 'eva-admin-', 'send': 'ha_revision_suffix_32', 'terminal': 'exact_operation_id_from_registered_task_terminal_event'}, 'limits': {'maximum_sends_per_24h': 48, 'minimum_spacing_seconds': 60, 'concurrent_new_sends': 1, 'backend_limits_authoritative': True}, 'interface_confirmations_required': True, 'new_host_schedule_enabled': False, 'pending_OTP': 'stop_dependent_effects', 'uncertain_operations': 'observe_same_id_never_replay', 'workflows': ['natural_actionable_ha_notification', 'registered_task_terminal'], 'authorization_does_not_override_backend': True}

def strict_equal(actual, expected):
    if type(actual) is not type(expected): return False
    if type(expected) is dict:
        return set(actual)==set(expected) and all(strict_equal(actual[k],v) for k,v in expected.items())
    if type(expected) is list:
        return len(actual)==len(expected) and all(strict_equal(a,b) for a,b in zip(actual,expected))
    return actual==expected

def read_root_client_policy():
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in CLIENT_POLICY.parts[1:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
            info=os.fstat(fd)
            if info.st_uid!=0 or info.st_mode&0o022:raise ValueError('unsafe_policy_parent')
        file=os.open(CLIENT_POLICY.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            before=os.fstat(file)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o644 or not 0<before.st_size<=16384:raise ValueError('unsafe_policy')
            raw=os.read(file,16385);after=os.fstat(file)
            if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('policy_changed')
            return raw
        finally:os.close(file)
    finally:os.close(fd)

def read_client_policy(clock=time.time, reader=None):
    now=clock()
    result={'source':'sealed_task_terminal_client_policy','observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),
            'age_seconds':0,'state':'unknown','collection_error':'client_policy_unconfirmed','approval_active':False,
            'execution_proven':False,'coverage':['approval_not_executor_admission']}
    try:
        raw=(reader or read_root_client_policy)()
        def unique(pairs):
            out={}
            for k,v in pairs:
                if k in out:raise ValueError('duplicate')
                out[k]=v
            return out
        value=json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        if type(value) is not dict or set(value)!=set(CLIENT_POLICY_EXPECTED)|{'approval_sha256','expires_at'} or type(value['approval_sha256']) is not str or not re.fullmatch('[a-f0-9]{64}',value['approval_sha256']) or type(value.get('enabled')) is not bool or type(value.get('expires_at')) is not int or not 0 <= value['expires_at'] <= 253402300799 or not strict_equal({k:v for k,v in value.items() if k not in ('approval_sha256','expires_at')},{**CLIENT_POLICY_EXPECTED,'enabled':value['enabled']}):raise ValueError('policy_scope')
        active=value['enabled'] is True and now<value['expires_at']
        result.update(state='approved' if active else 'disabled' if not value['enabled'] else 'expired',collection_error=None,approval_active=active,
                      policy={k:v for k,v in value.items() if k!='approval_sha256'})
    except (OSError,ValueError,TypeError,KeyError,OverflowError):pass
    return result

def timestamp(value):
    if not isinstance(value,str) or len(value)>40:raise Refused('invalid_event_time')
    date=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if date.tzinfo is None:raise Refused('invalid_event_time')
    return date.timestamp()


class Engine:
    def __init__(self, registry, peer_uid, observer_uid, snapshot=SNAPSHOT, clock=time.time):
        self.registry=registry;self.peer_uid=peer_uid;self.observer_uid=observer_uid
        self.snapshot=snapshot;self.clock=clock
        prior=registry.db.execute("SELECT value FROM meta WHERE key='activation_epoch'").fetchone()
        self.activation_epoch=prior[0] if prior else clock()
        if prior is None:registry.db.execute("INSERT INTO meta VALUES('activation_epoch',?)",(self.activation_epoch,))
        self.source_health={'state':'unknown','collection_error':'not_collected'}
        self.terminal_source_health=self.terminal_health_unknown('not_collected',self.clock())
        self.last_dispatch={'state':'not_attempted','assistant_run_confirmed':False}

    def request(self, request, uid):
        if uid!=self.peer_uid:raise Refused('peer_refused')
        if not isinstance(request,dict) or set(request)!={'method','params'}:raise Refused('invalid_request')
        method=request['method'];params=request['params']
        if method=='events/subscribe':return self.registry.subscribe(params)
        if method=='events/unsubscribe':return self.registry.unsubscribe(params)
        if method=='status' and params=={}:
            status=self.registry.status();health=self.terminal_health_current();policy=read_client_policy(self.clock)
            scope=status['subscription_scope']
            policy['continuation_ready']=(scope['state']=='observed' and scope['topics']==['ha_notification','task_terminal']
                                          and health['state']=='observed' and policy['approval_active'] is True)
            policy['continuation_coverage']=['scope_and_client_policy_only_not_backend_admission','not_task_execution_or_recovery']
            return {**status,'source_health':self.source_health,'terminal_source_health':health,'client_execution_policy':policy,'last_dispatch':self.last_dispatch}
        raise Refused('method_refused')

    @staticmethod
    def terminal_health_unknown(reason, now, source_reason=None):
        return {'source':'registered_task_terminal_observer_v1','observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),
                'age_seconds':0,'state':'unknown','collection_error':reason,'source_collection_error':source_reason,
                'coverage':['collection_unknown_not_household_outage','not_delivery_or_assistant_execution']}

    def terminal_health_current(self):
        health=dict(self.terminal_source_health);now=self.clock()
        try:
            elapsed=now-timestamp(health['observed_at'])
            if not 0<=elapsed<=120:
                return self.terminal_health_unknown('terminal_snapshot_stale',now)
            health['age_seconds']=round(elapsed,3)
            return health
        except (ValueError,TypeError,KeyError,OverflowError):
            return self.terminal_health_unknown('terminal_health_time_unconfirmed',now)

    def retention_status(self, row):
        """Describe the bounded cache and current durable coverage, never delivery."""
        unknown={'state':'unknown','reason':'retention_metadata_unavailable',
                 'historical_delivery_proven':False,'historical_sequence_coverage':'unknown'}
        metadata=row.get('event_retention')
        if not isinstance(metadata,dict):return unknown
        events=row['events'];sequence=row.get('sequence');evicted=row.get('dropped')
        if (type(sequence) is not int or type(evicted) is not int or evicted<0 or
            metadata!={'schema_version':1,'kind':'rolling_source_cache','capacity':256,
                       'evicted_records':evicted,'retained_records':len(events),
                       'first_sequence':sequence-len(events)+1 if events else None,
                       'last_sequence':sequence if events else None,
                       'counter_semantics':'cache_evictions_not_confirmed_delivery_loss'} or
            sequence!=evicted+len(events) or
            any(type(e.get('sequence')) is not int or e['sequence']!=sequence-len(events)+i+1
                for i,e in enumerate(events))):
            return {**unknown,'reason':'retention_metadata_invalid'}
        durable={r[0] for r in self.registry.db.execute('SELECT id FROM events UNION SELECT id FROM event_archive')}
        missing=0
        for event in events:
            if event.get('phase') not in ('added','updated','removed') or any(
                not isinstance(event.get(k),str) or not re.fullmatch('[a-f0-9]{64}',event[k])
                for k in ('object_id','revision')):
                return {**unknown,'reason':'retention_metadata_invalid'}
            identity={'project':PROJECT,'topic':event['topic'],'source':event['source'],
                      'phase':event['phase'],'object_id':event['object_id'],'revision':event['revision']}
            missing+=hashlib.sha256(canonical(identity).encode()).hexdigest() not in durable
        return {**unknown,'state':'observed','reason':None,'kind':'rolling_source_cache',
                'capacity':256,'cache_evictions':evicted,'retained_records':len(events),
                'retained_records_persisted':len(events)-missing,'retained_records_not_persisted':missing,
                'counter_semantics':'cache_evictions_not_confirmed_delivery_loss',
                'coverage':'current_cache_only;older_records_and_webhook_receipts_require_separate_evidence'}

    def ingest(self):
        now=self.clock()
        try:
            row=safe_json(self.snapshot,524288,self.observer_uid,0o640)
            observed=timestamp(row.get('observed_at'))
            if row.get('schema_version')!=1 or not isinstance(row.get('events'),list) or len(row['events'])>256:raise Refused('invalid_snapshot')
            if not 0<=now-observed<=15:raise Refused('snapshot_stale')
            if row.get('collection_error') is not None or row.get('connection_state')!='subscribed':raise Refused('source_collection_failed')
            # Validate every envelope before enqueueing any part of the snapshot.
            events=[]
            for event in row['events']:
                if not isinstance(event,dict) or event.get('source')!='ha_persistent_notification' or event.get('topic')!='ha_notification':raise Refused('invalid_event_source')
                at=timestamp(event.get('observed_at'))
                if at<max(now-86400,self.activation_epoch):continue
                if event.get('phase') not in ('added','updated','removed') or any(not isinstance(event.get(k),str) or not re.fullmatch('[a-f0-9]{64}',event[k]) for k in ('object_id','revision')):raise Refused('invalid_event_envelope')
                events.append(((event['topic'],event['source'],event['phase'],event['object_id'],event['revision'],at),event.get('source_timing')))
            # Validate current IDs/revisions without persisting diagnostic bodies.
            self.registry.observe_current(row.get('notifications'),observed)
            timing_rows=[]
            for event,timing in events:
                result=self.registry.enqueue(*event)
                timing_rows.append((result['id'],timing,event[2],event[5],self.clock()))
            self.registry.source_timing.record_many(timing_rows)
            self.source_health={'state':'observed','observed_at':row['observed_at'],'age_seconds':round(now-observed,3),'collection_error':None,
                                'source_timing_schema_version':1 if type(row.get('source_timing_schema_version')) is int and row['source_timing_schema_version']==1 else None,
                                'source_dropped_events':row.get('dropped') if type(row.get('dropped')) is int else None,
                                'source_dropped_events_semantics':'legacy_cache_eviction_counter_not_delivery_loss',
                                'event_retention':self.retention_status(row),
                                'coverage':['sanitized_HA_notification_events','not_all_household_events','initial_snapshot_not_recovery']}
            return True
        except (OSError,ValueError,TypeError,KeyError,OverflowError) as error:
            allowed={'unsafe_snapshot','snapshot_changed','invalid_event_time','invalid_snapshot','snapshot_stale','source_collection_failed','invalid_event_source','invalid_event_envelope','unsafe_event','event_storage_full','clock_reconciliation_required','summary_current_evidence_unconfirmed','event_history_archive_full'}
            reason=str(error) if isinstance(error,Refused) and str(error) in allowed else 'snapshot_read_denied' if isinstance(error,PermissionError) else 'snapshot_missing' if isinstance(error,FileNotFoundError) else 'invalid_snapshot'
            self.source_health={'state':'unknown','observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),
                                'collection_error':reason,'coverage':['collection_failure_not_household_failure']}
            return False

    def ingest_terminal(self):
        """Fixed observer read; scope boundary is enforced by its pinned producer."""
        now = self.clock()
        try:
            row = safe_json(TERMINAL_SNAPSHOT, 65536, 1001, 0o640, True)
            safe_errors={'control_socket_changed','control_peer_changed','observer_boot_changed','legacy_policy_binding_changed','sealed_source_scope_changed','sealed_source_digest_changed','sealed_dependency_digest_changed','policy_changed_during_observation','unregistered_observation_refused','observation_deadline_exceeded','database_journal_requires_reconciliation','unsafe_registered_file','unsafe_state_directory','unsafe_lock','invalid_registered_terminal','invalid_terminal_receipt','registered_send_changed','duplicate_receipt_key','nonfinite_receipt','observation_transport_unconfirmed','observation_transport_timeout','task_coordinator_busy','observation_unconfirmed','terminal_registry_truncated'}
            if type(row) is dict and row.get('state') == 'unknown':
                reason=row.get('collection_error')
                self.terminal_source_health=self.terminal_health_unknown('terminal_source_collection_unavailable',now,reason if reason in safe_errors else 'observation_unconfirmed')
                return False
            if type(row) is dict and isinstance(row.get('observed_at'),str):
                if not 0 <= now-timestamp(row['observed_at']) <= 120:raise Refused('terminal_snapshot_stale')
            if (type(row) is not dict or set(row) != {'schema_version','source','observed_at','state','collection_error','scope_started_at','coverage','events'}
                or type(row['schema_version']) is not int or row['schema_version'] != 1
                or row['source'] != 'registered_task_terminal_observer_v1' or row['state'] != 'observed'
                or row['collection_error'] is not None or not 0 <= now-timestamp(row['observed_at']) <= 120
                or type(row['scope_started_at']) is not int or not 0 <= row['scope_started_at'] <= timestamp(row['observed_at'])
                or row['coverage'] != ['registered_sends_only','one_pending_RPC_per_sample','no_dispatch','no_task_ledger_mutation','reconciled_terminals_retained_24h_after_observer_scope_start','no_delivery_or_functional_recovery_proof']
                or type(row['events']) is not list or len(row['events']) > 64):
                raise Refused('terminal_snapshot_unconfirmed')
            events=[];seen=set()
            for item in row['events']:
                if (type(item) is not dict or set(item) not in ({'topic','source','phase','object_id','revision','observed_at','terminal_state','operation_id'}, {'topic','source','phase','object_id','revision','observed_at','terminal_state','operation_id','result_updated_at'})
                    or item['topic'] != 'task_terminal' or item['source'] != 'registered_task_status' or item['phase'] != 'terminal'
                    or any(type(item[k]) is not str or re.fullmatch('[a-f0-9]{64}',item[k]) is None for k in ('object_id','revision'))
                    or type(item['operation_id']) is not str or re.fullmatch('[a-f0-9]{32}',item['operation_id']) is None
                    or hashlib.sha256(('task-terminal-operation-v1:'+item['operation_id']).encode()).hexdigest() != item['object_id']
                    or item['terminal_state'] not in ('completed','failed','interrupted','not_dispatched')
                    or item.get('result_updated_at') is not None and (type(item['result_updated_at']) not in (int,float) or not math.isfinite(item['result_updated_at']) or not 0 <= item['result_updated_at'] <= item['observed_at']+1)
                    or type(item['observed_at']) is not int or not now-86400 <= item['observed_at'] <= now
                    or item['operation_id'] in seen):
                    raise Refused('terminal_snapshot_unconfirmed')
                seen.add(item['operation_id'])
                events.append(item)
            self.registry.db.execute('BEGIN IMMEDIATE')
            try:
                for item in events:
                    self.registry.enqueue(item['topic'],item['source'],item['phase'],item['object_id'],item['revision'],item['observed_at'],item['operation_id'],item['terminal_state'],item.get('result_updated_at'))
                self.registry.db.execute('COMMIT')
            except BaseException:
                self.registry.db.execute('ROLLBACK')
                raise
            self.terminal_source_health={'source':'registered_task_terminal_observer_v1','state':'observed','observed_at':row['observed_at'],'age_seconds':round(now-timestamp(row['observed_at']),3),'collection_error':None,'source_collection_error':None,
                'coverage':['bounded_24h_observer_not_complete_history','ingest_not_delivery_or_assistant_execution']}
            return True
        except (OSError,ValueError,TypeError,KeyError,OverflowError,sqlite3.Error) as error:
            reason='terminal_snapshot_stale' if isinstance(error,Refused) and str(error)=='terminal_snapshot_stale' else 'terminal_snapshot_unconfirmed'
            self.terminal_source_health=self.terminal_health_unknown(reason,now)
            return False

    def tick(self):
        try:
            self.registry.prune()
            ha_ready=self.ingest()
            active=self.registry.db.execute('SELECT args FROM subscriptions WHERE owner=? AND active=1 AND expires>?',(self.registry.principal,self.clock())).fetchall()
            terminal_requested=any('task_terminal' in json.loads(r['args']).get('topics',[]) for r in active)
            terminal_ready=self.ingest_terminal() if terminal_requested else False
            allowed=set()
            if ha_ready:allowed.add('ha_notification')
            if terminal_ready:allowed.add('task_terminal')
            if allowed:self.last_dispatch=self.registry.dispatch_one(allowed)
        except Exception as error:
            allowed={'event_history_archive_full','event_storage_full','clock_reconciliation_required',
                     'summary_scope_unconfirmed','summary_event_unconfirmed','summary_payload_limit'}
            reason=str(error) if isinstance(error,ValueError) and str(error) in allowed else 'event_dispatch_reconciliation_required'
            self.last_dispatch={'state':'reconciliation_required','reason':reason,
                                'assistant_run_confirmed':False,'automatic_retry':False}


def serve_connection(connection, engine):
    connection.settimeout(2)
    uid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
    try:
        if uid!=engine.peer_uid:raise Refused('peer_refused')
        data=bytearray()
        while b'\n' not in data:
            chunk=connection.recv(min(4096,MAX_FRAME+1-len(data)))
            if not chunk:raise Refused('incomplete_request')
            data.extend(chunk)
            if len(data)>MAX_FRAME:raise Refused('request_limit')
        if data.count(b'\n')!=1 or not data.endswith(b'\n'):raise Refused('request_framing')
        result=engine.request(json.loads(data),uid)
        response={'ok':True,'result':result}
    except Exception as error:
        # Neither callback URLs/signing keys nor caller-provided messages are logged.
        reason = str(error) if isinstance(error,Refused) else ''
        invalid = {'invalid_params','invalid_delivery','invalid_delivery_or_cursor','invalid_ttl','invalid_signing_key','invalid_callback'}
        category = ('invalid_params' if reason in invalid else 'forbidden' if reason in {'scope_refused','peer_refused','activation_not_approved'}
                    else 'not_found' if reason == 'event_refused' else 'challenge_failed' if reason == 'challenge_failed' else 'event_request_refused')
        response={'ok':False,'error':category,'automatic_retry':False}
    connection.sendall((json.dumps(response,separators=(',',':'))+'\n').encode())


def instance_lock(path):
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:raise Refused('unsafe_lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd);raise


def main():
    if os.geteuid()==0:raise Refused('non_root_required')
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_AS,(128*1048576,128*1048576))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
    lock=instance_lock(Path(SOCKET).parent/'worker.lock')
    peer=pwd.getpwnam('raspberry-mcp').pw_uid
    observer=pwd.getpwnam('raspberry-ha-notices').pw_uid
    # Installation/enablement is the approval gate; no client parameter can enable it.
    registry=Registry(ROOT,PRINCIPAL,approved=True)
    engine=Engine(registry,peer,observer)
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    if os.path.lexists(SOCKET):
        info=os.lstat(SOCKET)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.geteuid():raise Refused('unsafe_existing_socket')
        os.unlink(SOCKET)
    server.bind(SOCKET);os.chmod(SOCKET,0o660);server.listen(4)
    bound=os.lstat(SOCKET)
    selector=selectors.DefaultSelector();selector.register(server,selectors.EVENT_READ)
    stopped=False
    def stop(signum,frame):
        nonlocal stopped
        stopped=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    next_tick=time.monotonic()
    try:
        while not stopped:
            timeout=max(0,min(2,next_tick-time.monotonic()))
            for key,mask in selector.select(timeout):
                if stopped:break
                connection,_=server.accept()
                with connection:
                    try:serve_connection(connection,engine)
                    except OSError:pass
            if stopped:break
            if time.monotonic()>=next_tick:
                engine.tick();next_tick=time.monotonic()+2
    finally:
        selector.close();server.close();registry.db.close()
        if os.path.lexists(SOCKET):
            current=os.lstat(SOCKET)
            if (current.st_dev,current.st_ino)==(bound.st_dev,bound.st_ino):os.unlink(SOCKET)
        os.close(lock)


if __name__=='__main__':
    try:main()
    except Exception:
        print('{"events_worker":"failed","details_withheld":true}',flush=True)
        raise SystemExit(1)
