"""Reader-side verification of an approved Root binding transaction.

No Docker, service control or scheduling. A Root-owned request must refer to
the current durable consumer-ready record and the exact old/new policies.
"""
import hashlib,json,os,re,select,stat,time
from pathlib import Path
from maintenance_journal import canonical,digest,validate_snapshot,hex64,uint,closed,MaintenanceUnavailable
from worker_config import policy_document
from handoff import nonempty

class RebindUnavailable(RuntimeError):pass
def need(ok):
    if not ok:raise RebindUnavailable('source_rebind_unconfirmed')
def read_root(path,maximum):
    path=Path(path);need(path.is_absolute()and path.resolve()==path)
    parent=path.parent.lstat();need(stat.S_ISDIR(parent.st_mode)and
      (parent.st_uid,parent.st_gid,stat.S_IMODE(parent.st_mode))==(0,0,0o700))
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:fd=os.open(path.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
    finally:os.close(directory)
    try:
        a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_nlink==1
          and(a.st_uid,a.st_gid,stat.S_IMODE(a.st_mode))==(0,0,0o600)and a.st_size<=maximum)
        raw=os.read(fd,maximum+1);b=os.fstat(fd)
        need(len(raw)==a.st_size and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==
          (b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns))
        v=json.loads(raw);need(canonical(v)==raw);return v
    except(ValueError,UnicodeError):raise RebindUnavailable('source_rebind_unconfirmed')from None
    finally:os.close(fd)

def validate_request(request):
    closed(request,['schema_version','operation_id','approval_sha256','journal_head_sha256',
      'before_policy_sha256','after_policy_sha256','reader_instance_sha256','clock_domain_sha256',
      'old_source_epoch','old_source_instance_sha256','issued_at_ns','expires_at'])
    need(type(request['schema_version'])is int and request['schema_version']==1
      and type(request['operation_id'])is str and re.fullmatch('[a-f0-9]{32}',request['operation_id'])is not None)
    for k in ['approval_sha256','journal_head_sha256','before_policy_sha256','after_policy_sha256',
      'reader_instance_sha256','clock_domain_sha256','old_source_instance_sha256']:need(hex64(request[k]))
    uint(request['old_source_epoch'],128);uint(request['issued_at_ns'],64)
    expiry=request['expires_at'];need(expiry is None or type(expiry)in(int,float)and 0<expiry<2**53)
    return request

def verify(worker,new_policy,approval,request,snapshot,*,now_wall=None,now_ns=None):
    validate_request(request);expiry=request['expires_at']
    now_wall=time.time()if now_wall is None else now_wall
    now_ns=time.clock_gettime_ns(time.CLOCK_BOOTTIME)if now_ns is None else now_ns
    need(expiry is None or now_wall<expiry)
    need(request['approval_sha256']==approval==worker.approval_id
      and request['reader_instance_sha256']==worker.instance and request['clock_domain_sha256']==worker.domain
      and int(request['issued_at_ns'])<=now_ns)
    need(request['before_policy_sha256']==digest(policy_document(worker.source_verifier.policy,approval))
      and request['after_policy_sha256']==digest(policy_document(new_policy,approval)))
    body=validate_snapshot(snapshot);op=next((v for v in body['operations']if v['operation_id']==request['operation_id']),None)
    need(op is not None and op['approval_sha256']==approval)
    row=op['records'][-1];need(row['sha256']==request['journal_head_sha256']and row['body']['phase']=='consumer_ready'
      and row['body']['clock_domain_sha256']==worker.domain
      and uint(request['issued_at_ns'],64)>=uint(row['body']['at_ns'],64))
    begin=op['records'][0]['body']['facts'];ready=row['body']['facts']
    need(begin['reader_instance_sha256']==worker.instance and ready['reader_instance_sha256']==worker.instance
      and ready['source_closed']and ready['source_identity']=='verified_exited'
      and ready['old_source_epoch']==request['old_source_epoch']
      and ready['old_source_instance_sha256']==request['old_source_instance_sha256'])
    state=worker.ledger.body['state'];h=worker.ledger.body['handoff']
    need(state is not None and state.get('source_closed')is True
      and str(state['epoch'])==request['old_source_epoch']
      and hashlib.sha256(state['instance'].encode('ascii')).hexdigest()==request['old_source_instance_sha256']
      and worker.source_verifier.sender_state()=='verified_exited'
      and h['published']is None and not nonempty(h['active'])
      and h['acked_counts']['frames']==worker.ledger.body['accepted_frames']
      and str(state['unknown_epoch_tails'])==begin['unknown_epoch_tails'])
    counts=worker.ledger.report()['accounting']['handoff']['acked_counts']
    need(digest(counts)==ready['protocol_counts_sha256'])
    need(not select.select([worker.reader.sock],[],[],0)[0])
    # Preserve the exact exited sender attestation until the next live sender
    # is verified. Only the permitted policy and file-hash cache change here.
    worker.source_verifier.policy=new_policy;worker.source_verifier.cache.clear()
    return digest(request)

def apply_request(worker,new_policy,approval):
    try:
        request=read_root(worker.paths.state/'source-rebind.json',8192)
        snapshot=read_root(worker.paths.maintenance/'maintenance.json',1048576)
        return verify(worker,new_policy,approval,request,snapshot)
    except(MaintenanceUnavailable,ValueError,KeyError,TypeError,AttributeError):
        raise RebindUnavailable('source_rebind_unconfirmed')from None
