"""Existing-data backup under a separate, default-absent Root profile.

No service control, source marker writes, grant changes, or wire collection.
The host backup worker owns ordinary household stops/starts. A closed source
authorization is a policy fact, never proof of a healthy protocol cut.
"""
from pathlib import Path
import json,math,os,time
from authorization_gate import AuthorizationGate
from maintenance_journal import canonical,closed,digest,hex64,uint,MaintenanceUnavailable
from maintenance_backend import decode
from backup_snapshot import prepare_closed,artifact
from recovery_data import directory

SCOPE='mqtt_metadata_closed_backup_v1'

def need(ok,reason='frozen_backup_unconfirmed'):
    if not ok:raise MaintenanceUnavailable(reason)

def source_authorization(paths,*,wall=time.time):
    """Observe only. In particular, never call refresh(), which can enable a marker."""
    gate=AuthorizationGate(paths.runtime,paths.authorization)
    try:
        p,sha=gate._read();now=wall();need(type(now)in(int,float)and math.isfinite(now)and now>=0)
        state='disabled'if not p['enabled']else'expired'if p['expires_at']is not None and now>=p['expires_at']else'active'
        gate._runtime_anchor()
        try:
            info=(paths.runtime/'revoked').lstat()
            need(AuthorizationGate._marker_valid(info),'frozen_backup_marker_invalid');state='revoked'
        except FileNotFoundError:pass
        try:
            info=(paths.runtime/'authorized').lstat()
            need(AuthorizationGate._marker_valid(info),'frozen_backup_marker_invalid');marker=True
        except FileNotFoundError:marker=False
        return {'source_authorization_sha256':sha,'source_approval_sha256':p['approval_id'],
          'source_authorization_state':state,'source_expires_at':'none'if p['expires_at']is None else str(p['expires_at']),
          'source_runtime_marker_present':marker}
    finally:gate.close()

class FrozenBackup:
    def __init__(self,journal,backend,paths,*,wall=time.time):
        self.j=journal;self.b=backend;self.paths=paths;self.wall=wall
    def profile(self):
        self.b.verify_installed_code()
        self.j.tx._anchors();raw=self.j.tx._read(self.j.tx.state_fd,'closed-backup-policy.json',0o600);p=decode(raw)
        closed(p,['schema_version','scope','enabled','expires_at','approval_sha256','code_manifest_sha256','maximum_duration_ns'])
        need(type(p['schema_version'])is int and p['schema_version']==1 and p['scope']==SCOPE and p['enabled']is True
          and p['approval_sha256']==self.b.policy['approval_sha256']and p['code_manifest_sha256']==self.b.policy['code_manifest_sha256'],
          'frozen_backup_profile_closed')
        expiry=p['expires_at'];need(expiry is None or type(expiry)in(int,float)and math.isfinite(expiry)and 0<expiry<2**53)
        need(expiry is None or self.wall()<expiry,'frozen_backup_profile_expired')
        need(uint(p['maximum_duration_ns'],64)>0,'frozen_backup_profile_bounds')
        return p
    def _clock(self,op=None):
        now,domain=self.b.clock();uint(now,64);need(hex64(domain))
        if op:
            first=op['records'][0]['body'];last=op['records'][-1]['body']
            need(first['clock_domain_sha256']==domain and uint(now,64)>=uint(last['at_ns'],64),'frozen_backup_clock_changed')
        return now,domain
    def _result(self,identity,state):
        return {'operation_id':identity,'state':state,'metadata_integrity':'unknown','source_effects_executed':False,
          'automatic_retry':False,'full24h_proven':False}
    def _source(self):
        value=source_authorization(self.paths,wall=self.wall)
        need(value['source_authorization_state']!='active','frozen_backup_source_active')
        need(value['source_approval_sha256']==self.b.policy['approval_sha256'],'frozen_backup_approval_changed')
        return value
    def _operation(self,identity):
        op=self.j.find(identity)
        need(op is not None and op['approval_sha256']==self.b.policy['approval_sha256']
          and op['records'][0]['body']['phase']=='frozen_begin','frozen_backup_operation_invalid')
        p=self.profile();need(op['records'][0]['body']['facts']['profile_sha256']==digest(p),'frozen_backup_profile_changed')
        return op
    def prepare(self,identity):
        p=self.profile();source=self._source();op=self.j.find(identity)
        if op is not None:
            op=self._operation(identity)
            return self._result(identity,'backup_closed_metadata_complete'if op['records'][-1]['body']['phase']=='frozen_complete'else'backup_closed_capture_ready')
        state=self.j.status()
        need(not state or all(o['records'][0]['body']['phase']=='frozen_begin'or
          o['records'][-1]['body']['phase']in('complete','cancelled','rescued')for o in state['body']['operations']),
          'frozen_backup_prior_effect_unresolved')
        now,domain=self._clock();deadline=uint(now,64)+uint(p['maximum_duration_ns'],64)
        need(deadline<2**64)
        facts={**source,'code_manifest_sha256':p['code_manifest_sha256'],'profile_sha256':digest(p),
          'deadline_ns':str(deadline),'metadata_integrity':'unknown','effects_dispatched':False}
        self.j.append(identity,'frozen_begin',facts,at_ns=now,clock_domain_sha256=domain,expected_previous_sha256=None)
        return self._result(identity,'backup_closed_capture_ready')
    def _boundary(self,identity):
        op=self._operation(identity);need(op['records'][-1]['body']['phase']=='frozen_begin','frozen_backup_capture_consumed')
        source=self._source();facts=op['records'][0]['body']['facts'];now,_=self._clock(op)
        need(uint(now,64)<uint(facts['deadline_ns'],64),'frozen_backup_deadline')
        need(all(facts[k]==v for k,v in source.items()),'frozen_backup_source_changed')
        return op
    def target(self,identity):
        parent=Path(self.paths.maintenance)/'backup-snapshots'
        directory(parent,0,0,0o700);return parent/identity
    def export(self,identity):
        self._boundary(identity)
        parent=Path(self.paths.maintenance)/'backup-snapshots';parent.mkdir(mode=0o700,exist_ok=True);directory(parent,0,0,0o700)
        target=self.target(identity)
        # A prior intent/copy is never retried. Resume may verify a fully
        # durable artifact after a lost return, but it cannot recopy anything.
        need(not os.path.lexists(target),'frozen_backup_capture_consumed')
        prepare_closed(self.paths,self.j,target,identity,lambda:self._boundary(identity))
        self._boundary(identity)
        return target
    def resume(self,identity):
        op=self._operation(identity);target=self.target(identity);manifest=artifact(target,identity)
        need(manifest['consistency']=='closed_metadata_unknown_cut'and manifest['metadata_integrity']=='unknown')
        source_sha=op['records'][0]['body']['facts']['source_authorization_sha256']
        value={'snapshot_manifest_sha256':digest(manifest),'source_authorization_sha256':source_sha,
          'metadata_integrity':'unknown','effects_dispatched':False}
        if op['records'][-1]['body']['phase']=='frozen_complete':
            need(op['records'][-1]['body']['facts']==value,'frozen_backup_snapshot_changed')
        else:
            now,domain=self._clock(op)
            self.j.append(identity,'frozen_complete',value,at_ns=now,clock_domain_sha256=domain,
              expected_previous_sha256=op['records'][-1]['sha256'])
        return self._result(identity,'backup_closed_metadata_complete')
