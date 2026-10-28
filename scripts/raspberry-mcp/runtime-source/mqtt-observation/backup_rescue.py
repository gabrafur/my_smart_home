"""Initially sealed, bounded restoration after metadata maintenance fails.

Close only the new observer, then restore the two original fixed services.
No stop, new target, data repair, grant renewal or uncertain start retry.
This explicitly ends the observation with unknown integrity, never a 24h pass.
"""
from dataclasses import dataclass
from pathlib import Path
import hashlib,os,time
from authorization_gate import AuthorizationGate
from maintenance_journal import canonical,digest,closed,hex64,uint,MaintenanceUnavailable
from maintenance_backend import read,directory,decode
from maintenance_controller import facts,records

SCOPE='mqtt_metadata_backup_rescue_v1'
KINDS=('disable_metadata','start_consumer','start_source')
@dataclass(frozen=True)
class Paths:
    runtime:Path=Path('/run/raspberry-mqtt-observation')
    plugin:Path=Path('/opt/raspberry-mqtt-observation/native/observer.so')
def need(value,code='backup_rescue_unconfirmed'):
    if not value:raise MaintenanceUnavailable(code)

class Rescue:
    def __init__(self,controller,paths=Paths()):
        self.c=controller;self.b=controller.backend;self.tx=controller.journal.tx;self.paths=paths
        self.body=None;self.op=None
    def _read(self,name):
        self.tx._anchors();raw=self.tx._read(self.tx.state_fd,name,0o600);v=decode(raw)
        need(canonical(v)==raw,'backup_rescue_noncanonical');return v
    def _profile(self,op):
        p=self._read('backup-rescue-policy.json')
        closed(p,['schema_version','scope','enabled','approval_sha256','code_manifest_sha256',
                  'maximum_recovery_ns','observation_interval_ns'])
        need(type(p['schema_version'])is int and p['schema_version']==1 and p['scope']==SCOPE
          and p['enabled']is True and p['approval_sha256']==op['approval_sha256']
          and p['code_manifest_sha256']==facts(op,'begin')['code_manifest_sha256'],'backup_rescue_profile_closed')
        need(0<uint(p['observation_interval_ns'],64)<=uint(p['maximum_recovery_ns'],64),'backup_rescue_profile_bounds')
        return p
    def _name(self,op):return 'backup-rescue-'+op['operation_id']+'.json'
    def _save(self):
        self.tx._anchors();self.tx._atomic(self.tx.state_fd,self._name(self.op),
          canonical({'body':self.body,'sha256':digest(self.body)}),0o600)
    def seal(self,operation_id,primary_duration_ns):
        op=self.c._operation(operation_id);need(op is not None);p=self._profile(op)
        need(facts(op,'begin')['purpose']=='backup_snapshot','backup_rescue_purpose_changed')
        self.b.authorize(op,mutation=True)
        try:old=self._read(self._name(op))
        except FileNotFoundError:old=None
        if old is not None:
            self._load(operation_id);need(self.body['primary_duration_ns']==primary_duration_ns,'backup_rescue_budget_changed');return
        need(op['records'][-1]['body']['phase']=='begin','backup_rescue_seal_boundary_changed')
        total=uint(primary_duration_ns,64)+uint(p['maximum_recovery_ns'],64)
        deadline=uint(op['records'][0]['body']['at_ns'],64)+total
        need(deadline<2**64,'backup_rescue_profile_bounds');self.b.validate_rescue_duration(total)
        self.op=op;self.body={'schema_version':1,'scope':SCOPE,'operation_id':operation_id,
          'approval_sha256':op['approval_sha256'],'begin_sha256':op['records'][0]['sha256'],
          'code_manifest_sha256':p['code_manifest_sha256'],'profile_sha256':digest(p),
          'clock_domain_sha256':op['records'][0]['body']['clock_domain_sha256'],
          'primary_duration_ns':primary_duration_ns,'recovery_until_ns':str(deadline),
          'operation_head_sha256':None,'steps':[]};self._save()
    def _load(self,operation_id):
        op=self.c._operation(operation_id);need(op is not None);p=self._profile(op)
        self.b.authorize_rescue(op);v=self._read(self._name(op));closed(v,['body','sha256']);r=v['body']
        need(v['sha256']==digest(r));closed(r,['schema_version','scope','operation_id','approval_sha256',
          'begin_sha256','code_manifest_sha256','profile_sha256','clock_domain_sha256','primary_duration_ns',
          'recovery_until_ns','operation_head_sha256','steps'])
        need(type(r['schema_version'])is int and r['schema_version']==1 and r['scope']==SCOPE
          and r['operation_id']==operation_id and r['approval_sha256']==op['approval_sha256']
          and r['begin_sha256']==op['records'][0]['sha256']and r['profile_sha256']==digest(p)
          and r['code_manifest_sha256']==facts(op,'begin')['code_manifest_sha256']
          and r['clock_domain_sha256']==op['records'][0]['body']['clock_domain_sha256']
          and uint(r['recovery_until_ns'],64)==uint(op['records'][0]['body']['at_ns'],64)
            +uint(r['primary_duration_ns'],64)+uint(p['maximum_recovery_ns'],64),'backup_rescue_binding_changed')
        need(type(r['steps'])is list and len(r['steps'])<=6)
        progress={};last_time=uint(op['records'][0]['body']['at_ns'],64)
        for row in r['steps']:
            closed(row,['kind','phase','at_ns','binding_sha256','state_sha256'])
            need(row['kind']in KINDS and row['phase']in('intent','observed')
              and all(hex64(row[k])for k in('binding_sha256','state_sha256'))
              and uint(row['at_ns'],64)>=last_time)
            kind=row['kind'];index=KINDS.index(kind)
            need(all(progress.get(k)=='observed'for k in KINDS[:index]))
            need(kind not in progress or(progress[kind]=='intent'and row['phase']=='observed'))
            progress[kind]=row['phase'];last_time=uint(row['at_ns'],64)
        head=op['records'][-1]
        need(r['operation_head_sha256']is None and not r['steps']or
          hex64(r['operation_head_sha256'])and(r['operation_head_sha256']==head['sha256']or
            head['body']['phase']=='rescued'and head['body']['previous_sha256']==r['operation_head_sha256']),
          'backup_rescue_operation_changed')
        if head['body']['phase']=='rescued':need(head['body']['facts']['rescue_receipt_sha256']==digest(r))
        self.op,self.body=op,r;self.c._clock(op);return p,progress
    def _row(self,kind,phase,binding,state):
        now,_=self.c._clock(self.op)
        if self.body['operation_head_sha256']is None:self.body['operation_head_sha256']=self.op['records'][-1]['sha256']
        self.body['steps'].append({'kind':kind,'phase':phase,'at_ns':now,
          'binding_sha256':binding,'state_sha256':state});self._save()
    def _effect_budget(self):
        self.b.authorize_rescue(self.op);now,_=self.c._clock(self.op)
        remaining=uint(self.body['recovery_until_ns'],64)-uint(now,64)
        need(remaining>0,'backup_rescue_deadline_reached');return remaining/1_000_000_000
    def _revoked(self):
        directory(self.paths.runtime,0,0,0o755)
        try:s=(self.paths.runtime/'revoked').lstat()
        except FileNotFoundError:return False
        need(AuthorizationGate._marker_valid(s),'backup_rescue_marker_invalid');return True
    def _disable(self,progress):
        mounts=self.b.inspect('source')['mounts']
        for destination,path in [('/run/raspberry-mqtt-observation',self.paths.runtime),
                                 ('/mosquitto/metadata/observer.so',self.paths.plugin)]:
            matches=[m for m in mounts if m['Destination']==destination]
            need(len(matches)==1 and matches[0]['Type']=='bind'and matches[0]['RW']is False
              and matches[0]['Source']==str(path),'backup_rescue_mount_changed')
        need(hashlib.sha256(read(self.paths.plugin,0,0,0o444,8388608)).hexdigest()
          ==self.b.policy['source_definition']['plugin_sha256'],'backup_rescue_plugin_changed')
        if progress.get('disable_metadata')=='observed':return self._revoked()
        directory(self.paths.runtime,0,0,0o755)
        runtime_fd=os.open(self.paths.runtime,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            opened=os.fstat(runtime_fd);named=self.paths.runtime.lstat()
            need((opened.st_dev,opened.st_ino)==(named.st_dev,named.st_ino),'backup_rescue_runtime_changed')
            if 'disable_metadata'not in progress:
                self._row('disable_metadata','intent',self.b.policy['source']['identity_sha256'],digest({'revoked':self._revoked()}))
                self._effect_budget()
                if not self._revoked():self.tx._atomic(runtime_fd,'revoked',b'',0o444)
                try:positive=os.stat('authorized',dir_fd=runtime_fd,follow_symlinks=False)
                except FileNotFoundError:positive=None
                if positive is not None:
                    need(AuthorizationGate._marker_valid(positive),'backup_rescue_marker_invalid')
                    os.unlink('authorized',dir_fd=runtime_fd);os.fsync(runtime_fd)
            if not self._revoked():return False
            # The producer checks this sticky marker even if a failed reader
            # has not yet removed its old positive marker. Never re-enable it.
            self._row('disable_metadata','observed',self.b.policy['source']['identity_sha256'],digest({'revoked':True}))
            return True
        finally:os.close(runtime_fd)
    def _running(self,role,progress):
        kind='start_'+role;v=self.b.inspect(role);s=v['state'];rows=records(self.op)
        need(not(s['Paused']or s['Restarting']or s['Dead']),'backup_rescue_target_uncertain')
        stop=role+'_stop_intent';stopped=role+'_stopped'
        if s['Running']:
            if s['Pid']<=0:return False
            if kind not in progress and stop in rows and stopped not in rows:return False
            if progress.get(kind)!='observed':self._row(kind,'observed',v['binding_sha256'],v['state_sha256'])
            return True
        # An original or rescue start intent is consumed, including a lost
        # response before dispatch. A new actor cannot sidestep that intent.
        if role+'_start_intent'in rows or kind in progress:return False
        need(s['Pid']==0,'backup_rescue_target_uncertain')
        self._row(kind,'intent',v['binding_sha256'],v['state_sha256']);self._effect_budget()
        current=self.b.inspect(role)
        need(current['binding_sha256']==v['binding_sha256']and current['state_sha256']==v['state_sha256'],
             'backup_rescue_boundary_changed')
        try:self.b._run(['start',self.b.policy[role]['container_id']],timeout=min(12,self._effect_budget()),limit=1024)
        except Exception:return False
        current=self.b.inspect(role)
        if not current['state']['Running']or current['state']['Pid']<=0:return False
        self._row(kind,'observed',current['binding_sha256'],current['state_sha256']);return True
    def step(self,operation_id):
        p,progress=self._load(operation_id);phase=self.op['records'][-1]['body']['phase'];now,_=self.c._clock(self.op)
        result={'operation_id':operation_id,'automatic_retry':False,'full24h_proven':False,'metadata_integrity':'unknown'}
        if phase in('complete','cancelled'):return {**result,'state':'backup_rescue_not_required','metadata_disabled':False}
        if phase=='failed':return {**result,'state':'backup_rescue_manual_recovery_required','metadata_disabled':self._revoked()}
        if uint(now,64)>=uint(self.body['recovery_until_ns'],64):
            return {**result,'state':'backup_rescue_deadline_reached','metadata_disabled':self._revoked()}
        if 'source_stop_intent'not in records(self.op):
            self.c._append(operation_id,'cancelled',{'reason':'deadline','no_effects_dispatched':True},self.op)
            return {**result,'state':'backup_rescue_not_required','metadata_disabled':False}
        if not self._disable(progress):return {**result,'state':'backup_rescue_waiting','metadata_disabled':False}
        for role in('consumer','source'):
            if not self._running(role,progress):return {**result,'state':'backup_rescue_waiting','metadata_disabled':True}
        if phase!='rescued':self.c._append(operation_id,'rescued',{'reason':'deadline',
          'rescue_receipt_sha256':digest(self.body),'metadata_disabled':True},self.op)
        return {**result,'state':'backup_rescue_house_running_metadata_disabled','metadata_disabled':True}
    def run(self,operation_id,*,sleep=time.sleep):
        while True:
            result=self.step(operation_id)
            if result['state']!='backup_rescue_waiting':return result
            p,_=self._load(operation_id);now,_=self.c._clock(self.op)
            remaining=uint(self.body['recovery_until_ns'],64)-uint(now,64)
            if remaining<=0:return self.step(operation_id)
            sleep(min(uint(p['observation_interval_ns'],64),remaining)/1_000_000_000)
