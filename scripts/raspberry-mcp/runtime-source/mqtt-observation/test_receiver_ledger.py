import copy,hashlib,json,os,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
from receiver_ledger import Ledger,LedgerUnavailable
from test_protocol import frame,event

def wire(value):return json.dumps(value,separators=(',',':')).encode('ascii')
DOMAIN='d'*64

class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mqtt-ledger-test-')
        self.root=Path(self.tmp.name);self.path=self.root/'metadata.sqlite3';self.handles=[]
    def tearDown(self):
        for handle in self.handles:handle.close()
        self.tmp.cleanup()
    def open(self,**kw):
        obj=Ledger(self.path,clock_domain_id=kw.pop('clock_domain_id',DOMAIN),started_ns=kw.pop('started_ns',250),**kw)
        self.handles.append(obj);return obj
    def baseline(self):
        obj=self.open(create=True);self.assertEqual(obj.frame(wire(frame()),300,source_binding_verified=True)['status'],'accepted');return obj

    def test_restart_keeps_accepted_state_and_latches_unknown_tail(self):
        obj=self.baseline();before=copy.deepcopy(obj.body);obj.close()
        other=self.open(started_ns=400)
        self.assertEqual(other.body['state'],before['state'])
        self.assertEqual(other.body['accepted_frames'],1)
        self.assertEqual(other.body['reader_sessions'],2)
        self.assertEqual(other.body['faults']['reader_restart'],1)
        self.assertFalse(other.report()['full24h_proven'])

    def test_invalid_frame_and_unverified_peer_are_durable_without_raw_data(self):
        obj=self.baseline();old=copy.deepcopy(obj.body['state'])
        secret='PRIVATE_PAYLOAD_CANARY_not_metadata'
        obj.frame(secret.encode(),350,source_binding_verified=True)
        data=frame();data['private']=secret
        obj.frame(wire(data),360,source_binding_verified=True)
        obj.frame(secret.encode(),370,source_binding_verified=False)
        self.assertEqual(obj.body['state'],old)
        self.assertEqual(obj.body['faults']['source_frame_rejected'],2)
        self.assertEqual(obj.body['faults']['source_binding_unverified'],1)
        obj.close();obj=self.open(started_ns=400)
        self.assertEqual(obj.body['faults']['source_frame_rejected'],2)
        for path in self.root.iterdir():
            if path.is_file():self.assertNotIn(secret.encode(),path.read_bytes())

    def test_duplicate_is_idempotent_and_counted_without_source_counter_reset(self):
        obj=self.baseline();state=copy.deepcopy(obj.body['state'])
        result=obj.frame(wire(frame()),400,source_binding_verified=True)
        self.assertEqual(result['status'],'duplicate');self.assertEqual(obj.body['state'],state)
        self.assertEqual(obj.body['accepted_frames'],1);self.assertEqual(obj.body['duplicate_frames'],1)

    def test_transport_rejections_survive_reopen(self):
        obj=self.baseline()
        for fault in ['transport_truncated','transport_ancillary_invalid','source_identity_lost']:
            obj.record_fault(fault,400)
        obj.close();obj=self.open(started_ns=500)
        for fault in ['transport_truncated','transport_ancillary_invalid','source_identity_lost']:
            self.assertEqual(obj.body['faults'][fault],1)

    def test_new_clock_domain_preserves_state_and_latches_discontinuity(self):
        obj=self.baseline();state=copy.deepcopy(obj.body['state']);obj.close()
        obj=self.open(clock_domain_id='e'*64,started_ns=10)
        self.assertEqual(obj.body['state'],state)
        self.assertEqual(obj.body['faults']['clock_domain_changed'],1)
        self.assertEqual(obj.body['faults']['reader_restart'],1)

    def test_new_source_generation_keeps_old_counts_and_unknown_epoch_tail(self):
        obj=self.open(create=True)
        self.assertEqual(obj.frame(wire(frame(1,1,[event()])),300,source_binding_verified=True)['status'],'accepted')
        new=frame();new['instance']='b'*32
        self.assertEqual(obj.frame(wire(new),400,source_binding_verified=True)['status'],'accepted')
        self.assertEqual(obj.body['state']['past_stats']['publish_in']['expected'],1)
        self.assertEqual(obj.body['state']['unknown_epoch_tails'],1)

    def test_failed_commit_never_acknowledges_or_advances_memory(self):
        obj=self.baseline();before=copy.deepcopy(obj.body)
        obj.db.execute('PRAGMA query_only=ON')
        with self.assertRaisesRegex(LedgerUnavailable,'^metadata_commit_failed$'):
            obj.frame(wire(frame(2,1,[event()])),400,source_binding_verified=True)
        self.assertEqual(obj.body,before)
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_not_readable$'):obj.report()
        obj.close();obj=self.open(started_ns=500)
        self.assertEqual(obj.body['accepted_frames'],1)
        self.assertEqual(obj.body['faults']['reader_restart'],1)

    def test_committed_state_survives_process_exit_without_close(self):
        obj=self.baseline();obj.close()
        code="""import sys,os
sys.path.insert(0,sys.argv[1])
from receiver_ledger import Ledger
from test_protocol import frame,event
import json
obj=Ledger(sys.argv[2],clock_domain_id='d'*64,started_ns=400)
assert obj.frame(json.dumps(frame(2,1,[event()])).encode(),500,source_binding_verified=True)['status']=='accepted'
os._exit(0)
"""
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(Path(__file__).parent),str(self.path)],capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        obj=self.open(started_ns=600)
        self.assertEqual(obj.body['accepted_frames'],2)
        self.assertEqual(obj.body['state']['stats']['publish_in']['expected'],1)
        self.assertEqual(obj.body['faults']['reader_restart'],2)

    def test_corruption_is_not_recreated_and_error_contains_no_private_body(self):
        obj=self.baseline();obj.close()
        db=sqlite3.connect(self.path)
        db.execute('UPDATE snapshot SET body=? WHERE id=1',('PRIVATE_SENTINEL',));db.commit();db.close()
        before=self.path.stat().st_size
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_state_invalid$'):self.open()
        self.assertEqual(self.path.stat().st_size,before)
        db=sqlite3.connect(self.path);self.assertEqual(db.execute('SELECT body FROM snapshot').fetchone()[0],'PRIVATE_SENTINEL');db.close()

    def test_rehashed_but_structurally_invalid_state_is_closed(self):
        obj=self.baseline();body=copy.deepcopy(obj.body);obj.close()
        body['state']['stats']['publish_in']['private']='PRIVATE_SENTINEL'
        raw=json.dumps(body);db=sqlite3.connect(self.path)
        db.execute('UPDATE snapshot SET body=?,sha256=? WHERE id=1',(raw,hashlib.sha256(raw.encode()).hexdigest()));db.commit();db.close()
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_state_invalid$'):self.open()

    def test_exclusive_reader_lock_prevents_second_writer(self):
        obj=self.baseline();before=copy.deepcopy(obj.body)
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_already_open$'):self.open(started_ns=400)
        self.assertEqual(obj.body,before)
        self.assertEqual(obj.frame(wire(frame(2,1,[event()])),500,source_binding_verified=True)['status'],'accepted')

    def test_missing_ledger_is_not_automatically_created(self):
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_open_failed$'):self.open()
        self.assertFalse(self.path.exists())

    def test_symlink_and_hardlink_are_rejected(self):
        target=self.root/'target';target.write_bytes(b'not sqlite');target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(LedgerUnavailable):self.open()
        self.path.unlink();os.link(target,self.path)
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_file_unsafe$'):self.open()
        self.assertEqual(target.read_bytes(),b'not sqlite')

    def test_parent_with_shared_access_is_rejected(self):
        self.root.chmod(0o750)
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_parent_unsafe$'):self.open(create=True)
        self.assertFalse(self.path.exists())

    def test_existing_file_with_shared_access_is_rejected(self):
        obj=self.baseline();obj.close();self.path.chmod(0o640)
        with self.assertRaisesRegex(LedgerUnavailable,'^ledger_file_unsafe$'):self.open()

    def test_js_projection_keeps_nanoseconds_above_2_to_53_exact(self):
        obj=self.open(create=True);value=2**53+17;f=frame();f['emitted_ns']=str(value)
        report=obj.frame(wire(f),value+1,source_binding_verified=True)['report']
        self.assertEqual(report['accounting']['state']['last_reader_ns'],str(value+1))
        self.assertEqual(report['accounting']['state']['last_emitted_ns'],str(value))
        self.assertIs(report['full24h_proven'],False)

    def test_input_cannot_choose_fault_names_or_smuggle_private_reason(self):
        obj=self.baseline();before=copy.deepcopy(obj.body)
        for fault in ['PRIVATE_SENTINEL','reader_restart','clock_domain_changed']:
            with self.assertRaisesRegex(LedgerUnavailable,'^fault_kind_invalid$'):obj.record_fault(fault,400)
        self.assertEqual(obj.body,before)

if __name__=='__main__':unittest.main()
