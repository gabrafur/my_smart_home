"""Closed transport, no routing policy, device access, network or retries.

Fixed Node-RED outbox -> installed private spool. Persistent intent precedes
output, same intent is recovered after interruption, then exact receipt is acked.
"""
import datetime, time, sys, fcntl, hashlib, json, os, pathlib, stat
ROLES = ('native_systemd_procmon','native_systemd_mcp_collection','native_systemd_external_heartbeat','native_docker_ai-bridge','observation_host_report','delivery_test')
OUTBOX = pathlib.Path('/mnt/data/docker/nodered/.eva-notice-outbox')
RECEIPTS = pathlib.Path('/mnt/data/docker/nodered/.eva-notice-receipts')
SPOOL = pathlib.Path('/var/lib/raspberry-eva-notices/spool')
STATE = pathlib.Path('/var/lib/raspberry-eva-notice-transport')

def need(ok, why):
    if not ok: raise ValueError(why)
def encoded(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
def digest(value): return hashlib.sha256(value.encode()).hexdigest() if value is not None else None

def check_dir(path, uid, gid=None):
    s=path.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and (gid is None or s.st_gid==gid) and not s.st_mode&0o022,'directory_identity')

def read(path, uid, gid=None, limit=1048576):
    try: fd=os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError: return None
    try:
        s=os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==uid and (gid is None or s.st_gid==gid) and not s.st_mode&0o027 and s.st_size<=limit,'file_identity')
        with os.fdopen(fd,'r',encoding='utf8',closefd=False) as handle: return handle.read(limit+1)
    finally: os.close(fd)

def atomic(path, value):
    temp=path.parent/('.pending-'+os.urandom(12).hex())
    try:
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
        try:
            os.fchmod(fd,0o640)
            with os.fdopen(fd,'w',encoding='utf8',closefd=False) as handle: handle.write(value); handle.flush(); os.fsync(fd)
        finally: os.close(fd)
        os.replace(temp,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        try: temp.unlink()
        except FileNotFoundError: pass

def target_for(role):
    need(role in ROLES,'fixed_role')
    return SPOOL/('eva_private_'+role.replace('-','_')+'.json')

def validate_event(role, e):
    need(type(e) is dict and set(e)=={'sequence','previous_revision','content','revision','enqueued_at'},'event_shape')
    need(type(e['sequence']) is int and 1<=e['sequence']<=9007199254740991,'sequence')
    need(e['previous_revision'] is None or type(e['previous_revision']) is str and len(e['previous_revision'])==64,'previous_revision')
    need(e['revision']==digest(encoded([role,e['sequence'],e['previous_revision'],e['content'],e['enqueued_at']])),'revision')
    need(type(e['enqueued_at']) is str and e['enqueued_at'].endswith('Z'),'enqueue_clock')
    datetime.datetime.fromisoformat(e['enqueued_at'].replace('Z','+00:00'))
    if e['content'] is not None:
        need(type(e['content']) is str and len(e['content'].encode())<=16384,'notice_size')
        n=json.loads(e['content'])
        need(set(n)=={'schema_version','notification_id','title','message','created_at'} and n['schema_version']==1,'notice_schema')
        need(n['notification_id']==target_for(role).stem,'notice_identity')
        need(type(n['title']) is str and 0<len(n['title'])<=200 and type(n['message']) is str and 0<len(n['message'])<=6000,'notice_text')
        if role=='delivery_test':need(n['title'].startswith('TESTE') and n['message'].startswith('TESTE'),'delivery_test_label')
        need(type(n['created_at']) is str and n['created_at'].endswith('Z'),'notice_time')
        datetime.datetime.fromisoformat(n['created_at'].replace('Z','+00:00'))

def effective_content(role,event):
    if event['content'] is not None:return event['content']
    if role=='delivery_test':return None
    # A durable ownership tombstone prevents old HA frames resurrecting the alias.
    return encoded({'schema_version':1,'notification_id':target_for(role).stem,'operation':'dismiss','title':'Private incident withdrawn','message':'','created_at':event['enqueued_at']})

def finish_pending(ledger):
    pending=ledger.get('pending')
    if not pending: return
    role=pending['role']; event=pending['event']; validate_event(role,event)
    target=target_for(role); current=read(target,1001,limit=16384); desired=effective_content(role,event)
    need(current in (pending['before'],desired),'output_cas')
    if current!=desired:
        if desired is None:
            target.unlink()
            fd=os.open(SPOOL,os.O_RDONLY|os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
        else: atomic(target,desired)
    need(read(target,1001,limit=16384)==desired,'output_verification')
    receipt={'schema_version':1,'role':role,'sequence':event['sequence'],'revision':event['revision'],'spool_sha256':digest(desired),'state':'spool_verified_not_assistant_acknowledged'}
    # Ledger first; ack can be recreated from the committed exact revision.
    ledger['roles'][role]=receipt
    ledger['history'].append({'role':role,'sequence':event['sequence'],'revision':event['revision'],'before_sha256':digest(pending['before']),'after_sha256':digest(desired),'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    ledger.setdefault('origin',{}).setdefault(role,pending['before'])
    ledger.setdefault('inverse',{})[role]={'revision':event['revision'],'before':pending['before'],'after':desired}
    ledger['pending']=None
    atomic(STATE/'ledger.json',encoded(ledger)+'\n')
    atomic(RECEIPTS/(role+'.json'),encoded(receipt)+'\n')

def consume():
    need(os.geteuid()==1001,'fixed_transport_uid')
    check_dir(OUTBOX,1000,1001); check_dir(RECEIPTS,1001,1000); check_dir(SPOOL,1001); check_dir(STATE,1001)
    lock=os.open(STATE/'transport.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        raw=read(STATE/'ledger.json',1001,limit=8388608)
        ledger=json.loads(raw) if raw else {'schema_version':1,'roles':{},'pending':None,'history':[]}
        need(ledger['schema_version']==1 and set(ledger['roles'])<=set(ROLES) and len(ledger['history'])<=8192,'ledger_shape')
        need(not ledger.get('revoked'),'transport_revoked')
        finish_pending(ledger)
        for role in ROLES:
            prior=ledger['roles'].get(role)
            if prior:
                need(digest(read(target_for(role),1001,limit=16384))==prior['spool_sha256'],'committed_output_changed')
                atomic(RECEIPTS/(role+'.json'),encoded(prior)+'\n')
            body=read(OUTBOX/(role+'.json'),1000,1001)
            if body is None: continue
            queue=json.loads(body)
            need(set(queue)=={'schema_version','role','events','policy','updated_at'} and queue['schema_version']==1 and queue['role']==role and type(queue['events']) is list and len(queue['events'])<=64,'queue_shape')
            cutoff=queue['policy'].get('audit_retain_after')
            parsed=datetime.datetime.fromisoformat(cutoff.replace('Z','+00:00'))
            need(parsed.tzinfo is not None and parsed.timestamp()<=time.time()-7*86400+60,'retention_cutoff')
            kept=[]; removed=[]
            for row in ledger['history']:
                (removed if datetime.datetime.fromisoformat(row['recorded_at']).timestamp()<parsed.timestamp() else kept).append(row)
            if removed:
                prior_retention=ledger.get('retention',{'removed_count':0,'digest':None})
                ledger['retention']={'removed_count':prior_retention['removed_count']+len(removed),'digest':digest(encoded([prior_retention['digest'],removed])),'cutoff':cutoff}
                ledger['history']=kept
                atomic(STATE/'ledger.json',encoded(ledger)+'\n')
            for event in queue['events']:
                validate_event(role,event)
                prior=ledger['roles'].get(role)
                if prior and event['sequence']<=prior['sequence']:
                    if event['sequence']==prior['sequence']: need(event['revision']==prior['revision'],'ack_identity')
                    continue
                need(event['sequence']==(prior['sequence'] if prior else 0)+1 and event['previous_revision']==(prior['revision'] if prior else None),'predecessor_cas')
                need(len(ledger['history'])<8192,'audit_capacity_no_silent_discard')
                before=read(target_for(role),1001,limit=16384)
                need(digest(before)==(prior['spool_sha256'] if prior else None),'installed_output_baseline')
                ledger['pending']={'role':role,'event':event,'before':before}
                atomic(STATE/'ledger.json',encoded(ledger)+'\n')
                finish_pending(ledger)
        print(encoded({'state':'observed','processed':len(ledger['history']),'automatic_retry':False}))
    finally: os.close(lock)

def rollback(role,revision,origin=False):
    need(role in ROLES and len(revision)==64,'inverse_identity')
    lock=os.open(STATE/'transport.lock',os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        ledger=json.loads(read(STATE/'ledger.json',1001,limit=8388608))
        need(ledger.get('pending') is None,'pending_must_be_recovered_first')
        inv=ledger.get('inverse',{}).get(role)
        need(inv is not None and inv['revision']==revision,'own_inverse_revision')
        if origin:
            need(role in ledger.get('origin',{}),'origin_beforeimage_required')
            inv={**inv,'before':ledger['origin'][role]}
        current=read(target_for(role),1001,limit=16384)
        recovering=ledger.get('rollback_intent')=={'role':role,'revision':revision,'origin':origin}
        need(current==inv['after'] or recovering and current==inv['before'],'own_inverse_cas')
        ledger['revoked']=True
        ledger['rollback_intent']={'role':role,'revision':revision,'origin':origin}
        atomic(STATE/'ledger.json',encoded(ledger)+'\n')
        if inv['before'] is None:
            target_for(role).unlink(missing_ok=True)
            parent=os.open(SPOOL,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(parent)
            finally:os.close(parent)
        else: atomic(target_for(role),inv['before'])
        need(read(target_for(role),1001,limit=16384)==inv['before'],'inverse_verification')
        ledger['rollback_verified']=ledger['rollback_intent']
        atomic(STATE/'ledger.json',encoded(ledger)+'\n')
    finally:os.close(lock)

if __name__=='__main__':
    try:
        if len(sys.argv)==4 and sys.argv[1] in ('rollback','rollback-origin'):rollback(sys.argv[2],sys.argv[3],origin=sys.argv[1]=='rollback-origin')
        else:
            need(len(sys.argv)==1,'closed_cli')
            consume()
        atomic(RECEIPTS/'transport-health.json',encoded({'schema_version':1,'state':'revoked' if len(sys.argv)>1 else 'observed','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n')
    except Exception:
        try:atomic(RECEIPTS/'transport-health.json',encoded({'schema_version':1,'state':'failed','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n')
        except Exception:pass
        raise

