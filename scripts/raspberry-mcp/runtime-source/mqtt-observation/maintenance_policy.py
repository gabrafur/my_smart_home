"""Seal one audited replacement from a fixed Root-owned candidate file.

No candidate, path, container or policy argument is accepted from the caller.
The approved installer/updater must produce the Root audit receipt first.
Existing intents reconcile by reading; they never repeat a policy write.
"""
import copy,hashlib,os,re,stat
from maintenance_journal import canonical,digest,closed,hex64,uint,validate_operation,MaintenanceUnavailable
from maintenance_controller import dispatch_invariants,facts,ObservationUnavailable

def need(value,code='replacement_policy_invalid'):
    if not value:raise MaintenanceUnavailable(code)

class Issuer:
    def __init__(self,tx,backend,op):
        validate_operation(op);need(op['records'][-1]['body']['phase']=='consumer_ready')
        dispatch_invariants(op,'start_source')
        self.tx=tx;self.backend=backend;self.op=op
        self.name='source-policy-seal-'+op['operation_id']+'.json'

    def candidate(self):
        from maintenance_backend import read,decode
        b=self.backend;p=b.paths.policy.parent/'source-candidate.json'
        raw=read(p,0,0,0o600,8192);v=decode(raw)
        closed(v,['schema_version','source','operation_id','approval_sha256','journal_head_sha256',
                  'clock_domain_sha256','issued_at_ns','before_policy_sha256','target','source_definition','audit'])
        need(type(v['schema_version'])is int and v['schema_version']==1
          and v['source']=='fixed_Root_audited_mqtt_replacement')
        need(all(hex64(v[k])for k in ['approval_sha256','journal_head_sha256','clock_domain_sha256','before_policy_sha256']))
        first=self.op['records'][0]['body'];last=self.op['records'][-1]
        need(v['operation_id']==self.op['operation_id']and v['approval_sha256']==self.op['approval_sha256']
          and v['journal_head_sha256']==last['sha256']and v['clock_domain_sha256']==first['clock_domain_sha256'])
        now,domain=b.clock();need(domain==v['clock_domain_sha256']
          and uint(last['body']['at_ns'],64)<=uint(v['issued_at_ns'],64)<=uint(now,64))
        closed(v['target'],['container_id','identity_sha256']);need(all(hex64(x)for x in v['target'].values()))
        d=v['source_definition'];closed(d,['schema_version','container_id','binary_sha256','plugin_sha256','approval_id'])
        need(type(d['schema_version'])is int and d['schema_version']==1
          and all(hex64(d[k])for k in d if k!='schema_version')
          and d['container_id']==v['target']['container_id']and d['approval_id']==v['approval_sha256'])
        a=v['audit'];closed(a,['kind','image_id','binary_sha256','plugin_sha256'])
        need(a['kind']=='fixed_mosquitto_replacement_audit_v1'
          and type(a['image_id'])is str and re.fullmatch('sha256:[a-f0-9]{64}',a['image_id'])is not None
          and a['binary_sha256']==d['binary_sha256']and a['plugin_sha256']==d['plugin_sha256'])
        return raw,v

    def _anchor(self,fd):
        p=self.backend.paths.policy.parent;a=os.fstat(fd);s=p.lstat()
        need(p.resolve()==p and stat.S_ISDIR(s.st_mode)and(a.st_dev,a.st_ino)==(s.st_dev,s.st_ino)
          and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,0,0o700),'replacement_directory_changed')

    def _load(self,candidate):
        self.tx._anchors()
        try:raw=self.tx._read(self.tx.state_fd,self.name,0o600)
        except FileNotFoundError:return None
        from maintenance_backend import decode
        v=decode(raw);closed(v,['body','sha256']);need(v['sha256']==digest(v['body'])and canonical(v)==raw)
        r=v['body'];closed(r,['schema_version','operation_id','approval_sha256','journal_head_sha256',
                            'candidate_sha256','before_file_hex','after_policy'])
        need(type(r['schema_version'])is int and r['schema_version']==1
          and r['operation_id']==self.op['operation_id']and r['approval_sha256']==self.op['approval_sha256']
          and r['journal_head_sha256']==self.op['records'][-1]['sha256']
          and r['candidate_sha256']==hashlib.sha256(candidate[0]).hexdigest())
        need(type(r['before_file_hex'])is str and len(r['before_file_hex'])<=16384
          and re.fullmatch('(?:[a-f0-9]{2})+',r['before_file_hex'])is not None)
        before_raw=bytes.fromhex(r['before_file_hex']);before=decode(before_raw)
        need(hashlib.sha256(before_raw).hexdigest()==candidate[1]['before_policy_sha256'])
        expected=copy.deepcopy(before);expected['source']=candidate[1]['target'];expected['source_definition']=candidate[1]['source_definition']
        need(r['after_policy']==expected,'replacement_receipt_changed')
        return r

    def _observe(self,r,*,dispatched=False):
        from maintenance_backend import read
        raw=read(self.backend.paths.policy,0,0,0o600,8192)
        confirmed=raw==canonical(r['after_policy'])
        return {'state':'replacement_policy_ready'if confirmed else'replacement_policy_unconfirmed',
                'dispatched':dispatched,'configuration_dispatched':dispatched,'docker_dispatched':False,
                'automatic_retry':False,'policy_sha256':hashlib.sha256(raw).hexdigest()}

    def run(self):
        from maintenance_backend import read,decode
        candidate=self.candidate();r=self._load(candidate)
        if r is not None:return self._observe(r)
        b=self.backend;b.authorize(self.op,mutation=True)
        need(facts(self.op,'begin')['purpose']=='container_update','replacement_purpose_invalid')
        before_raw=read(b.paths.policy,0,0,0o600,8192);before=decode(before_raw);v=candidate[1]
        need(hashlib.sha256(before_raw).hexdigest()==v['before_policy_sha256']==b.policy_sha
          and before==b.policy,'replacement_policy_compare_conflict')
        need(v['target']['container_id']not in(before['source']['container_id'],before['consumer']['container_id'])
          and b.inspect('source')['binding_sha256']==facts(self.op,'begin')['source_binding_sha256'],
          'replacement_target_changed')
        m,c=b.snapshot();b._check_rebind_context(self.op,m,c)
        need(m['source_policy_sha256']==digest(before['source_definition']),'replacement_loaded_policy_changed')
        target=b._inspect_target(v['target']);s=target['state']
        need(target['image_id']==v['audit']['image_id']and not any(s[k]for k in ['Running','Paused','Restarting','Dead'])
          and s['Pid']==0 and s['ExitCode']==0,'replacement_candidate_not_stopped')
        after=copy.deepcopy(before);after['source']=v['target'];after['source_definition']=v['source_definition']
        need(len(canonical(after))<=8192)
        r={'schema_version':1,'operation_id':self.op['operation_id'],'approval_sha256':self.op['approval_sha256'],
           'journal_head_sha256':self.op['records'][-1]['sha256'],
           'candidate_sha256':hashlib.sha256(candidate[0]).hexdigest(),
           'before_file_hex':before_raw.hex(),'after_policy':after}
        self.tx._anchors();self.tx._atomic(self.tx.state_fd,self.name,canonical({'body':r,'sha256':digest(r)}),0o600)
        fd=os.open(b.paths.policy.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            self._anchor(fd)
            again=b._inspect_target(v['target'])
            need(again['state_sha256']==target['state_sha256'],'replacement_candidate_changed')
            b.authorize(self.op,mutation=True)
            need(read(b.paths.policy.parent/'source-candidate.json',0,0,0o600,8192)==candidate[0],'replacement_candidate_changed')
            need(read(b.paths.policy,0,0,0o600,8192)==before_raw,'replacement_policy_compare_conflict')
            self._anchor(fd)
            self.tx._atomic(fd,b.paths.policy.name,canonical(after),0o600);self._anchor(fd)
        finally:os.close(fd)
        return self._observe(r,dispatched=True)
