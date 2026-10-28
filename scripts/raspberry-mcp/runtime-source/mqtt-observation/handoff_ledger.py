"""Atomic extension of the source ledger with a bounded durable consumer handoff."""
import copy
import handoff
from receiver_ledger import Ledger,validate as validate_base,fail,stringify

class HandoffLedger(Ledger):
    def __init__(self,path,*,create=False,clock_domain_id,started_ns,start_session=True):
        self.operation_ns=started_ns
        super().__init__(path,create=create,clock_domain_id=clock_domain_id,started_ns=started_ns,start_session=start_session)
    def _initial_body(self,domain):
        body=super()._initial_body(domain);body['handoff']=handoff.initial(domain);return body
    @staticmethod
    def _base(body):
        return {k:v for k,v in body.items()if k!='handoff'}
    def _validate(self,body):
        if type(body)is not dict or 'handoff'not in body:fail('handoff_state_invalid')
        validate_base(self._base(body));handoff.validate(body['handoff'],body)
    def _prepare(self,candidate):
        validate_base(self._base(candidate))
        handoff.observe(candidate['handoff'],self.body,candidate,self.operation_ns)
        return candidate
    def _now(self,at):
        if not handoff.ns(at):fail('reader_clock_invalid')
        if self.failed or self.body is None:fail('ledger_not_writable')
        self.operation_ns=at
    def frame(self,packet,arrived_ns,*,source_binding_verified):
        self._now(arrived_ns)
        return super().frame(packet,arrived_ns,source_binding_verified=source_binding_verified)
    def record_fault(self,kind,arrived_ns):
        self._now(arrived_ns);return super().record_fault(kind,arrived_ns)
    def publish(self,at_ns):
        self._now(at_ns);body=copy.deepcopy(self.body)
        packet,changed=handoff.freeze(body['handoff'],at_ns,body['clock_domain_id'])
        if changed:self._commit(body)
        return packet
    def acknowledge(self,ack,at_ns):
        self._now(at_ns);body=copy.deepcopy(self.body)
        status,changed=handoff.acknowledge(body['handoff'],ack,at_ns,body['clock_domain_id'])
        if changed:self._commit(body)
        return {'status':status,'receipt':stringify(copy.deepcopy(self.body['handoff']['last_ack']))
                if status in ('accepted','duplicate')else None,'full24h_proven':False}
