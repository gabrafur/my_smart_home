"""Compare/replace only the reader binding, linked to a durable ready record.

The caller holds the maintenance journal lock and supplies its sealed backend.
An existing intent is reconciled by reading; it never replays policy writes.
No Docker, source start, renewal, arbitrary paths or caller-provided policies.
"""
import hashlib,json,os,stat,re
from maintenance_journal import canonical,digest,validate_operation,MaintenanceUnavailable,hex64,uint
from worker_config import load_source_policy,policy_document,policy_from_document
from source_rebind import read_root,RebindUnavailable,validate_request
from authorization_gate import GateInvalid
from maintenance_controller import ObservationUnavailable

class Transaction:
    def __init__(self,tx,backend,op):
        validate_operation(op)
        if op['records'][-1]['body']['phase']!='consumer_ready':raise MaintenanceUnavailable('binding_phase_changed')
        self.tx=tx;self.backend=backend;self.op=op;self.name='binding-'+op['operation_id']+'.json'
    def _load(self):
        self.tx._anchors()
        try:raw=self.tx._read(self.tx.state_fd,self.name,0o600)
        except FileNotFoundError:return None
        try:v=json.loads(raw)
        except(ValueError,UnicodeError):raise MaintenanceUnavailable('binding_receipt_invalid')from None
        if type(v)is not dict or canonical(v)!=raw or set(v)!={'body','sha256'}or v['sha256']!=digest(v['body']):
            raise MaintenanceUnavailable('binding_receipt_invalid')
        b=v['body']
        if(type(b)is not dict or set(b)!={'schema_version','operation_id','approval_sha256','phase','before_file_sha256',
           'after_file_sha256','before_policy','before_file_hex','after_policy','request'}or type(b['schema_version'])is not int or b['schema_version']!=1
           or not hex64(b['before_file_sha256'])or not hex64(b['after_file_sha256'])
           or b['operation_id']!=self.op['operation_id']or b['approval_sha256']!=self.op['approval_sha256']
           or b['phase']not in('intent','files_written','reader_confirmed')
           or b['after_policy']!=self.backend.policy['source_definition']):
            raise MaintenanceUnavailable('binding_receipt_changed')
        try:
            validate_request(b['request']);policy_from_document(b['before_policy'])
            if not(type(b['before_file_hex'])is str and len(b['before_file_hex'])<=8192
                   and re.fullmatch('(?:[a-f0-9]{2})+',b['before_file_hex'])):
                raise ValueError()
            before_raw=bytes.fromhex(b['before_file_hex']);request=b['request'];begin=self.op['records'][0]['body']['facts']
            if(hashlib.sha256(before_raw).hexdigest()!=b['before_file_sha256']or json.loads(before_raw)!=b['before_policy']
              or hashlib.sha256(canonical(b['after_policy'])).hexdigest()!=b['after_file_sha256']
              or digest(b['before_policy'])!=request['before_policy_sha256']
              or digest(b['after_policy'])!=request['after_policy_sha256']
              or b['before_policy']['approval_id']!=self.op['approval_sha256']
              or request['operation_id']!=self.op['operation_id']or request['approval_sha256']!=self.op['approval_sha256']
              or request['journal_head_sha256']!=self.op['records'][-1]['sha256']
              or uint(request['issued_at_ns'],64)<uint(self.op['records'][-1]['body']['at_ns'],64)
              or request['reader_instance_sha256']!=begin['reader_instance_sha256']
              or request['clock_domain_sha256']!=self.op['records'][0]['body']['clock_domain_sha256']
              or request['old_source_epoch']!=begin['source_epoch']or request['old_source_instance_sha256']!=begin['source_instance_sha256']):
                raise ValueError()
        except(ValueError,KeyError,TypeError,GateInvalid,RebindUnavailable):
            raise MaintenanceUnavailable('binding_receipt_changed')from None
        return v
    def _source_anchor(self,fd):
        path=self.backend.paths.reader_state;a=os.fstat(fd);b=path.lstat()
        if(path.resolve()!=path or not stat.S_ISDIR(b.st_mode)
           or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino)
           or (b.st_uid,b.st_gid,stat.S_IMODE(b.st_mode))!=(0,0,0o700)):
            raise MaintenanceUnavailable('binding_directory_changed')
    def _save(self,b):
        self.tx._anchors();self.tx._atomic(self.tx.state_fd,self.name,canonical({'body':b,'sha256':digest(b)}),0o600)
    def _observe(self,value):
        b=value['body'];backend=self.backend
        from maintenance_backend import read
        try:
            actual=read(backend.paths.reader_state/'source-policy.json',0,0,0o600,4096)
            request=read_root(backend.paths.reader_state/'source-rebind.json',8192)
            metadata,consumer=backend.snapshot()
        except(OSError,RebindUnavailable,ObservationUnavailable):
            return {'state':'binding_result_unknown','dispatched':False,'configuration_dispatched':False,'docker_dispatched':False,'automatic_retry':False}
        confirmed=(hashlib.sha256(actual).hexdigest()==b['after_file_sha256']and request==b['request']
          and metadata['source_policy_sha256']==digest(b['after_policy'])
          and metadata['reader']['reader_instance_sha256']==b['request']['reader_instance_sha256'])
        if confirmed:
            backend._check_rebind_context(self.op,metadata,consumer)
            if b['phase']!='reader_confirmed':
                b={**b,'phase':'reader_confirmed'};self._save(b)
            return {'state':'binding_reader_confirmed','receipt_sha256':digest(b),'dispatched':False,'configuration_dispatched':False,'docker_dispatched':False,'automatic_retry':False}
        return {'state':'binding_result_unknown','dispatched':False,'configuration_dispatched':False,'docker_dispatched':False,'automatic_retry':False}
    def run(self):
        backend=self.backend;existing=self._load()
        if existing is not None:return self._observe(existing)
        backend.authorize(self.op,mutation=True)
        metadata,consumer=backend.snapshot();backend._check_rebind_context(self.op,metadata,consumer)
        desired=backend.policy['source_definition']
        current,approval=load_source_policy(backend.paths.reader_state/'source-policy.json')
        before=policy_document(current,approval)
        if approval!=self.op['approval_sha256']or metadata['source_policy_sha256']!=digest(before):
            raise MaintenanceUnavailable('binding_baseline_unconfirmed')
        if desired==before:
            return {'state':'binding_unchanged','dispatched':False,'configuration_dispatched':False,'docker_dispatched':False,'automatic_retry':False}
        from maintenance_backend import read
        before_raw=read(backend.paths.reader_state/'source-policy.json',0,0,0o600,4096)
        # Revalidate after the separate loader read, before recording an intent.
        if json.loads(before_raw)!=before:raise MaintenanceUnavailable('binding_baseline_changed')
        begin=self.op['records'][0]['body']['facts'];now,domain=backend.clock()
        request={'schema_version':1,'operation_id':self.op['operation_id'],'approval_sha256':self.op['approval_sha256'],
          'journal_head_sha256':self.op['records'][-1]['sha256'],'before_policy_sha256':digest(before),
          'after_policy_sha256':digest(desired),'reader_instance_sha256':begin['reader_instance_sha256'],
          'clock_domain_sha256':domain,'old_source_epoch':begin['source_epoch'],
          'old_source_instance_sha256':begin['source_instance_sha256'],'issued_at_ns':now,
          'expires_at':backend.policy['expires_at']}
        b={'schema_version':1,'operation_id':self.op['operation_id'],'approval_sha256':self.op['approval_sha256'],
          'phase':'intent','before_file_sha256':hashlib.sha256(before_raw).hexdigest(),
          'after_file_sha256':hashlib.sha256(canonical(desired)).hexdigest(),
          'before_policy':before,'before_file_hex':before_raw.hex(),'after_policy':desired,'request':request}
        self._save(b)
        # Request before policy: a partial write never permits a cold new policy
        # to appear as a successful in-process rebind. Reader proof is separate.
        directory=os.open(backend.paths.reader_state,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            self._source_anchor(directory)
            backend.authorize(self.op,mutation=True)
            if read(backend.paths.reader_state/'source-policy.json',0,0,0o600,4096)!=before_raw:
                raise MaintenanceUnavailable('binding_compare_conflict')
            self._source_anchor(directory);self.tx._atomic(directory,'source-rebind.json',canonical(request),0o600)
            self._source_anchor(directory)
            backend.authorize(self.op,mutation=True)
            if read(backend.paths.reader_state/'source-policy.json',0,0,0o600,4096)!=before_raw:
                raise MaintenanceUnavailable('binding_compare_conflict')
            self._source_anchor(directory);self.tx._atomic(directory,'source-policy.json',canonical(desired),0o600)
            self._source_anchor(directory)
        finally:os.close(directory)
        self._save({**b,'phase':'files_written'})
        return {'state':'binding_awaiting_reader','dispatched':True,'configuration_dispatched':True,'docker_dispatched':False,'automatic_retry':False}
