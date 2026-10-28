"""Static-file transaction for a separately approved, sealed MQTT installer.

No CLI, service control, Docker access, credential paths or authorization files.
The lifecycle installer must stop the new reader and restore the broker before
calling rollback. A durable intent never permits an automatic apply retry.
"""
from pathlib import Path
import fcntl,hashlib,json,os,re,stat

CORE=('activated_reader.py','authorization_gate.py','deployment_files.py',
      'file_bridge.py','handoff.py','handoff_ledger.py','protocol.py',
      'receiver_ledger.py','recovery_data.py','socket_reader.py','source_binding.py',
      'status_writer.py','worker.py','worker_config.py')
TARGETS={**{'code/'+n:('opt/raspberry-mqtt-observation/'+n,0o644)for n in CORE},
 'reader_service':('etc/systemd/system/raspberry-mqtt-observation.service',0o644),
 'reader_socket':('etc/systemd/system/raspberry-mqtt-observation.socket',0o644),
 'plugin':('opt/raspberry-mqtt-observation/native/observer.so',0o444),
 **{'license/'+n:('opt/raspberry-mqtt-observation/native/licenses/'+n,0o444)
    for n in ('LICENSE.project','LICENSE.sdk.txt','EDL-v1.0.txt','EPL-v2.0.txt','sdk-manifest.json')},
 'compose_override':('etc/raspberry-mqtt-observation/compose.yml',0o444),
 'broker_config':('etc/raspberry-mqtt-observation/mosquitto.conf',0o444)}
LIMIT=1048576
HEX=re.compile('[a-f0-9]{64}')
class DeploymentUnavailable(RuntimeError):pass
def need(ok,code):
    if not ok:raise DeploymentUnavailable(code)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
def pairs(rows):
    out={}
    for k,v in rows:
        need(k not in out,'duplicate_json_key');out[k]=v
    return out
def manifest_hash(spec):return digest(canonical(spec))
def validate_spec(spec):
    need(type(spec)is dict and set(spec)==set(TARGETS),'static_target_set_invalid')
    for row in spec.values():
        need(type(row)is dict and set(row)=={'before_sha256','after_sha256'},'static_target_record_invalid')
        for key in ['before_sha256','after_sha256']:
            value=row[key]
            need((key=='before_sha256'and value is None)or(type(value)is str and HEX.fullmatch(value)),
                 'static_target_digest_invalid')

class FileTransaction:
    def __init__(self,root,state,approval_manifest_sha256,*,uid=0,gid=0,read_only=False):
        need(os.geteuid()==uid and os.getegid()==gid,'deployment_role_invalid')
        need(type(approval_manifest_sha256)is str and HEX.fullmatch(approval_manifest_sha256),'manifest_digest_invalid')
        self.root=Path(root);self.state=Path(state);self.uid=uid;self.gid=gid
        self.approval=approval_manifest_sha256;self.root_fd=None;self.state_fd=None;self.lock=None
        need(type(read_only)is bool,'deployment_mode_invalid');self.read_only=read_only
        try:
            self.root_fd=self._directory(self.root,None)
            self.state_fd=self._directory(self.state,0o700)
            flags=os.O_RDONLY if read_only else os.O_RDWR|os.O_CREAT
            self.lock=os.open('operation.lock',flags|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.state_fd)
            self._file(os.fstat(self.lock),0o600)
            try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise DeploymentUnavailable('deployment_busy')from None
        except BaseException:self.close();raise
    def _directory(self,path,mode):
        need(path.is_absolute()and path.resolve()==path,'deployment_directory_invalid')
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            s=os.fstat(fd)
            need(stat.S_ISDIR(s.st_mode)and(s.st_uid,s.st_gid)==(self.uid,self.gid)
                 and not stat.S_IMODE(s.st_mode)&0o022 and(mode is None or stat.S_IMODE(s.st_mode)==mode),
                 'deployment_directory_unsafe')
            return fd
        except BaseException:os.close(fd);raise
    def _anchors(self):
        for path,fd in [(self.root,self.root_fd),(self.state,self.state_fd)]:
            need(fd is not None,'deployment_closed');a=os.fstat(fd);b=path.lstat()
            need((a.st_dev,a.st_ino)==(b.st_dev,b.st_ino)and stat.S_ISDIR(b.st_mode)
                 and(b.st_uid,b.st_gid)==(self.uid,self.gid)and not stat.S_IMODE(b.st_mode)&0o022,
                 'deployment_directory_changed')
            if path==self.state:need(stat.S_IMODE(b.st_mode)==0o700,'deployment_directory_changed')
    def _file(self,s,mode=None):
        need(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and(s.st_uid,s.st_gid)==(self.uid,self.gid)
             and stat.S_IMODE(s.st_mode)in((mode,)if mode is not None else(0o444,0o644))
             and 0<=s.st_size<=LIMIT,'deployment_file_unsafe')
    def _read(self,fd,name,mode=None):
        file=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
        try:
            a=os.fstat(file);self._file(a,mode);raw=os.read(file,LIMIT+1);b=os.fstat(file)
            need(len(raw)==a.st_size and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==
                 (b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns),'deployment_file_changed')
            return raw
        finally:os.close(file)
    def _parent(self,key,*,create=False):
        self._anchors();need(key in TARGETS,'static_target_unknown')
        parts=Path(TARGETS[key][0]).parts;fd=os.dup(self.root_fd)
        try:
            for part in parts[:-1]:
                try:next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                except FileNotFoundError:
                    if not create:return None,parts[-1]
                    os.mkdir(part,0o755,dir_fd=fd);os.fsync(fd)
                    next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                s=os.fstat(next_fd)
                if (s.st_uid,s.st_gid)!=(self.uid,self.gid)or stat.S_IMODE(s.st_mode)&0o022:
                    os.close(next_fd);raise DeploymentUnavailable('target_parent_unsafe')
                os.close(fd);fd=next_fd
            out=fd;fd=None;return out,parts[-1]
        finally:
            if fd is not None:os.close(fd)
    def _current(self,key):
        fd,name=self._parent(key)
        if fd is None:return None
        try:
            try:return self._read(fd,name,TARGETS[key][1])
            except FileNotFoundError:return None
        finally:os.close(fd)
    def _atomic(self,fd,name,raw,mode):
        temp='.mqtt-txn-'+os.urandom(12).hex()
        file=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
        try:
            os.fchmod(file,mode)
            with os.fdopen(file,'wb',closefd=False)as out:out.write(raw);out.flush();os.fsync(file)
            os.replace(temp,name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
        finally:
            os.close(file)
            try:os.unlink(temp,dir_fd=fd)
            except FileNotFoundError:pass
    def _save(self,body):
        self._anchors();raw=canonical(body)
        self._atomic(self.state_fd,'transaction.json',canonical({'body':body,'sha256':digest(raw)}),0o600)
    def _load(self):
        self._anchors()
        try:envelope=json.loads(self._read(self.state_fd,'transaction.json',0o600),object_pairs_hook=pairs)
        except FileNotFoundError:return None
        except(ValueError,UnicodeError):raise DeploymentUnavailable('deployment_journal_invalid')from None
        need(type(envelope)is dict and set(envelope)=={'body','sha256'},'deployment_journal_invalid')
        body=envelope['body'];need(digest(canonical(body))==envelope['sha256'],'deployment_journal_corrupt')
        need(type(body)is dict and set(body)=={'version','manifest_sha256','phase','targets'}and type(body['version'])is int
             and body['version']==1 and body['manifest_sha256']==self.approval,'deployment_journal_invalid')
        need(body['phase']in {'prepared','applying','applied','interrupted','rolling_back','rolled_back','rollback_conflict'},
             'deployment_journal_invalid')
        need(type(body['targets'])is dict and set(body['targets'])==set(TARGETS),'deployment_journal_invalid')
        spec={}
        for key,row in body['targets'].items():
            need(type(row)is dict and set(row)=={'before_sha256','after_sha256','state'}and
                 row['state']in {'pending','writing','written','restored','conflict'},'deployment_journal_invalid')
            spec[key]={k:v for k,v in row.items()if k!='state'}
        validate_spec(spec);need(manifest_hash(spec)==self.approval,'deployment_manifest_changed')
        return body
    def status(self):
        body=self._load()
        if body is None:return {'state':'not_started','mutation_performed':False}
        current={key:None if(raw:=self._current(key))is None else digest(raw)for key in TARGETS}
        drift=[key for key,row in body['targets'].items()if current[key] not in [row['before_sha256'],row['after_sha256']]]
        after=all(current[k]==r['after_sha256']for k,r in body['targets'].items())
        before=all(current[k]==r['before_sha256']for k,r in body['targets'].items())
        phase=body['phase']
        state=phase
        if phase=='applied'and not after:state='applied_receipt_current_targets_changed'
        if phase=='rolled_back'and not before:state='rollback_receipt_current_targets_changed'
        return {'state':state,'receipt_phase':phase,'manifest_sha256':self.approval,
                'targets_match_applied':after,'targets_match_baseline':before,
                'unexpected_target_keys':drift,'mutation_performed':False}
    def _backup_name(self,key):return 'before-'+hashlib.sha256(key.encode('ascii')).hexdigest()+'.bin'
    def preflight(self,spec,artifacts):
        validate_spec(spec);need(manifest_hash(spec)==self.approval,'deployment_manifest_changed')
        need(type(artifacts)is dict and set(artifacts)==set(TARGETS),'artifact_set_invalid')
        for key in TARGETS:
            raw=artifacts[key]
            need(type(raw)is bytes and len(raw)<=LIMIT and digest(raw)==spec[key]['after_sha256'],'artifact_digest_mismatch')
            old=self._current(key)
            need((None if old is None else digest(old))==spec[key]['before_sha256'],'target_compare_conflict')
        need(self._load()is None,'existing_intent_requires_reconciliation')
        return {'state':'preflight_passed_not_applied','targets':len(TARGETS),'production_changes':False}
    def _replace(self,key,raw,expected):
        old=self._current(key);need((None if old is None else digest(old))==expected,'target_compare_conflict')
        fd,name=self._parent(key,create=True)
        try:
            try:current=self._read(fd,name)
            except FileNotFoundError:current=None
            need((None if current is None else digest(current))==expected,'target_compare_conflict')
            self._atomic(fd,name,raw,TARGETS[key][1])
        finally:os.close(fd)
    def apply_approved(self,spec,artifacts):
        need(not self.read_only,'readonly_deployment_handle')
        validate_spec(spec);need(manifest_hash(spec)==self.approval,'deployment_manifest_changed')
        need(type(artifacts)is dict and set(artifacts)==set(TARGETS),'artifact_set_invalid')
        need(all(type(v)is bytes and len(v)<=LIMIT and digest(v)==spec[k]['after_sha256']for k,v in artifacts.items()),
             'artifact_digest_mismatch')
        old=self._load()
        if old is not None:
            need(old['phase']=='applied','existing_intent_requires_reconciliation')
            return self.status()
        self.preflight(spec,artifacts)
        body={'version':1,'manifest_sha256':self.approval,'phase':'prepared',
              'targets':{k:{**v,'state':'pending'}for k,v in spec.items()}}
        self._save(body)
        # Backups are immutable and exclude all grant, binding and private data paths.
        for key in TARGETS:
            raw=self._current(key)
            need((None if raw is None else digest(raw))==spec[key]['before_sha256'],'target_compare_conflict')
            if raw is not None:
                name=self._backup_name(key)
                fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.state_fd)
                try:
                    with os.fdopen(fd,'wb',closefd=False)as out:out.write(raw);out.flush();os.fsync(fd)
                finally:os.close(fd)
        os.fsync(self.state_fd)
        try:
            body['phase']='applying'
            for key in TARGETS:
                body['targets'][key]['state']='writing';self._save(body)
                self._replace(key,artifacts[key],spec[key]['before_sha256'])
                need(digest(self._current(key))==spec[key]['after_sha256'],'target_write_unconfirmed')
                body['targets'][key]['state']='written';self._save(body)
            body['phase']='applied';self._save(body)
            return self.status()
        except BaseException:
            body['phase']='interrupted';self._save(body);raise
    def rollback_after_quiescence(self):
        need(not self.read_only,'readonly_deployment_handle')
        body=self._load();need(body is not None,'deployment_not_started')
        if body['phase']=='rolled_back':return self.status()
        body['phase']='rolling_back';self._save(body);conflicts=[]
        for key,row in body['targets'].items():
            old=self._current(key);current=None if old is None else digest(old)
            if current==row['before_sha256']:
                row['state']='restored';self._save(body);continue
            if current!=row['after_sha256']:
                conflicts.append(key);row['state']='conflict';self._save(body);continue
            if row['before_sha256']is None:
                fd,name=self._parent(key)
                try:
                    need(digest(self._read(fd,name))==row['after_sha256'],'rollback_compare_conflict')
                    os.unlink(name,dir_fd=fd);os.fsync(fd)
                finally:os.close(fd)
            else:
                raw=self._read(self.state_fd,self._backup_name(key),0o600)
                need(digest(raw)==row['before_sha256'],'deployment_backup_corrupt')
                self._replace(key,raw,row['after_sha256'])
            row['state']='restored';self._save(body)
        body['phase']='rollback_conflict'if conflicts else'rolled_back';self._save(body)
        return self.status()
    def close(self):
        for name in ['lock','state_fd','root_fd']:
            fd=getattr(self,name,None)
            if fd is not None:os.close(fd);setattr(self,name,None)
