"""Candidate tests only. All data/transport are temporary and synthetic."""
import base64
import json
import os
import tempfile
import unittest
import registry


class LatestReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); os.chmod(self.tmp.name,0o700)
        self.now=1800000000.0; self.mono=50.; self.sent=[]; self.timeout=False
        self.reg=self.open('fixture_owner')
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture_sub','fixture_owner',json.dumps({'project':registry.PROJECT,'topics':['ha_notification']}),
             'https://fixture.invalid/events','whsec_'+base64.b64encode(b'x'*32).decode(),
             None,0,self.now+86400,self.now,self.now-86400,1))
    def open(self,owner):
        return registry.Registry(self.tmp.name,owner,approved=True,sender=self.send,
            clock=lambda:self.now,monotonic=lambda:self.mono)
    def tearDown(self):
        self.reg.db.close(); self.tmp.cleanup()
    def send(self,*args):
        self.sent.append(True);self.now+=.25;self.mono+=.125
        if self.timeout:raise TimeoutError('PRIVATE_SENTINEL')
        return 200,b''
    def batch(self,count=1):
        rows=[]
        for i in range(count):
            rows.append(self.reg.enqueue('ha_notification','ha_persistent_notification','updated',
                'a'*64,format(i+1,'064x'),self.now-.5)['id'])
        self.reg.observe_current([],self.now)
        result=self.reg.dispatch_one();return rows,result
    def test_exact_lineage_preserves_readonly_database_and_budget(self):
        events,dispatch=self.batch(); before=self.reg.db.total_changes
        self.reg.db.execute('PRAGMA query_only=ON')
        a=self.reg.latest_delivery_receipt(self.now);b=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(a,b);self.assertEqual(self.reg.db.total_changes,before)
        self.assertEqual(a['batch_id'],dispatch['event_id']);self.assertEqual(a['members'][0]['event_id'],events[0])
        self.assertTrue(a['batch_membership_verified']);self.assertEqual(a['transport']['outcome'],'response_2xx')
        self.assertEqual(a['assistant_execution'],'unknown');self.assertEqual(len(self.sent),1)
    def test_other_principal_sees_no_dispatch_or_member(self):
        self.batch(); other=self.open('different_fixture_owner')
        try:
            row=other.latest_delivery_receipt(self.now);self.assertEqual(row['state'],'empty');self.assertEqual(row['members'],[])
        finally:other.db.close()
    def test_uncertain_transport_never_becomes_assistant_proof_or_retry(self):
        self.timeout=True;self.batch();a=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(a['dispatch_state'],'uncertain');self.assertEqual(a['transport']['outcome'],'outcome_unknown')
        self.now+=601;self.assertEqual(self.reg.dispatch_one()['state'],'idle');self.assertEqual(len(self.sent),1)
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(a));self.assertEqual(a['assistant_execution'],'unknown')
    def test_bounded_details_still_verify_all_nine_members(self):
        self.batch(9);a=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(a['membership_record_count'],9);self.assertEqual(a['returned_members'],8)
        self.assertTrue(a['members_truncated']);self.assertTrue(a['batch_membership_verified'])
    def test_archive_lookup_preserves_exact_event_identity(self):
        events,_=self.batch();e=self.reg.db.execute('SELECT * FROM events WHERE id=?',(events[0],)).fetchone()
        self.reg.db.execute('INSERT INTO event_archive VALUES(?,?,?,?,?,?)',(e['id'],e['topic'],e['body'],e['created'],self.now,'covered_by_summary'))
        self.reg.db.execute('DELETE FROM events WHERE id=?',(events[0],))
        a=self.reg.latest_delivery_receipt(self.now);self.assertEqual(a['members'][0]['record_location'],'archive')
        self.assertEqual(a['members'][0]['event_id'],events[0])
    def test_changed_membership_or_private_source_content_fails_closed(self):
        events,_=self.batch();self.reg.db.execute('UPDATE delivery_members SET event=? WHERE event=?',('f'*64,events[0]))
        a=self.reg.latest_delivery_receipt(self.now);self.assertEqual(a['state'],'unknown');self.assertFalse(a['batch_membership_verified'])
        self.assertEqual(a['members'],[])
    def test_private_source_field_is_not_exported(self):
        events,_=self.batch();e=self.reg.db.execute('SELECT body FROM events WHERE id=?',(events[0],)).fetchone()[0]
        e=json.loads(e);e['data']['private']='PRIVATE_SENTINEL';self.reg.db.execute('UPDATE events SET body=? WHERE id=?',(json.dumps(e),events[0]))
        a=self.reg.latest_delivery_receipt(self.now);self.assertEqual(a['state'],'observed');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(a))
    def test_missing_completion_retains_membership_without_fabricated_time(self):
        self.batch();self.reg.db.execute('DELETE FROM transport_observations')
        a=self.reg.latest_delivery_receipt(self.now);self.assertTrue(a['batch_membership_verified'])
        self.assertIsNone(a['transport']['observed_at']);self.assertEqual(a['transport']['collection_error'],'transport_completion_missing')

if __name__=='__main__':unittest.main()
