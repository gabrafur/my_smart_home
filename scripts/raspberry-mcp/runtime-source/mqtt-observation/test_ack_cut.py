import copy,unittest
from handoff import totals
from receiver_ledger import stringify
from maintenance_backend import confirmed_cut,ObservationUnavailable,digest

class Tests(unittest.TestCase):
    def setUp(self):
        old=stringify(totals());old.update(frames='43',source_epochs='2',sessions='1')
        delta=stringify(totals());delta['frames']='9'
        native=copy.deepcopy(old);native['frames']='52'
        previous={'bucket_id':'5','sha256':'a'*64}
        body={'bucket_id':'6','previous_ack':previous,'aggregate':{'counts':delta}}
        packet={'body':body,'sha256':digest(body)}
        self.c={'last_receipt':'5','last_receipt_sha':digest(previous),'last_packet':'6',
          'acked_counts':old,'received_counts':native,'pending':packet}
        self.m={'acknowledged_counts':copy.deepcopy(native),'ack_receipt':{'bucket_id':'6',
          'packet_sha256':packet['sha256'],'receipt_sha256':'f'*64}}
    def test_root_ahead_one_packet_proves_exact_durable_prefix(self):
        self.assertEqual(confirmed_cut(self.m,self.c),self.c['acked_counts'])
        self.assertEqual(self.m['acknowledged_counts']['frames'],'52')
        self.assertEqual(self.c['acked_counts']['frames'],'43')
    def test_same_receipt_requires_exact_hash_and_counts(self):
        self.m['acknowledged_counts']=copy.deepcopy(self.c['acked_counts'])
        self.m['ack_receipt'].update(bucket_id='5',receipt_sha256=self.c['last_receipt_sha'])
        self.assertEqual(confirmed_cut(self.m,self.c),self.c['acked_counts'])
        self.m['ack_receipt']['receipt_sha256']='e'*64
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
    def test_smaller_numeric_counts_without_packet_proof_are_not_accepted(self):
        self.c['pending']=None
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
    def test_root_packet_and_previous_receipt_hashes_cannot_be_forged(self):
        self.m['ack_receipt']['packet_sha256']='e'*64
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
        self.m['ack_receipt']['packet_sha256']=self.c['pending']['sha256'];self.c['last_receipt_sha']='e'*64
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
    def test_snapshot_gap_of_two_receipts_requires_new_observation(self):
        self.m['ack_receipt']['bucket_id']='7'
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
    def test_both_packet_delta_and_root_counts_must_agree(self):
        self.c['received_counts']['frames']='53'
        with self.assertRaises(ObservationUnavailable):confirmed_cut(self.m,self.c)
