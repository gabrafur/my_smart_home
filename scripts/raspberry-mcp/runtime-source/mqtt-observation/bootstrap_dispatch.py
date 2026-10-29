"""Root admission fence for one reviewed first-metadata remote request.

No launcher, network, service command, policy promotion or authorization refresh.
The eventual fixed executor must use the newly recorded transition once; a
JSON receipt is data, never a transferable permission to repeat dispatch.
"""
from dataclasses import dataclass
from pathlib import Path
import hashlib,math,os,re,stat,time
from maintenance_journal import canonical,closed,digest,hex64,uint,MaintenanceUnavailable
from maintenance_backend import decode

SCOPE='mqtt_metadata_first_backup_dispatch_v1'
DAY_NS=86400*10**9

def need(ok,reason='bootstrap_dispatch_unconfirmed'):
    if not ok:raise MaintenanceUnavailable(reason)

@dataclass(frozen=True)
class Paths:
    worker:Path=Path('/opt/raspberry-offsite-bootstrap')
    interpreter:Path=Path('/usr/bin/node')
    policy:Path=Path('/mnt/data/docker/.local-secrets/offsite-backup-policy.json')
    manifest:Path=Path('/mnt/data/docker/restore/private-state-manifest.yaml')
    worker_uid:int=1000
    worker_gid:int=1000

def file_digest(path,*,uid,gid,modes,limit):
    """Pin a regular, unaliased file and its named identity around streaming."""
    need(path.is_absolute()and path.resolve()==path,'bootstrap_path_unconfirmed')
    fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        a=os.fstat(fd)
        need(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and(a.st_uid,a.st_gid)==(uid,gid)
          and stat.S_IMODE(a.st_mode)in modes and 0<a.st_size<=limit,'bootstrap_file_unsafe')
        value=hashlib.sha256();size=0
        while True:
            raw=os.read(fd,65536)
            if not raw:break
            size+=len(raw);need(size<=limit,'bootstrap_file_unsafe');value.update(raw)
        b=os.fstat(fd);named=path.lstat()
        signature=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_uid,s.st_gid,s.st_mode,s.st_nlink)
        need(size==a.st_size and signature(a)==signature(b)==signature(named),'bootstrap_file_changed')
        return value.hexdigest()
    finally:os.close(fd)

def worker_manifest(paths,files):
    need(type(files)is dict and 1<=len(files)<=512 and 'worker.mjs'in files,'bootstrap_worker_manifest_invalid')
    root=paths.worker
    need(root.is_absolute()and root.resolve()==root,'bootstrap_worker_path_invalid')
    anchors={}
    def anchor(directory):
        s=directory.lstat();need(stat.S_ISDIR(s.st_mode)and(s.st_uid,s.st_gid)==(0,0)
          and not stat.S_IMODE(s.st_mode)&0o022,'bootstrap_worker_directory_unsafe')
        identity=(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_mtime_ns,s.st_ctime_ns)
        need(directory not in anchors or anchors[directory]==identity,'bootstrap_worker_directory_changed')
        anchors[directory]=identity
    anchor(root)
    pending=[root];inventory=set();directories=0
    while pending:
        current=pending.pop();anchor(current);directories+=1
        need(directories<=512,'bootstrap_worker_manifest_invalid')
        with os.scandir(current)as entries:
            for entry in entries:
                info=entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):pending.append(Path(entry.path))
                else:
                    need(stat.S_ISREG(info.st_mode),'bootstrap_worker_file_unsafe')
                    inventory.add(str(Path(entry.path).relative_to(root)))
                    need(len(inventory)<=512,'bootstrap_worker_manifest_invalid')
    need(inventory==set(files),'bootstrap_worker_inventory_changed')
    for name,sha in sorted(files.items()):
        need(type(name)is str and len(name)<=240 and hex64(sha),'bootstrap_worker_manifest_invalid')
        parts=name.split('/')
        need(all(part not in('','..','.')and re.fullmatch('[A-Za-z0-9_.-]+',part)for part in parts),'bootstrap_worker_manifest_invalid')
        current=root
        for part in parts[:-1]:current=current/part;anchor(current)
        need(file_digest(current/parts[-1],uid=0,gid=0,modes=(0o444,0o644),limit=1048576)==sha,'bootstrap_worker_changed')
    for directory in list(anchors):anchor(directory)
    return digest(files)

class BootstrapDispatch:
    def __init__(self,journal,backend,paths=Paths(),*,wall=time.time):
        need(os.geteuid()==0 and os.getegid()==0,'bootstrap_dispatch_role_invalid')
        self.j=journal;self.b=backend;self.paths=paths;self.wall=wall
    def profile(self):
        self.b.verify_installed_code();self.j.tx._anchors()
        p=decode(self.j.tx._read(self.j.tx.state_fd,'first-backup-policy.json',0o600))
        closed(p,['schema_version','scope','enabled','issued_at','expires_at','approval_sha256',
          'code_manifest_sha256','operation_id','snapshot_operation_id','maximum_duration_ns',
          'baseline_policy_sha256','baseline_manifest_sha256','worker_files','interpreter_sha256'])
        need(type(p['schema_version'])is int and p['schema_version']==1 and p['scope']==SCOPE and p['enabled']is True,
          'bootstrap_profile_closed')
        need(all(hex64(p[k])for k in('approval_sha256','code_manifest_sha256','baseline_policy_sha256',
          'baseline_manifest_sha256','interpreter_sha256'))and p['code_manifest_sha256']==self.b.policy['code_manifest_sha256'])
        need(all(type(p[k])is str and re.fullmatch('[a-f0-9]{32}',p[k])for k in('operation_id','snapshot_operation_id'))
          and p['operation_id']!=p['snapshot_operation_id'])
        issued,expiry,now=p['issued_at'],p['expires_at'],self.wall()
        need(all(type(v)in(int,float)and math.isfinite(v)for v in(issued,expiry,now))
          and 0<issued<=now<expiry<=issued+86400,'bootstrap_profile_expired')
        need(0<uint(p['maximum_duration_ns'],64)<=DAY_NS,'bootstrap_profile_bounds')
        worker_manifest(self.paths,p['worker_files'])
        need(file_digest(self.paths.interpreter,uid=0,gid=0,modes=(0o555,0o755),limit=128*1048576)==p['interpreter_sha256'],
          'bootstrap_interpreter_changed')
        need(file_digest(self.paths.policy,uid=self.paths.worker_uid,gid=self.paths.worker_gid,modes=(0o600,),limit=1048576)
          ==p['baseline_policy_sha256'],'bootstrap_baseline_changed')
        need(file_digest(self.paths.manifest,uid=self.paths.worker_uid,gid=self.paths.worker_gid,modes=(0o444,0o644),limit=1048576)
          ==p['baseline_manifest_sha256'],'bootstrap_baseline_changed')
        self.j.tx._anchors();return p
    def _clock(self,op=None):
        now,domain=self.b.clock();uint(now,64);need(hex64(domain))
        if op:
            first,last=op['records'][0]['body'],op['records'][-1]['body']
            need(domain==first['clock_domain_sha256']and uint(now,64)>=uint(last['at_ns'],64),'bootstrap_clock_changed')
        return now,domain
    def _existing(self,identity):
        op=self.j.find(identity)
        need(op is not None and op['approval_sha256']==self.b.policy['approval_sha256']
          and op['records'][0]['body']['phase']=='bootstrap_begin','bootstrap_operation_unconfirmed')
        return op
    def _live(self,identity):
        p=self.profile();need(identity==p['operation_id'],'bootstrap_operation_unconfirmed')
        op=self._existing(identity);now,_=self._clock(op);facts=op['records'][0]['body']['facts']
        need(facts['profile_sha256']==digest(p),'bootstrap_profile_changed')
        need(uint(now,64)<uint(facts['deadline_ns'],64),'bootstrap_deadline')
        return op
    def begin(self):
        p=self.profile();identity=p['operation_id']
        if self.j.find(identity)is not None:return {**self.status(identity),'newly_recorded':False}
        state=self.j.status()
        from maintenance_archive import TERMINAL
        need(not state or all(o['records'][-1]['body']['phase']in TERMINAL for o in state['body']['operations']),
          'bootstrap_prior_operation_unresolved')
        now,domain=self._clock();duration=min(uint(p['maximum_duration_ns'],64),int((p['expires_at']-self.wall())*10**9))
        need(duration>0 and uint(now,64)+duration<2**64,'bootstrap_deadline')
        facts={'profile_sha256':digest(p),'worker_manifest_sha256':digest(p['worker_files']),
          'bootstrap_approval_sha256':p['approval_sha256'],'baseline_policy_sha256':p['baseline_policy_sha256'],
          'baseline_manifest_sha256':p['baseline_manifest_sha256'],'snapshot_operation_sha256':digest(p['snapshot_operation_id']),
          'deadline_ns':str(uint(now,64)+duration)}
        self.j.append(identity,'bootstrap_begin',facts,at_ns=now,clock_domain_sha256=domain,expected_previous_sha256=None)
        self._live(identity)
        return {**self.status(identity),'newly_recorded':True}
    def bind_worker(self,identity,witness):
        """Record a witness collected by the fixed launcher's own live handle."""
        from maintenance_journal import validate_facts
        validate_facts('bootstrap_worker_bound',witness);op=self._live(identity)
        need(op['records'][-1]['body']['phase']=='bootstrap_begin','bootstrap_worker_binding_consumed')
        p=self.profile()
        need(uint(witness['pid'],64)>0 and uint(witness['start_ticks'],64)>0
          and witness['worker_manifest_sha256']==digest(p['worker_files'])
          and witness['interpreter_sha256']==p['interpreter_sha256'],'bootstrap_worker_binding_invalid')
        now,domain=self._clock(op)
        self.j.append(identity,'bootstrap_worker_bound',witness,at_ns=now,clock_domain_sha256=domain,
          expected_previous_sha256=op['records'][-1]['sha256'])
        self._live(identity);return self.status(identity)
    def admit_remote(self,identity,*,bundle_sha256,request_sha256):
        need(hex64(bundle_sha256)and hex64(request_sha256))
        op=self._live(identity)
        need(op['records'][-1]['body']['phase']!='bootstrap_begin','bootstrap_worker_unbound')
        need(op['records'][-1]['body']['phase']=='bootstrap_worker_bound','bootstrap_remote_intent_consumed')
        now,domain=self._clock(op)
        self.j.append(identity,'bootstrap_remote_intent',{'bundle_sha256':bundle_sha256,'request_sha256':request_sha256,
          'dispatch_completed':False},at_ns=now,clock_domain_sha256=domain,expected_previous_sha256=op['records'][-1]['sha256'])
        # Revocation/change after the durable intent leaves it consumed, never retryable.
        self._live(identity)
        return {**self.status(identity),'newly_recorded':True,'dispatch_executed':False}
    def record_report(self,identity,report_sha256):
        """Data may outlive expiry; a report does not close the effect lifecycle."""
        need(hex64(report_sha256));self.b.verify_installed_code();op=self._existing(identity)
        last=op['records'][-1]['body']
        if last['phase']=='bootstrap_report_recorded':
            need(last['facts']['report_sha256']==report_sha256,'bootstrap_report_conflict')
            return self.status(identity)
        need(last['phase']=='bootstrap_remote_intent','bootstrap_remote_intent_missing')
        now,domain=self._clock(op)
        self.j.append(identity,'bootstrap_report_recorded',{'report_sha256':report_sha256,'independent_acceptance':False},
          at_ns=now,clock_domain_sha256=domain,expected_previous_sha256=op['records'][-1]['sha256'])
        return self.status(identity)
    def status(self,identity):
        op=self._existing(identity);phase=op['records'][-1]['body']['phase']
        return {'operation_id':identity,'phase':phase,'consumed':True,'automatic_retry':False,
          'worker_witness_recorded':any(r['body']['phase']=='bootstrap_worker_bound'for r in op['records']),
          'remote_effect_proven':False,'independent_acceptance':False,'policy_promoted':False}
