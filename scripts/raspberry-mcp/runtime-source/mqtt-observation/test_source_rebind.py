import copy,hashlib,unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import source_rebind as m
from source_binding import SourcePolicy
from worker_config import policy_document
from maintenance_journal import record_body,digest,MaintenanceUnavailable,PHASES
from test_maintenance_journal import facts,H,DOMAIN
from handoff import initial
from receiver_ledger import stringify

def fixture():
    instance='synthetic-closed-source';source_sha=hashlib.sha256(instance.encode()).hexdigest()
    h=initial(DOMAIN);h['acked_counts']['frames']=5
    counts=stringify(h['acked_counts']);op={'operation_id':'c'*32,'approval_sha256':H,'records':[]};parent=None
    for index,phase in enumerate(PHASES[:10]):
        f=facts(phase)
        if phase=='begin':f['source_instance_sha256']=source_sha
        if phase=='consumer_ready':f.update(old_source_instance_sha256=source_sha,protocol_counts_sha256=digest(counts))
        body=record_body(op['operation_id'],H,phase,f,str(100+index),DOMAIN,index+1,parent)
        row={'body':body,'sha256':digest(body)};op['records'].append(row);parent=row['sha256']
    body={'schema_version':1,'revision':'10','operations':[op]};snapshot={'body':body,'sha256':digest(body)}
    policy=SourcePolicy('a'*64,1883,1883,'b'*64,'c'*64,'/mosquitto/metadata/observer.so',0)
    verifier=SimpleNamespace(policy=policy,cache={'old':'cached'},sender_state=lambda:'verified_exited',retained_proof=object())
    ledger=SimpleNamespace(body={'state':{'source_closed':True,'epoch':1,'instance':instance,'unknown_epoch_tails':0},
      'handoff':h,'accepted_frames':5},report=lambda:{'accounting':{'handoff':{'acked_counts':counts}}})
    worker=SimpleNamespace(approval_id=H,instance='d'*64,domain=DOMAIN,source_verifier=verifier,
      ledger=ledger,reader=SimpleNamespace(sock=object()))
    new=replace(policy,container_id='e'*64)
    request={'schema_version':1,'operation_id':op['operation_id'],'approval_sha256':H,'journal_head_sha256':parent,
      'before_policy_sha256':digest(policy_document(policy,H)),'after_policy_sha256':digest(policy_document(new,H)),
      'reader_instance_sha256':worker.instance,'clock_domain_sha256':DOMAIN,'old_source_epoch':'1',
      'old_source_instance_sha256':source_sha,'issued_at_ns':'110','expires_at':1000}
    return worker,new,request,snapshot

class Tests(unittest.TestCase):
    def apply(self,w,new,r,s,queue=False):
        with patch.object(m.select,'select',return_value=([w.reader.sock]if queue else[],[],[])):
            return m.verify(w,new,H,r,s,now_wall=500,now_ns=600)
    def test_exact_rebind_changes_only_policy_and_cache_retaining_the_exited_sender(self):
        w,new,r,s=fixture();old_ledger=copy.deepcopy(w.ledger.body);proof=w.source_verifier.retained_proof
        self.assertEqual(self.apply(w,new,r,s),digest(r));self.assertEqual(w.source_verifier.policy,new)
        self.assertEqual(w.source_verifier.cache,{});self.assertIs(w.source_verifier.retained_proof,proof)
        self.assertEqual(w.ledger.body,old_ledger)
    def test_request_cannot_be_replayed_after_policy_has_changed(self):
        w,new,r,s=fixture();self.apply(w,new,r,s)
        with self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s)
    def test_wrong_grant_reader_domain_policy_or_head_never_rebinds(self):
        for key in ['approval_sha256','reader_instance_sha256','clock_domain_sha256',
          'before_policy_sha256','after_policy_sha256','journal_head_sha256','old_source_instance_sha256']:
            w,new,r,s=fixture();old=w.source_verifier.policy;r[key]='f'*64
            with self.subTest(key=key),self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s)
            self.assertEqual(w.source_verifier.policy,old);self.assertTrue(w.source_verifier.cache)
    def test_expired_future_or_pre_ready_request_stays_unknown(self):
        for key,value in [('expires_at',499),('issued_at_ns','601'),('issued_at_ns','108')]:
            w,new,r,s=fixture();r[key]=value
            with self.subTest(key=key),self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s)
    def test_running_unknown_or_unclosed_source_prevents_rebind(self):
        for change in ['live','unknown','unclosed','unacked','pending','active','tail_unknown']:
            w,new,r,s=fixture();old=w.source_verifier.policy
            if change in('live','unknown'):w.source_verifier.sender_state=lambda: 'verified_live'if change=='live'else'unknown'
            if change=='unclosed':w.ledger.body['state']['source_closed']=False
            if change=='unacked':w.ledger.body['accepted_frames']=6
            if change=='pending':w.ledger.body['handoff']['published']={}
            if change=='active':w.ledger.body['handoff']['active']['counts']['frames']=1
            if change=='tail_unknown':w.ledger.body['state']['unknown_epoch_tails']=1
            with self.subTest(change=change),self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s)
            self.assertEqual(w.source_verifier.policy,old)
    def test_queued_datagram_cannot_be_skipped_by_rebinding(self):
        w,new,r,s=fixture()
        with self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s,queue=True)
    def test_corrupt_journal_and_extra_request_fields_are_not_attestations(self):
        for alter in ['journal','request']:
            w,new,r,s=fixture()
            if alter=='journal':s['sha256']='0'*64
            else:r['private_payload']='PRIVATE_CANARY'
            with self.subTest(alter=alter),self.assertRaises((m.RebindUnavailable,MaintenanceUnavailable)):
                self.apply(w,new,r,s)
    def test_changed_protocol_cut_is_not_accepted_from_request_hashes(self):
        w,new,r,s=fixture();s['body']['operations'][0]['records'][-1]['body']['facts']['protocol_counts_sha256']='0'*64
        row=s['body']['operations'][0]['records'][-1];row['sha256']=digest(row['body']);r['journal_head_sha256']=row['sha256'];s['sha256']=digest(s['body'])
        with self.assertRaises(m.RebindUnavailable):self.apply(w,new,r,s)
if __name__=='__main__':unittest.main()
