"""Finite backup delegation, sealed before either monitored service stops.

The canonical canvas approves the backup. A separately approved Root worker
drives these fixed mechanics outside Node-RED; it never chooses targets,
renews access, repeats an uncertain effect or decides to retry the backup.
"""
import time
from maintenance_journal import canonical,digest,closed,hex64,uint,MaintenanceUnavailable
from maintenance_controller import facts,dispatch_invariants,ObservationUnavailable
from maintenance_backend import decode

SCOPE='mqtt_metadata_backup_plan_v1'
PREPARE={'begin':('observe','armed'),'armed':('dispatch','stop_source'),
 'source_stop_intent':('dispatch','stop_source'),'source_stopped':('observe','source_drained'),
 'source_drained':('dispatch','stop_consumer'),'consumer_stop_intent':('dispatch','stop_consumer')}
RESUME={'consumer_stopped':('dispatch','start_consumer'),'consumer_start_intent':('dispatch','start_consumer'),
 'consumer_started':('observe','consumer_ready'),'consumer_ready':('dispatch','start_source'),
 'source_start_intent':('dispatch','start_source'),'source_started':('observe','new_source_verified'),
 'new_source_verified':('observe','complete')}

def need(value,reason='backup_plan_unconfirmed'):
    if not value:raise MaintenanceUnavailable(reason)

class BackupPlan:
    def __init__(self,controller):
        self.controller=controller;self.journal=controller.journal;self.tx=self.journal.tx
        self.backend=controller.backend
    def _read(self,name):
        self.tx._anchors();raw=self.tx._read(self.tx.state_fd,name,0o600)
        value=decode(raw);need(canonical(value)==raw,'backup_plan_noncanonical');return raw,value
    def _profile(self,op):
        raw,p=self._read('backup-plan-policy.json')
        closed(p,['schema_version','scope','enabled','approval_sha256','code_manifest_sha256',
                  'maximum_duration_ns','observation_interval_ns'])
        approval=self.backend.policy['approval_sha256']if op is None else op['approval_sha256']
        code=self.backend.policy['code_manifest_sha256']if op is None else facts(op,'begin')['code_manifest_sha256']
        need(type(p['schema_version'])is int and p['schema_version']==1 and p['scope']==SCOPE
          and p['enabled']is True and p['approval_sha256']==approval
          and p['code_manifest_sha256']==code,'backup_plan_profile_closed')
        maximum=uint(p['maximum_duration_ns'],64);interval=uint(p['observation_interval_ns'],64)
        need(0<interval<=maximum,'backup_plan_profile_bounds');return raw,p
    def _name(self,op):return 'backup-plan-'+op['operation_id']+'.json'
    def _operation(self,operation_id):
        need(type(operation_id)is str and len(operation_id)==32 and hex64(operation_id*2),'backup_plan_operation_invalid')
        op=self.controller._operation(operation_id);need(op is not None,'backup_plan_operation_missing')
        need(facts(op,'begin')['purpose']=='backup_snapshot','backup_plan_purpose_changed');return op
    def seal(self,operation_id,expected_head):
        op=self._operation(operation_id);self.backend.authorize(op,mutation=True)
        profile_raw,p=self._profile(op)
        try:old=self._read(self._name(op))
        except FileNotFoundError:old=None
        if old is not None:
            self._checked(op);return self.status(operation_id)
        need(op['records'][-1]['body']['phase']=='begin'
          and op['records'][-1]['sha256']==expected_head,'backup_plan_seal_boundary_changed')
        begin=op['records'][0];now,domain=self.controller._clock(op)
        deadline=uint(begin['body']['at_ns'],64)+uint(p['maximum_duration_ns'],64)
        need(deadline<2**64 and uint(now,64)<deadline,'backup_plan_deadline_reached')
        from backup_rescue import Rescue
        Rescue(self.controller).seal(operation_id,p['maximum_duration_ns'])
        body={'schema_version':1,'scope':SCOPE,'operation_id':operation_id,
          'approval_sha256':op['approval_sha256'],'begin_sha256':begin['sha256'],
          'clock_domain_sha256':domain,'profile_sha256':digest(p),
          'code_manifest_sha256':p['code_manifest_sha256'],'deadline_ns':str(deadline),
          'observation_interval_ns':p['observation_interval_ns']}
        need(self._profile(op)[0]==profile_raw,'backup_plan_profile_changed')
        self.tx._anchors();self.tx._atomic(self.tx.state_fd,self._name(op),
          canonical({'body':body,'sha256':digest(body)}),0o600)
        return self.status(operation_id)
    def _checked(self,op):
        self.backend.authorize(op,mutation=False);_,p=self._profile(op)
        _,value=self._read(self._name(op));closed(value,['body','sha256']);v=value['body']
        need(value['sha256']==digest(v));closed(v,['schema_version','scope','operation_id','approval_sha256',
          'begin_sha256','clock_domain_sha256','profile_sha256','code_manifest_sha256','deadline_ns','observation_interval_ns'])
        begin=op['records'][0]['body']
        need(type(v['schema_version'])is int and v['schema_version']==1 and v['scope']==SCOPE
          and v['operation_id']==op['operation_id']and v['approval_sha256']==op['approval_sha256']
          and v['begin_sha256']==op['records'][0]['sha256']and v['clock_domain_sha256']==begin['clock_domain_sha256']
          and v['profile_sha256']==digest(p)and v['code_manifest_sha256']==facts(op,'begin')['code_manifest_sha256']
          and uint(v['deadline_ns'],64)==uint(begin['at_ns'],64)+uint(p['maximum_duration_ns'],64)
          and v['observation_interval_ns']==p['observation_interval_ns'],'backup_plan_binding_changed')
        now,_=self.controller._clock(op);return v,uint(now,64)
    def _result(self,op,state):
        return {'state':state,'phase':op['records'][-1]['body']['phase'],
          'operation_id':op['operation_id'],'automatic_retry':False,'full24h_proven':False}
    def status(self,operation_id):
        op=self._operation(operation_id);v,now=self._checked(op)
        if op['records'][-1]['body']['phase']=='complete':return self._result(op,'backup_plan_complete')
        if op['records'][-1]['body']['phase']in('cancelled','rescued'):return self._result(op,'backup_plan_'+op['records'][-1]['body']['phase'])
        return self._result(op,'backup_plan_deadline_reached'if now>=uint(v['deadline_ns'],64)else'backup_plan_active')
    def step(self,operation_id,action):
        need(action in('prepare','resume'),'backup_plan_action_invalid')
        op=self._operation(operation_id);v,now=self._checked(op);phase=op['records'][-1]['body']['phase']
        if phase=='complete':return self._result(op,'backup_plan_complete')
        if phase in('cancelled','rescued'):return self._result(op,'backup_plan_'+phase)
        if now>=uint(v['deadline_ns'],64):return self._result(op,'backup_plan_deadline_reached')
        if action=='prepare'and phase=='consumer_stopped':
            try:
                # Read-only final check of the same stopped-source/checkpoint
                # contract required for starting the consumer after capture.
                dispatch_invariants(op,'start_consumer');self.backend.preflight('start_consumer',op)
            except ObservationUnavailable:return self._result(op,'backup_plan_waiting')
            return self._result(op,'backup_plan_capture_ready')
        route=(PREPARE if action=='prepare'else RESUME).get(phase)
        if route is None:return self._result(op,'backup_plan_phase_not_allowed')
        kind,command=route;head=op['records'][-1]['sha256']
        getattr(self.controller,kind)(operation_id,command,head)
        return self._result(self._operation(operation_id),'backup_plan_advanced')
    def run(self,operation_id,action,*,sleep=time.sleep):
        """Bounded observations; durable dispatch intents prevent effect retries."""
        while True:
            result=self.step(operation_id,action)
            if result['state']not in('backup_plan_advanced','backup_plan_waiting'):return result
            op=self._operation(operation_id);v,now=self._checked(op)
            remaining=uint(v['deadline_ns'],64)-now
            if remaining<=0:return self._result(op,'backup_plan_deadline_reached')
            sleep(min(uint(v['observation_interval_ns'],64),remaining)/1_000_000_000)
