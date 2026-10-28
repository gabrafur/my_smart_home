"""Terminal metadata frames preserve legacy accounting and historical faults."""
import copy,json,tempfile,unittest
from pathlib import Path
from handoff import source_counts
from handoff_ledger import HandoffLedger
from protocol import Invalid,validate_state
from test_protocol import frame,event,project

def modern(*args,final=False,**kwargs):return frame(*args,v=2,final=final,**kwargs)
def legacy(state):
    value=copy.deepcopy(state);value['version']=2
    del value['source_closed'];del value['last_source_wire_version']
    validate_state(value);return value

class ClosureTests(unittest.TestCase):
    def test_final_preserves_all_counts_and_does_not_claim_full24h(self):
        first=project(modern(1,1,[event()]))['state']
        result=project(modern(2,2,[event(2)],final=True),first)
        self.assertEqual(result['status'],'accepted');state=result['state']
        self.assertTrue(state['source_closed']);self.assertEqual(state['last_source_wire_version'],2)
        self.assertEqual(state['stats']['publish_in']['observed'],2)
        self.assertFalse(state['full24h_proven']);self.assertFalse(result['full_goal_proven'])

    def test_exact_duplicate_terminal_is_idempotent(self):
        value=modern(final=True);state=project(value)['state']
        duplicate=project(value,state,now=500)
        self.assertEqual(duplicate['status'],'duplicate');self.assertEqual(duplicate['state'],state)

    def test_new_frame_after_terminal_cannot_reopen_same_instance(self):
        state=project(modern(final=True))['state']
        for value in [modern(2),modern(2,final=True),frame(2)]:
            result=project(value,state,now=500)
            self.assertEqual(result['reason'],'source_already_closed');self.assertEqual(result['state'],state)

    def test_wire_downgrade_is_rejected_before_closure(self):
        state=project(modern())['state'];result=project(frame(2),state)
        self.assertEqual(result['reason'],'source_wire_downgrade');self.assertEqual(result['state'],state)

    def test_closed_source_transition_preserves_totals_without_inventing_unknown_tail(self):
        a=project(modern(1,1,[event()],final=True))['state']
        b=project(modern(instance='b'*32),a,now=400)['state']
        self.assertEqual(b['epoch'],2);self.assertEqual(b['unknown_epoch_tails'],0)
        self.assertFalse(b['previous_epoch_tail_unknown']);self.assertFalse(b['previous_epoch_summary']['tail_unknown'])
        self.assertFalse(b['source_closed']);self.assertEqual(b['past_stats']['publish_in']['observed'],1)

    def test_legacy_unclosed_transition_remains_unknown(self):
        a=legacy(project(frame())['state'])
        b=project(modern(instance='b'*32),a,now=400)['state']
        self.assertEqual(b['unknown_epoch_tails'],1);self.assertTrue(b['previous_epoch_tail_unknown'])

    def test_legacy_history_and_errors_survive_migration_then_clean_closure(self):
        a=project(frame(1,1,[event()],clock_faults='3',send_failures='7'))['state']
        b=legacy(project(frame(instance='b'*32),a,now=400)['state'])
        closed=project(modern(2,final=True,instance='b'*32),b,now=500)['state']
        c=project(modern(instance='c'*32),closed,now=600)['state']
        self.assertEqual(c['version'],3);self.assertEqual(c['epoch'],3)
        self.assertEqual(c['unknown_epoch_tails'],1);self.assertFalse(c['previous_epoch_tail_unknown'])
        self.assertEqual(c['past_clock_faults'],3);self.assertEqual(c['past_send_failures'],7)
        self.assertEqual(c['past_stats']['publish_in']['observed'],1)

    def test_new_legacy_instance_after_closed_modern_source_is_allowed_but_not_closed(self):
        a=project(modern(final=True))['state']
        b=project(frame(instance='b'*32),a,now=400)['state']
        self.assertEqual(b['unknown_epoch_tails'],0);self.assertFalse(b['source_closed'])
        c=project(modern(instance='c'*32),b,now=500)['state']
        self.assertEqual(c['unknown_epoch_tails'],1);self.assertTrue(c['previous_epoch_tail_unknown'])

    def test_final_has_exact_version_and_boolean_contract(self):
        bad=[frame(final=True),modern(final=1),modern(final='true'),modern(final=None),modern(final=[])]
        missing=modern();del missing['final'];bad.append(missing)
        for value in bad:
            with self.subTest(value=value):self.assertEqual(project(value)['status'],'unknown')

    def test_json_terminal_cannot_replace_out_of_band_attestation(self):
        a=project(modern())['state'];result=project(modern(2,final=True),a,binding=False)
        self.assertEqual(result['reason'],'source_binding_unverified');self.assertEqual(result['state'],a)

    def test_corrupt_closure_history_is_rejected(self):
        first=project(modern(final=True))['state']
        second=project(modern(instance='b'*32),first,now=400)['state']
        mutations=[(first,'source_closed',1),(first,'last_source_wire_version',1),
            (first,'unknown_epoch_tails',1),(first,'previous_epoch_tail_unknown',True),
            (second,'unknown_epoch_tails',1),(second,'previous_epoch_tail_unknown',True)]
        for original,key,value in mutations:
            bad=copy.deepcopy(original);bad[key]=value
            with self.subTest(key=key,value=value):
                with self.assertRaises(Invalid):validate_state(bad)

    def test_legacy_sqlite_reopen_migration_and_handoff_conserve_lifetime_evidence(self):
        with tempfile.TemporaryDirectory(prefix='mqtt-closure-')as root:
            path=Path(root)/'ledger.sqlite3'
            ledger=HandoffLedger(path,create=True,clock_domain_id='d'*64,started_ns=100)
            try:
                def send(value,at):
                    self.assertEqual(ledger.frame(json.dumps(value).encode(),at,source_binding_verified=True)['status'],'accepted')
                send(frame(1,1,[event()],clock_faults='2',send_failures='3'),300)
                send(frame(instance='b'*32),400)
                snapshot=copy.deepcopy(ledger.body);snapshot['state']=legacy(snapshot['state']);ledger._commit(snapshot)
                before=source_counts(ledger.body);ledger.close()
                ledger=HandoffLedger(path,clock_domain_id='d'*64,started_ns=450)
                send(modern(2,final=True,instance='b'*32),500)
                send(modern(instance='c'*32),600)
                after=source_counts(ledger.body)
                self.assertEqual(after['unknown_epoch_tails'],before['unknown_epoch_tails'])
                self.assertEqual(after['stats'],before['stats'])
                self.assertEqual(after['source_clock_faults'],2);self.assertEqual(after['source_send_failures'],3)
                self.assertEqual(after['source_epochs'],3);self.assertEqual(after['frames'],4)
                self.assertEqual(ledger.body['faults']['reader_restart'],1)
                self.assertEqual(ledger.body['handoff']['active']['counts']['unknown_epoch_tails'],1)
                ledger.close();ledger=HandoffLedger(path,clock_domain_id='d'*64,started_ns=700)
                self.assertEqual(ledger.body['state']['version'],3)
                self.assertEqual(ledger.body['state']['unknown_epoch_tails'],1)
            finally:ledger.close()

if __name__=='__main__':unittest.main()
