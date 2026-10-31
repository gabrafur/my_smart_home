"""Fixed subscription service; no HA token, shell, model invocation or public listener."""
import datetime
import hashlib
import fcntl
import json
import os
from pathlib import Path
import pwd
import resource
import re
import selectors
import signal
import socket
import stat
import struct
import time

from registry import Registry, PROJECT, canonical
from webhook import Refused

ROOT=Path('/var/lib/raspberry-mcp-events')
SOCKET='/run/raspberry-mcp-events/events.sock'
SNAPSHOT=Path('/var/lib/raspberry-ha-notices/public/snapshot.json')
PRINCIPAL='raspberry_docker_owner'
MAX_FRAME=16384


def safe_json(path, maximum, uid, mode):
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
            return json.loads(raw)
        finally:os.close(fd)
    finally:os.close(parent)


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
        self.last_dispatch={'state':'not_attempted','assistant_run_confirmed':False}

    def request(self, request, uid):
        if uid!=self.peer_uid:raise Refused('peer_refused')
        if not isinstance(request,dict) or set(request)!={'method','params'}:raise Refused('invalid_request')
        method=request['method'];params=request['params']
        if method=='events/subscribe':return self.registry.subscribe(params)
        if method=='events/unsubscribe':return self.registry.unsubscribe(params)
        if method=='status' and params=={}:
            return {**self.registry.status(),'source_health':self.source_health,'last_dispatch':self.last_dispatch}
        raise Refused('method_refused')

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

    def tick(self):
        try:
            self.registry.prune()
            if self.ingest():self.last_dispatch=self.registry.dispatch_one()
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
