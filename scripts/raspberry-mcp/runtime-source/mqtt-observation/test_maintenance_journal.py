import copy,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import maintenance_journal as m

H='a'*64;DOMAIN='b'*64;OP='c'*32
def facts(phase):
    out={k:('d'*64 if v=='h'else'1'if v.startswith('u')else False if v=='b'else 0 if v=='code'
            else'backup_snapshot'if v=='purpose'else'exited'if v=='state'else'verified_exited'if v=='identity'
            else'effect_uncertain')for k,v in m.FACTS[phase].items()}
    if phase=='begin':out.update(source_epoch='1',consumer_checkpoint_sequence='1',accepted_frames='3',unknown_epoch_tails='0')
    if phase=='armed':out['consumer_checkpoint_sequence']='2'
    if phase=='source_stopped':out['sender_pidfd_exited']=True
    if phase=='source_drained':out.update(source_closed=True,accepted_frames='5',acknowledged_frames='5',unknown_epoch_tails='0',consumer_checkpoint_sequence='3')
    if phase=='consumer_stopped':out['consumer_checkpoint_sequence']='4'
    if phase=='consumer_started':out['start_boundary_ns']='107'
    if phase=='consumer_ready':out.update(consumer_instance_sha256='e'*64,consumer_checkpoint_sequence='5',reader_observed_ns='109',source_closed=True)
    if phase=='source_started':out['start_boundary_ns']='110'
    if phase=='new_source_verified':out.update(source_epoch='2',source_instance_sha256='f'*64,started_ns='111',covered_before_ns='112',accepted_frames='6')
    if phase=='complete':out.update(source_epoch='2',source_instance_sha256='f'*64,acknowledged_frames='6',consumer_checkpoint_sequence='6')
    return out
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700);self.j=None
    def tearDown(self):
        if self.j:self.j.close()
        self.temp.cleanup()
    def open(self,approval=H,read_only=False):
        self.j=m.Journal(self.path,approval,uid=os.geteuid(),gid=os.getegid(),read_only=read_only);return self.j
    def append(self,phase,*,values=None,at=None,domain=DOMAIN,parent='current'):
        status=self.j.status();op=next((o for o in(status or{'body':{'operations':[]}})['body']['operations']if o['operation_id']==OP),None)
        if parent=='current':parent=op['records'][-1]['sha256']if op else None
        return self.j.append(OP,phase,values if values is not None else facts(phase),at_ns=str(at if at is not None else 100+m.PHASES.index(phase)),clock_domain_sha256=domain,expected_previous_sha256=parent)
    def complete(self):
        for phase in m.PHASES:self.append(phase)
        return self.j.status()['body']['operations'][0]
    def test_complete_facts_bind_clock_source_ACK_and_new_consumer_without_any_effect(self):
        self.open();op=self.complete();result=m.correlation_facts(op)
        self.assertTrue(all(result['comparisons'].values()),result)
        self.assertFalse(result['effect_executed']);self.assertFalse(result['automatic_retry']);self.assertFalse(result['full24h_proven'])
        self.assertEqual((self.path/'maintenance.json').stat().st_mode&0o777,0o600)
    def test_exact_duplicate_after_reopen_is_idempotent(self):
        self.open();first=self.append('begin');before=(self.path/'maintenance.json').read_bytes();self.j.close();self.open()
        again=self.append('begin',parent=None)
        self.assertEqual(again['state'],'duplicate');self.assertEqual(first['receipt'],again['receipt'])
        self.assertEqual((self.path/'maintenance.json').read_bytes(),before)
    def test_parent_conflict_does_not_overwrite_or_repair(self):
        self.open();self.append('begin');before=self.j.status()
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'parent_changed'):self.append('armed',parent='0'*64)
        self.assertEqual(self.j.status(),before)
    def test_out_of_order_or_conflicting_observation_preserves_history(self):
        self.open();self.append('begin');before=self.j.status()
        with self.assertRaises(m.MaintenanceUnavailable):self.append('source_stopped')
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'record_conflict'):self.append('begin',at=101,parent=None)
        self.assertEqual(self.j.status(),before)
    def test_grant_rotation_preserves_old_receipts_and_cannot_continue_old_operation(self):
        self.open();self.append('begin');before=self.j.status();self.j.close();self.open('e'*64)
        self.assertEqual(self.j.status(),before)
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'approval_changed'):self.append('armed')
    def test_failed_clock_domain_change_is_terminal_and_truthful(self):
        self.open();self.append('begin')
        with self.assertRaises(m.MaintenanceUnavailable):self.append('armed',domain='f'*64)
        self.append('failed',values={'reason':'clock_changed'},at=1,domain='f'*64)
        value=self.j.status();self.assertEqual(m.correlation_facts(value['body']['operations'][0])['phase'],'failed')
        with self.assertRaises(m.MaintenanceUnavailable):self.append('armed')
        self.assertEqual(self.j.status(),value)
    def test_pre_effect_intent_survives_uncertain_return_without_retrying_effect(self):
        self.open();self.append('begin');self.append('armed');original=self.j.tx._atomic
        def crash(*args):original(*args);raise OSError('synthetic_after_fsync')
        with patch.object(self.j.tx,'_atomic',side_effect=crash):
            with self.assertRaisesRegex(m.MaintenanceUnavailable,'write_uncertain'):self.append('source_stop_intent')
        self.j.close();self.open();op=self.j.status()['body']['operations'][0]
        self.assertEqual(op['records'][-1]['body']['phase'],'source_stop_intent')
        duplicate=self.append('source_stop_intent');self.assertEqual(duplicate['state'],'duplicate');self.assertFalse(duplicate['effect_executed'])
    def test_bad_facts_have_no_free_text_payloads_or_unknown_fields(self):
        self.open()
        for mutate in [lambda x:x.update(payload='PRIVATE_CANARY'),lambda x:x.update(source_epoch='-1'),
                       lambda x:x.update(purpose='PRIVATE_CANARY'),lambda x:x.update(accepted_frames=True)]:
            value=facts('begin');mutate(value)
            with self.assertRaises(m.MaintenanceUnavailable):self.append('begin',values=value)
        self.assertIsNone(self.j.status())
    def test_capacity_never_discards_old_operations(self):
        self.open()
        for i in range(m.MAX_OPERATIONS):
            self.j.append(f'{i:032x}','begin',facts('begin'),at_ns='100',clock_domain_sha256=DOMAIN,expected_previous_sha256=None)
        before=self.j.status()
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'capacity_reached'):self.append('begin')
        self.assertEqual(self.j.status(),before)
    def test_tamper_and_noncanonical_snapshot_never_bootstrap_over_history(self):
        self.open();self.append('begin');p=self.path/'maintenance.json';raw=p.read_bytes();p.write_bytes(raw+b' ')
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'snapshot_invalid'):self.j.status()
        self.assertEqual(p.read_bytes(),raw+b' ')
    def test_read_only_requires_existing_lock_and_cannot_append(self):
        self.open();self.append('begin');before=self.j.status();self.j.close();self.open(read_only=True)
        self.assertEqual(self.j.status(),before)
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'read_only'):self.append('armed')
    def test_completed_operation_is_immutable(self):
        self.open();self.complete();before=self.j.status()
        with self.assertRaises(m.MaintenanceUnavailable):self.append('failed',values={'reason':'effect_uncertain'},at=200)
        self.assertEqual(self.j.status(),before)
    def test_broken_source_readiness_binding_or_cut_is_visible_in_comparison_facts(self):
        self.open();op=self.complete()
        cases=[('source_drained','source_closed',False,'old_source_closed'),
               ('source_drained','acknowledged_frames','4','old_tail_ACKed'),
               ('consumer_ready','consumer_instance_sha256','d'*64,'consumer_observation_fresh'),
               ('consumer_ready','reader_observed_ns','106','consumer_observation_fresh'),
               ('consumer_ready','protocol_counts_sha256','0'*64,'protocol_preserved_during_consumer_stop'),
               ('new_source_verified','started_ns','100','source_started_after_ready'),
               ('new_source_verified','source_epoch','3','exact_next_source_epoch'),
               ('complete','acknowledged_frames','5','new_source_cut_ACKed')]
        for phase,key,value,comparison in cases:
            broken=copy.deepcopy(op);parent=None
            for row in broken['records']:
                if row['body']['phase']==phase:row['body']['facts'][key]=value
                row['body']['previous_sha256']=parent;row['sha256']=m.digest(row['body']);parent=row['sha256']
            with self.subTest(phase=phase,key=key):self.assertFalse(m.correlation_facts(broken)['comparisons'][comparison])
if __name__=='__main__':unittest.main()
