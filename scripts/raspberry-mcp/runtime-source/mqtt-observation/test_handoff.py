import copy,hashlib,json,os,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
import handoff
from handoff_ledger import HandoffLedger
from receiver_ledger import Ledger,LedgerUnavailable,encode
from test_protocol import frame,event,project

DOMAIN='d'*64
def wire(value):return json.dumps(value,separators=(',',':')).encode()
def ack(packet):return {'schema_version':1,'bucket_id':packet['body']['bucket_id'],'sha256':packet['sha256']}

class HandoffTests(unittest.TestCase):
    def test_native_clock_and_send_failures_are_conserved_across_sources_and_acks(self):
        obj=self.open(create=True)
        self.add(obj,1,0,[],300,clock_faults='2',send_failures='7')
        one=obj.publish(400);obj.acknowledge(ack(one),450)
        second=frame(clock_faults='3',send_failures='11');second['instance']='b'*32
        self.assertEqual(obj.frame(wire(second),500,source_binding_verified=True)['status'],'accepted')
        two=obj.publish(550)
        self.assertEqual(one['body']['aggregate']['counts']['source_clock_faults'],'2')
        self.assertEqual(two['body']['aggregate']['counts']['source_clock_faults'],'3')
        self.assertEqual(two['body']['aggregate']['counts']['source_send_failures'],'11')
        obj.acknowledge(ack(two),600)
        self.assertEqual(obj.body['handoff']['acked_counts']['source_clock_faults'],5)
        self.assertEqual(obj.body['handoff']['acked_counts']['source_send_failures'],18)
        obj.close();obj=self.open(started_ns=650)
        self.assertEqual(obj.body['handoff']['acked_counts']['source_clock_faults'],5)

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mqtt-handoff-')
        self.path=Path(self.tmp.name)/'state.sqlite3';self.handles=[]
    def tearDown(self):
        for obj in self.handles:obj.close()
        self.tmp.cleanup()
    def open(self,**kw):
        obj=HandoffLedger(self.path,create=kw.pop('create',False),clock_domain_id=kw.pop('clock_domain_id',DOMAIN),started_ns=kw.pop('started_ns',250))
        self.handles.append(obj);return obj
    def baseline(self):
        obj=self.open(create=True);self.assertEqual(obj.frame(wire(frame()),300,source_binding_verified=True)['status'],'accepted');return obj
    def add(self,obj,seq,total,rows,now=350,**extra):
        self.assertEqual(obj.frame(wire(frame(seq,total,rows,**extra)),now,source_binding_verified=True)['status'],'accepted')

    def test_every_fast_batch_is_in_one_consumer_packet_and_bound_includes_poll_delay(self):
        obj=self.baseline();self.add(obj,2,1,[event(1,'150')]);self.add(obj,3,2,[event(2,'160')],360)
        packet=obj.publish(400);row=packet['body']['aggregate']['counts']['stats']['publish_in']
        self.assertEqual(row['expected'],'2');self.assertEqual(row['observed'],'2')
        self.assertEqual(packet['body']['aggregate']['oldest_source_ns']['publish_in'],'150')
        result=obj.acknowledge(ack(packet),500)
        self.assertEqual(result['status'],'accepted')
        self.assertEqual(result['receipt']['source_to_ack']['publish_in']['upper_ns'],'350')
        self.assertEqual(obj.body['handoff']['acked_counts']['stats']['publish_in']['observed'],2)
        self.assertFalse(obj.report()['full24h_proven'])

    def test_frozen_publication_stays_identical_as_new_source_frames_arrive(self):
        obj=self.baseline();self.add(obj,2,1,[event()]);one=obj.publish(400)
        self.add(obj,3,2,[event(2,'160')],450)
        self.assertEqual(obj.publish(480),one)
        self.assertEqual(obj.body['handoff']['active']['counts']['stats']['publish_in']['expected'],1)
        self.assertEqual(obj.acknowledge(ack(one),500)['status'],'accepted')
        two=obj.publish(600)
        self.assertEqual(two['body']['bucket_id'],'2')
        self.assertEqual(two['body']['previous_ack']['bucket_id'],'1')
        self.assertEqual(two['body']['previous_ack']['sha256'],one['sha256'])
        self.assertEqual(two['body']['aggregate']['counts']['stats']['publish_in']['expected'],'1')

    def test_invalid_ack_never_discards_bucket_or_persists_private_fields(self):
        obj=self.baseline();packet=obj.publish(400)
        invalid=ack(packet);invalid['private']='PRIVATE_ACK_CANARY'
        self.assertEqual(obj.acknowledge(invalid,500)['status'],'rejected')
        self.assertEqual(obj.publish(550),packet)
        self.assertEqual(obj.body['handoff']['ack_rejections'],1)
        self.assertNotIn('PRIVATE_ACK_CANARY',json.dumps(obj.report()))

    def test_duplicate_and_stale_acks_are_idempotent_but_digest_conflict_is_counted(self):
        obj=self.baseline();one=obj.publish(400)
        obj.acknowledge(ack(one),450)
        self.add(obj,2,1,[event()],500);two=obj.publish(550);obj.acknowledge(ack(two),600)
        revision=obj.body['revision']
        self.assertEqual(obj.acknowledge(ack(two),650)['status'],'duplicate')
        self.assertEqual(obj.acknowledge(ack(one),660)['status'],'stale_ignored')
        self.assertEqual(obj.body['revision'],revision)
        wrong=ack(two);wrong['sha256']='f'*64
        self.assertEqual(obj.acknowledge(wrong,670)['status'],'rejected')
        self.assertEqual(obj.body['handoff']['acked_buckets'],2)

    def test_unacknowledged_packet_survives_os_exit_and_restart_fault_is_separate(self):
        obj=self.baseline();self.add(obj,2,1,[event()]);obj.close()
        code="""import sys,os
sys.path.insert(0,sys.argv[1])
from handoff_ledger import HandoffLedger
obj=HandoffLedger(sys.argv[2],clock_domain_id='d'*64,started_ns=400)
obj.publish(450)
os._exit(0)
"""
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(Path(__file__).parent),str(self.path)],capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        obj=self.open(started_ns=500);packet=obj.publish(550)
        self.assertEqual(packet['body']['aggregate']['counts']['stats']['publish_in']['observed'],'1')
        self.assertEqual(packet['body']['aggregate']['counts']['faults']['reader_restart'],'1')
        self.assertEqual(obj.body['handoff']['active']['counts']['faults']['reader_restart'],1)
        self.assertEqual(obj.acknowledge(ack(packet),600)['status'],'accepted')

    def test_failed_publication_commit_returns_no_packet_and_keeps_source_counts(self):
        obj=self.baseline();before=copy.deepcopy(obj.body);obj.db.execute('PRAGMA query_only=ON')
        with self.assertRaisesRegex(LedgerUnavailable,'^metadata_commit_failed$'):obj.publish(400)
        self.assertEqual(obj.body,before);obj.close()
        obj=self.open(started_ns=450)
        self.assertIsNone(obj.body['handoff']['published']);self.assertEqual(obj.body['accepted_frames'],1)

    def test_failed_ack_commit_cannot_claim_delivery_or_drop_frozen_packet(self):
        obj=self.baseline();one=obj.publish(400);before=copy.deepcopy(obj.body)
        obj.db.execute('PRAGMA query_only=ON')
        with self.assertRaisesRegex(LedgerUnavailable,'^metadata_commit_failed$'):obj.acknowledge(ack(one),500)
        self.assertEqual(obj.body,before);obj.close()
        obj=self.open(started_ns=550)
        self.assertEqual(obj.publish(600),one);self.assertEqual(obj.body['handoff']['acked_buckets'],0)
        self.assertEqual(obj.acknowledge(ack(one),650)['status'],'accepted')

    def test_transport_gaps_and_source_drops_are_preserved_as_distinct_counts(self):
        obj=self.baseline()
        value=frame(3,4,[event(3,'170'),event(4,'180')]);value['source_dropped']['publish_in']='1'
        self.assertEqual(obj.frame(wire(value),400,source_binding_verified=True)['status'],'accepted')
        packet=obj.publish(450);row=packet['body']['aggregate']['counts']['stats']['publish_in']
        self.assertEqual((row['expected'],row['observed'],row['missing'],row['source_dropped'],row['transport_missing']),('4','2','2','1','1'))
        self.assertEqual(packet['body']['aggregate']['counts']['report_gaps'],'1')
        receipt=obj.acknowledge(ack(packet),500)['receipt']
        self.assertEqual(receipt['source_to_ack']['publish_in']['timed'],'2')

    def test_unknown_source_clock_never_becomes_zero_latency(self):
        obj=self.baseline();self.add(obj,2,1,[event(at=None)],clock_faults='1')
        packet=obj.publish(400);result=obj.acknowledge(ack(packet),500)
        row=result['receipt']['source_to_ack']['publish_in']
        self.assertIsNone(row['upper_ns']);self.assertEqual(row['timed'],'0');self.assertEqual(row['timing_unknown'],'1')

    def test_source_generation_change_keeps_previous_counts_and_unknown_tail(self):
        obj=self.baseline();self.add(obj,2,1,[event()])
        new=frame();new['instance']='b'*32
        self.assertEqual(obj.frame(wire(new),400,source_binding_verified=True)['status'],'accepted')
        packet=obj.publish(450);counts=packet['body']['aggregate']['counts']
        self.assertEqual(counts['stats']['publish_in']['expected'],'1')
        self.assertEqual(counts['source_epochs'],'2');self.assertEqual(counts['unknown_epoch_tails'],'1')

    def test_ack_in_new_boot_domain_preserves_bucket_and_marks_latency_unknown(self):
        obj=self.baseline();self.add(obj,2,1,[event()]);one=obj.publish(400);obj.close()
        obj=self.open(clock_domain_id='e'*64,started_ns=10)
        self.assertEqual(obj.publish(15),one)
        result=obj.acknowledge(ack(one),20)
        self.assertEqual(result['status'],'accepted');self.assertFalse(result['receipt']['clock_ordered'])
        row=result['receipt']['source_to_ack']['publish_in']
        self.assertIsNone(row['upper_ns']);self.assertEqual(row['timing_unknown'],'1')
        self.assertEqual(obj.body['handoff']['ack_clock_conflicts'],1)
        self.assertEqual(obj.body['faults']['clock_domain_changed'],1)

    def test_backward_ack_clock_is_unknown_without_clamping(self):
        obj=self.baseline();self.add(obj,2,1,[event()]);one=obj.publish(400)
        result=obj.acknowledge(ack(one),399)
        self.assertFalse(result['receipt']['clock_ordered'])
        self.assertIsNone(result['receipt']['publication_to_ack_ns'])
        self.assertEqual(result['receipt']['source_to_ack']['publish_in']['timing_unknown'],'1')

    def test_publication_clock_before_source_receipt_is_also_unknown(self):
        obj=self.baseline();self.add(obj,2,1,[event()],350);one=obj.publish(349)
        result=obj.acknowledge(ack(one),500)
        self.assertFalse(result['receipt']['clock_ordered'])
        self.assertIsNone(result['receipt']['source_to_ack']['publish_in']['upper_ns'])
        self.assertEqual(obj.body['handoff']['ack_clock_conflicts'],1)

    def test_public_packet_hash_covers_exact_decimal_ns_and_ack_identity(self):
        obj=self.baseline();one=obj.publish(2**53+17)
        self.assertEqual(one['body']['published_at_ns'],str(2**53+17))
        calculated=hashlib.sha256(encode(one['body']).encode('ascii')).hexdigest()
        self.assertEqual(calculated,one['sha256'])
        obj.acknowledge(ack(one),2**53+18)
        self.assertEqual(obj.body['handoff']['last_ack']['ack_at_ns'],2**53+18)

    def test_rehashed_persistence_cannot_hide_lost_counts(self):
        obj=self.baseline();obj.close();db=sqlite3.connect(self.path)
        body=json.loads(db.execute('SELECT body FROM snapshot').fetchone()[0])
        body['handoff']['active']['counts']['frames']=0
        raw=encode(body);db.execute('UPDATE snapshot SET body=?,sha256=? WHERE id=1',(raw,hashlib.sha256(raw.encode()).hexdigest()))
        db.commit();db.close()
        with self.assertRaisesRegex(LedgerUnavailable,'^handoff_state_invalid$'):self.open()

    def test_source_only_ledger_is_not_silently_upgraded_or_reset(self):
        old=Ledger(self.path,create=True,clock_domain_id=DOMAIN,started_ns=250);old.close()
        with self.assertRaisesRegex(LedgerUnavailable,'^handoff_state_invalid$'):self.open()
        old=Ledger(self.path,clock_domain_id=DOMAIN,started_ns=300);self.handles.append(old)
        self.assertEqual(old.body['reader_sessions'],2)

    def test_empty_after_ack_does_not_drop_the_receipt_or_create_fake_source_frames(self):
        obj=self.baseline();one=obj.publish(400);obj.acknowledge(ack(one),500)
        self.assertIsNone(obj.publish(550))
        self.assertEqual(obj.body['handoff']['last_ack']['bucket_id'],1)
        self.assertEqual(obj.body['accepted_frames'],1)

    def test_two_buckets_remain_bounded_during_2000_unread_source_frames(self):
        body={'accepted_frames':0,'duplicate_frames':0,'reader_sessions':0,
              'faults':dict.fromkeys(handoff.FAULTS,0),'state':None,'clock_domain_id':DOMAIN}
        h=handoff.initial(DOMAIN);old=None
        for seq in range(1,2001):
            source=project(frame(seq,seq,[event(seq,str(150+seq))]),body['state'],now=300+seq)['state']
            old=copy.deepcopy(body);body['accepted_frames']+=1;body['state']=source
            handoff.observe(h,old,body,300+seq)
            if seq==1:packet,_=handoff.freeze(h,301,DOMAIN)
        handoff.validate(h,body)
        self.assertEqual(h['published']['value']['aggregate']['counts']['stats']['publish_in']['expected'],1)
        self.assertEqual(h['active']['counts']['stats']['publish_in']['expected'],1999)
        self.assertLess(len(encode(h)),16000)
        status,_=handoff.acknowledge(h,ack(packet),3000,DOMAIN);self.assertEqual(status,'accepted')
        handoff.validate(h,body)

if __name__=='__main__':unittest.main()
