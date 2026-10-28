import copy,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import maintenance_journal as j
import maintenance_controller as m
from test_maintenance_journal import facts,H,DOMAIN,OP

class Backend:
    def __init__(self,journal):
        self.journal=journal;self.now=100;self.domain=DOMAIN;self.effects=[];self.permitted=True
        self.error=None;self.waiting=set();self.boundary_reject=False
    def clock(self):
        n=self.now;self.now+=1;return str(n),self.domain
    def authorize(self,op,*,mutation):
        if mutation and not self.permitted:raise j.MaintenanceUnavailable('maintenance_authorization_closed')
    def facts(self,phase,op,*,purpose=None):
        if phase in self.waiting:raise m.ObservationUnavailable()
        for command,(_,_,after)in m.COMMANDS.items():
            if phase==after and command not in self.effects:raise m.ObservationUnavailable()
        return facts(phase)
    def preflight(self,command,op):return facts(m.COMMANDS[command][1])
    def execute(self,command,intent):
        # Actual dispatch is impossible before the corresponding disk intent.
        op=self.journal.status()['body']['operations'][0]
        assert op['records'][-1]==intent
        if self.boundary_reject:raise m.BoundaryRejected()
        if self.error=='before':raise TimeoutError()
        self.effects.append(command)
        if self.error=='after':raise TimeoutError()

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700)
        self.j=j.Journal(self.path,H,uid=os.geteuid(),gid=os.getegid());self.b=Backend(self.j);self.c=m.Controller(self.j,self.b)
    def tearDown(self):self.j.close();self.temp.cleanup()
    def op(self):return self.j.status()['body']['operations'][0]
    def head(self):return self.op()['records'][-1]['sha256']
    def observe(self,phase):return self.c.observe(OP,phase,None if phase=='begin'else self.head(),purpose='backup_snapshot'if phase=='begin'else None)
    def dispatch(self,command):return self.c.dispatch(OP,command,self.head())
    def arm(self):self.observe('begin');self.observe('armed')
    def complete(self):
        self.arm();self.dispatch('stop_source');self.observe('source_drained');self.dispatch('stop_consumer')
        self.dispatch('start_consumer');self.observe('consumer_ready');self.dispatch('start_source')
        self.observe('new_source_verified');return self.observe('complete')
    def test_full_sequence_has_durable_intents_before_exactly_four_effects(self):
        result=self.complete();self.assertEqual(self.b.effects,list(m.COMMANDS));self.assertTrue(all(result['comparisons'].values()))
        self.assertFalse(result['full24h_proven']);self.assertFalse(result['automatic_retry'])
    def test_duplicate_completed_requests_never_call_backend_or_change_history(self):
        self.complete();before=self.j.status();effects=list(self.b.effects)
        for command in m.COMMANDS:
            self.assertEqual(self.c.dispatch(OP,command,'0'*64)['state'],'already_recorded')
        self.assertEqual(self.j.status(),before);self.assertEqual(self.b.effects,effects)
    def test_timeout_after_effect_is_reconciled_from_observation_without_repeat(self):
        self.arm();self.b.error='after';parent=self.head();r=self.c.dispatch(OP,'stop_source',parent)
        self.assertEqual(r['state'],'execution_result_unknown');self.assertEqual(self.b.effects,['stop_source'])
        self.b.error=None;r=self.c.dispatch(OP,'stop_source',parent)
        self.assertEqual(r['phase'],'source_stopped');self.assertFalse(r['dispatched']);self.assertEqual(self.b.effects,['stop_source'])
    def test_timeout_before_dispatch_never_reissues_even_when_source_stays_running(self):
        self.arm();self.b.error='before';parent=self.head();self.c.dispatch(OP,'stop_source',parent);self.b.error=None
        for _ in range(3):self.assertEqual(self.c.dispatch(OP,'stop_source',parent)['state'],'awaiting_observation')
        self.assertEqual(self.b.effects,[]);self.assertEqual(self.op()['records'][-1]['body']['phase'],'source_stop_intent')
    def test_crash_after_intent_fsync_does_not_dispatch_or_retry(self):
        self.arm();original=self.j.tx._atomic;parent=self.head()
        def crash(*args):original(*args);raise OSError('synthetic_after_fsync')
        with patch.object(self.j.tx,'_atomic',side_effect=crash):
            with self.assertRaisesRegex(j.MaintenanceUnavailable,'write_uncertain'):self.c.dispatch(OP,'stop_source',parent)
        self.j.close();self.j=j.Journal(self.path,H,uid=os.geteuid(),gid=os.getegid());self.c=m.Controller(self.j,self.b)
        self.assertEqual(self.c.dispatch(OP,'stop_source',parent)['state'],'awaiting_observation');self.assertEqual(self.b.effects,[])
    def test_new_operation_id_cannot_bypass_unknown_prior_effect(self):
        self.arm();self.b.error='before';self.dispatch('stop_source')
        with self.assertRaisesRegex(j.MaintenanceUnavailable,'prior_operation_unresolved'):
            self.c.observe('d'*32,'begin',None,purpose='backup_snapshot')
        self.assertEqual(self.b.effects,[])
    def test_none_or_foreign_parent_never_acts(self):
        self.arm()
        for parent in [None,'0'*64]:
            with self.assertRaisesRegex(j.MaintenanceUnavailable,'parent_changed'):self.c.dispatch(OP,'stop_source',parent)
        self.assertEqual(self.b.effects,[])
    def test_boundary_drift_keeps_intent_without_claiming_dispatch(self):
        self.arm();self.b.boundary_reject=True;r=self.dispatch('stop_source')
        self.assertEqual(r['state'],'effect_boundary_rejected');self.assertFalse(r['dispatched']);self.assertEqual(self.b.effects,[])
        self.assertEqual(self.dispatch('stop_source')['state'],'awaiting_observation')
    def test_closed_authority_does_not_create_intent_or_call_effect(self):
        self.arm();old=self.j.status();self.b.permitted=False
        with self.assertRaisesRegex(j.MaintenanceUnavailable,'authorization_closed'):self.dispatch('stop_source')
        self.assertEqual(self.j.status(),old);self.assertEqual(self.b.effects,[])
    def test_waiting_for_fresh_preflight_does_not_consume_an_intent(self):
        self.arm();old=self.j.status()
        with patch.object(self.b,'preflight',side_effect=m.ObservationUnavailable):
            self.assertEqual(self.dispatch('stop_source')['state'],'awaiting_preflight')
        self.assertEqual(self.j.status(),old)
    def test_bad_drain_observation_cannot_authorize_consumer_stop(self):
        self.arm();self.dispatch('stop_source');value=facts('source_drained');value['acknowledged_frames']='4'
        with patch.object(self.b,'facts',return_value=value):self.observe('source_drained')
        with self.assertRaisesRegex(j.MaintenanceUnavailable,'source_not_drained'):self.dispatch('stop_consumer')
        self.assertEqual(self.b.effects,['stop_source'])
    def test_changed_domain_blocks_before_dispatch_without_rewriting_evidence(self):
        self.arm();old=self.j.status();self.b.domain='f'*64
        with self.assertRaisesRegex(j.MaintenanceUnavailable,'clock_changed'):self.dispatch('stop_source')
        self.assertEqual(self.j.status(),old);self.assertEqual(self.b.effects,[])
    def test_commands_and_phase_order_are_closed(self):
        self.arm()
        for command in ['restart_host','stop_consumer','start_source']:
            with self.assertRaises(j.MaintenanceUnavailable):self.dispatch(command)
        self.assertEqual(self.b.effects,[])
if __name__=='__main__':unittest.main()
