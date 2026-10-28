"""Single-flight maintenance dispatch over a separately approved fixed backend.

No CLI or schedule. The installed entrypoint must supply the sealed backend;
callers supply only operation/phase/head, never paths, containers or facts.
Operational decisions and retries belong to the canonical Node-RED canvas.
"""
import copy
from maintenance_journal import MaintenanceUnavailable,validate_operation,correlation_facts,hex64,uint

COMMANDS={
 'stop_source':('armed','source_stop_intent','source_stopped'),
 'stop_consumer':('source_drained','consumer_stop_intent','consumer_stopped'),
 'start_consumer':('consumer_stopped','consumer_start_intent','consumer_started'),
 'start_source':('consumer_ready','source_start_intent','source_started'),
}
OBSERVATIONS={'begin','armed','source_drained','consumer_ready','new_source_verified','complete'}
class ObservationUnavailable(RuntimeError):pass
class BoundaryRejected(RuntimeError):pass
def need(ok,code):
    if not ok:raise MaintenanceUnavailable(code)
def records(op):return {r['body']['phase']:r for r in op['records']}
def facts(op,phase):return records(op)[phase]['body']['facts']

def dispatch_invariants(op,command):
    """Causal/accounting safety checks; no freshness or latency thresholds."""
    b=facts(op,'begin');a=facts(op,'armed')
    need(a['window_id_sha256']==b['window_id_sha256']and
         uint(a['consumer_checkpoint_sequence'],64)>uint(b['consumer_checkpoint_sequence'],64),'maintenance_window_unconfirmed')
    if command=='stop_source':return
    s=facts(op,'source_stopped');d=facts(op,'source_drained')
    need(s['binding_sha256']==b['source_binding_sha256']==facts(op,'source_stop_intent')['binding_sha256']
      and s['container_state']=='exited'and s['exit_code']==0 and s['sender_pidfd_exited']
      and s['source_epoch']==d['source_epoch']==b['source_epoch']
      and s['source_instance_sha256']==d['source_instance_sha256']==b['source_instance_sha256']
      and d['source_closed']and not d['pending_packet']and not d['active_counts_nonempty']
      and d['accepted_frames']==d['acknowledged_frames']
      and uint(d['accepted_frames'],128)>=uint(b['accepted_frames'],128)
      and d['unknown_epoch_tails']==b['unknown_epoch_tails']
      and d['reader_instance_sha256']==b['reader_instance_sha256'],'maintenance_source_not_drained')
    if command=='stop_consumer':return
    c=facts(op,'consumer_stopped')
    need(c['container_state']=='exited'and c['exit_code']==0
      and c['binding_sha256']==b['consumer_binding_sha256']==facts(op,'consumer_stop_intent')['binding_sha256']
      and uint(c['consumer_checkpoint_sequence'],64)>=uint(d['consumer_checkpoint_sequence'],64),'maintenance_consumer_not_stopped')
    if command=='start_consumer':return
    r=facts(op,'consumer_ready');started=facts(op,'consumer_started');rows=records(op)
    boundary=rows['consumer_start_intent']['body']['at_ns']
    need(started['start_boundary_ns']==boundary
      and started['binding_sha256']==r['binding_sha256']==facts(op,'consumer_start_intent')['binding_sha256']
      and r['consumer_instance_sha256']!=b['consumer_instance_sha256']
      and r['reader_instance_sha256']==b['reader_instance_sha256']
      and uint(boundary,64)<=uint(r['reader_observed_ns'],64)<=uint(rows['consumer_ready']['body']['at_ns'],64)
      and uint(r['consumer_checkpoint_sequence'],64)>uint(c['consumer_checkpoint_sequence'],64)
      and r['old_source_epoch']==b['source_epoch']and r['old_source_instance_sha256']==b['source_instance_sha256']
      and r['source_closed']and r['source_identity']=='verified_exited'
      and r['protocol_counts_sha256']==d['protocol_counts_sha256'],'maintenance_consumer_not_ready')

class Controller:
    def __init__(self,journal,backend):
        self.journal=journal;self.backend=backend
    def _operation(self,operation_id):
        value=self.journal.status()
        op=next((v for v in(value['body']['operations']if value else[])if v['operation_id']==operation_id),None)
        if op is not None:validate_operation(op)
        return op
    def _clock(self,op):
        now,domain=self.backend.clock();uint(now,64);need(hex64(domain),'maintenance_clock_unknown')
        if op is not None:
            need(domain==op['records'][0]['body']['clock_domain_sha256'],'maintenance_clock_changed')
            need(uint(now,64)>=uint(op['records'][-1]['body']['at_ns'],64),'maintenance_clock_reversed')
        return now,domain
    def _append(self,operation_id,phase,value,op,*,clock=None):
        now,domain=clock or self._clock(op)
        return self.journal.append(operation_id,phase,value,at_ns=now,clock_domain_sha256=domain,
          expected_previous_sha256=op['records'][-1]['sha256']if op else None)
    def _result(self,op,state,*,dispatched=False):
        value=correlation_facts(op)
        return {**value,'state':state,'dispatched':dispatched,'automatic_retry':False}
    def observe(self,operation_id,phase,expected_head,*,purpose=None):
        need(phase in OBSERVATIONS,'maintenance_observation_invalid');op=self._operation(operation_id)
        if op is None:
            need(phase=='begin'and expected_head is None,'maintenance_parent_changed')
            state=self.journal.status()
            # No new ID can sidestep an unresolved effect or failed recovery.
            need(not state or all(x['records'][-1]['body']['phase']in('complete','cancelled','rescued')
                 for x in state['body']['operations']),'maintenance_prior_operation_unresolved')
            need(purpose in('backup_snapshot','container_update','integration_update'),'maintenance_purpose_invalid')
        else:
            need(purpose is None,'maintenance_purpose_invalid')
            if phase in records(op):return self._result(op,'already_recorded')
            need(op['records'][-1]['sha256']==expected_head,'maintenance_parent_changed')
        self.backend.authorize(op,mutation=False)
        try:value=self.backend.facts(phase,copy.deepcopy(op),purpose=purpose)
        except ObservationUnavailable:return {'state':'observation_unavailable','dispatched':False,'automatic_retry':False}
        self._append(operation_id,phase,value,op)
        return self._result(self._operation(operation_id),'observed')
    def dispatch(self,operation_id,command,expected_head):
        need(command in COMMANDS,'maintenance_command_invalid');op=self._operation(operation_id)
        need(op is not None,'maintenance_operation_missing');before,intent,after=COMMANDS[command];rows=records(op)
        if after in rows:return self._result(op,'already_recorded')
        need(op['records'][-1]['body']['phase']in(before,intent),'maintenance_phase_changed')
        parents=(op['records'][-1]['sha256'],rows[intent]['body']['previous_sha256'])if intent in rows else(op['records'][-1]['sha256'],)
        need(expected_head in parents,
             'maintenance_parent_changed')
        dispatch_invariants(op,command)
        self.backend.authorize(op,mutation=intent not in rows)
        dispatched=False
        if intent not in rows:
            try:value=self.backend.preflight(command,copy.deepcopy(op))
            except ObservationUnavailable:return self._result(op,'awaiting_preflight',dispatched=False)
            # Unknown durability after this write means NO dispatch, even if
            # the append may actually have reached disk. Reconcile that intent.
            self._append(operation_id,intent,value,op)
            op=self._operation(operation_id);rows=records(op)
            try:
                # The backend must compare its just-observed fixed target with
                # this durable intent again at the final side-effect boundary.
                self.backend.execute(command,copy.deepcopy(rows[intent]))
                dispatched=True
            except BoundaryRejected:
                return self._result(op,'effect_boundary_rejected',dispatched=False)
            except Exception:
                return self._result(op,'execution_result_unknown',dispatched=True)
        try:value=self.backend.facts(after,copy.deepcopy(op))
        except ObservationUnavailable:
            return self._result(op,'awaiting_observation',dispatched=dispatched)
        self._append(operation_id,after,value,op)
        return self._result(self._operation(operation_id),'observed',dispatched=dispatched)
    def rebind(self,operation_id,expected_head):
        op=self._operation(operation_id)
        need(op is not None and op['records'][-1]['sha256']==expected_head,'maintenance_parent_changed')
        need(op['records'][-1]['body']['phase']=='consumer_ready','maintenance_phase_changed')
        dispatch_invariants(op,'start_source')
        try:return self.backend.rebind(self.journal.tx,copy.deepcopy(op))
        except ObservationUnavailable:return self._result(op,'awaiting_rebind_observation')
    def prepare_replacement(self,operation_id,expected_head):
        op=self._operation(operation_id)
        need(op is not None and op['records'][-1]['sha256']==expected_head,'maintenance_parent_changed')
        need(op['records'][-1]['body']['phase']=='consumer_ready','maintenance_phase_changed')
        dispatch_invariants(op,'start_source')
        try:return self.backend.prepare_replacement(self.journal.tx,copy.deepcopy(op))
        except ObservationUnavailable:return self._result(op,'awaiting_replacement_observation')
    def audit_replacement(self,operation_id,expected_head):
        op=self._operation(operation_id)
        need(op is not None and op['records'][-1]['sha256']==expected_head,'maintenance_parent_changed')
        need(op['records'][-1]['body']['phase']=='consumer_ready','maintenance_phase_changed')
        dispatch_invariants(op,'start_source')
        try:return self.backend.audit_replacement(self.journal.tx,copy.deepcopy(op))
        except ObservationUnavailable:return self._result(op,'awaiting_audit_observation')
