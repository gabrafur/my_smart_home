import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

import delivery_summary as s
from registry import Registry
from webhook import Refused


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.now = 1800000000.0
        self.calls = []
        self.reg = Registry(self.tmp.name, 'test_owner', approved=True,
                            sender=self.send, clock=lambda: self.now)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('sub', 'test_owner', json.dumps({'project': '/mnt/data/docker', 'topics': ['ha_notification']}),
             'https://callback.example.org/events', 'whsec_'+base64.b64encode(b'x'*32).decode(),
             None, 0, self.now+86400, self.now, self.now-86400, 1))

    def tearDown(self):
        self.reg.db.close()
        self.tmp.cleanup()

    def send(self, url, headers, body):
        self.calls.append((headers, json.loads(body)))
        return 200, b''

    def add(self, phase='updated', object_id='a'*64, index=0, age=0):
        return self.reg.enqueue('ha_notification', 'ha_persistent_notification', phase,
            object_id, hashlib.sha256(str(index).encode()).hexdigest(), self.now-age)['id']

    def current(self, *identities):
        self.reg.observe_current([{'id': identity, 'revision': 'f'*64} for identity in identities], self.now)

    def test_many_revisions_use_one_attempt_preserve_history(self):
        ids = [self.add(index=i, age=30-i) for i in range(20)]
        self.current('a'*64)
        out = self.reg.dispatch_one()
        self.assertEqual(out['covered_event_records'], 20)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0], 1)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0], 20)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM delivery_members').fetchone()[0], 20)
        group = self.calls[0][1]['data']['notifications'][0]
        self.assertEqual(group['change_count'], 20)
        self.assertEqual(group['revisions_coalesced'], 19)
        self.assertEqual(group['current_state'], 'current')
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'], 0)
        self.assertFalse(out['assistant_run_confirmed'])

    def test_quick_add_remove_is_history_not_recovery(self):
        self.add('added', index=0, age=1)
        self.add('removed', index=1)
        self.current()
        self.reg.dispatch_one()
        group = self.calls[0][1]['data']['notifications'][0]
        self.assertEqual(group['current_state'], 'removed')
        self.assertEqual(group['transition_preview'], ['added', 'removed'])
        self.assertFalse(group['recovery_proven'])

    def test_snapshot_prevails_over_historical_phase(self):
        self.add('removed')
        self.current('a'*64)
        self.reg.dispatch_one()
        group = self.calls[0][1]['data']['notifications'][0]
        self.assertEqual(group['current_state'], 'current')
        self.assertEqual(group['latest_known_phase'], 'removed')

    def test_unknown_current_never_inferred_from_old_added(self):
        self.add('added', age=80000)
        self.reg.dispatch_one()
        self.assertEqual(self.calls[0][1]['data']['notifications'][0]['current_state'], 'unknown')

    def test_stale_snapshot_never_presented_as_current(self):
        self.current('a'*64)
        self.now += 16
        self.add()
        self.reg.dispatch_one()
        self.assertEqual(self.calls[0][1]['data']['notifications'][0]['current_state'], 'unknown')

    def test_new_current_problem_precedes_old_queue(self):
        for i in range(9):
            self.add('removed', object_id=hashlib.sha256(str(i).encode()).hexdigest(), index=i, age=80000-i)
        self.add('added', object_id='e'*64, index=20)
        self.current('e'*64)
        self.reg.dispatch_one()
        body=self.calls[0][1]['data']
        self.assertEqual(body['notifications'][0]['object_id'], 'e'*64)
        self.assertEqual(len(body['notifications']), 8)
        self.assertEqual(body['remaining_notification_groups'], 2)
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'], 2)

    def test_uncertain_batch_never_replayed_after_restart(self):
        for i in range(4): self.add(index=i, age=i)
        self.reg.sender=lambda *a: (_ for _ in ()).throw(TimeoutError())
        self.assertEqual(self.reg.dispatch_one()['state'], 'uncertain')
        self.reg.db.close()
        self.now += 601
        self.reg=Registry(self.tmp.name,'test_owner',approved=True,sender=self.send,clock=lambda:self.now)
        self.assertEqual(self.reg.dispatch_one()['state'], 'idle')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0], 'uncertain')

    def test_new_revision_after_uncertain_is_distinct_work(self):
        self.add(index=1)
        self.reg.sender=lambda *a: (_ for _ in ()).throw(TimeoutError())
        self.reg.dispatch_one()
        self.now += 600
        self.add(index=2)
        self.reg.sender=self.send
        result=self.reg.dispatch_one()
        self.assertEqual(result['covered_event_records'],1)
        self.assertEqual(len(self.calls),1)

    def test_old_direct_uncertain_intent_excluded(self):
        event=self.add()
        self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',('sub',event,'uncertain',self.now-601))
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'],0)

    def test_six_attempts_and_spacing_unchanged(self):
        for i in range(6):
            self.add(index=i)
            self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
            self.assertEqual(self.reg.dispatch_one()['state'],'budget_held')
            self.now+=600
        self.add(index=7)
        self.assertEqual(self.reg.dispatch_one()['state'],'budget_held')
        self.assertEqual(len(self.calls),6)

    def test_expired_subscription_sends_nothing(self):
        self.add()
        self.reg.db.execute('UPDATE subscriptions SET expires=?',(self.now,))
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.calls,[])

    def test_opportunity_after_budget_and_before_lease(self):
        for i in range(6):
            self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',('sub',str(i),'uncertain',self.now-1000+i*100))
        self.add()
        result=self.reg.status()['delivery_opportunity']
        self.assertEqual(result['next_opportunity_at'],s.iso(self.now-1000+86400))
        self.assertTrue(result['within_subscription_validity'])
        self.reg.db.execute('UPDATE subscriptions SET expires=?',(self.now+100,))
        self.assertTrue(self.reg.status()['delivery_opportunity']['requires_subscription_renewal'])

    def test_opportunity_exact_boundary_is_not_valid_lease(self):
        result=s.opportunity([self.now]*6,self.now,self.now+86400,1)
        self.assertFalse(result['within_subscription_validity'])

    def test_more_than_six_old_attempts_get_correct_release(self):
        result=s.opportunity([self.now-10+i for i in range(8)],self.now,self.now+86400,1)
        self.assertEqual(result['next_opportunity_at'],s.iso(self.now-8+86400))

    def test_collect_failure_keeps_unknown(self):
        self.reg.db.execute('DROP TABLE delivery_members')
        result=self.reg.delivery_diagnostics(self.now)
        self.assertEqual(result['delivery_queue']['state'],'unknown')
        self.assertEqual(result['delivery_opportunity']['state'],'unknown')

    def test_status_is_readonly_and_contains_no_callback_or_key(self):
        self.add()
        before=list(self.reg.db.iterdump())
        result=self.reg.status()
        self.assertEqual(before,list(self.reg.db.iterdump()))
        self.assertNotIn('callback.example.org',json.dumps(result))
        self.assertNotIn('whsec_',json.dumps(result))

    def test_expired_unsent_rows_archived_explicitly_never_reingested(self):
        event=self.add('added')
        self.now+=86401
        self.reg.prune()
        archived=self.reg.db.execute('SELECT id,reason FROM event_archive').fetchall()
        self.assertEqual(tuple(archived[0]),(event,'eligibility_window_elapsed'))
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],0)
        # Same envelope ID remains a duplicate even if a snapshot repeats it now.
        self.assertEqual(self.add('added'),event)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_archive_full_fails_without_losing_event(self):
        for i in range(4096):
            self.reg.db.execute('INSERT INTO event_archive VALUES(?,?,?,?,?,?)',(str(i),'ha_notification','{}',0,0,'eligibility_window_elapsed'))
        self.add();self.now+=86401
        with self.assertRaisesRegex(Refused,'event_history_archive_full'):self.reg.prune()
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],1)

    def test_ambiguous_equal_timestamps_and_long_transitions_explicit(self):
        self.add('added',index=0)
        self.add('removed',index=1)
        self.reg.dispatch_one()
        group=self.calls[0][1]['data']['notifications'][0]
        self.assertTrue(group['historical_order_ambiguous'])
        self.assertIsNone(group['latest_known_phase'])

    def test_long_transition_preview_not_silent_loss(self):
        for i in range(20):self.add('added' if i%2==0 else 'removed',index=i,age=20-i)
        self.reg.dispatch_one()
        group=self.calls[0][1]['data']['notifications'][0]
        self.assertEqual(group['transition_preview_omitted'],12)
        self.assertEqual(group['phase_counts'],{'added':10,'updated':0,'removed':10})

    def test_worst_case_payload_under_transport_limit(self):
        for i in range(256):self.add('added' if i%2==0 else 'removed',object_id=hashlib.sha256(str(i%8).encode()).hexdigest(),index=i,age=256-i)
        self.reg.dispatch_one()
        self.assertLessEqual(len(s.encode(self.calls[0][1]).encode()),16384)

    def test_malformed_event_no_partial_intent(self):
        self.add()
        self.reg.db.execute("UPDATE events SET body='{}'")
        with self.assertRaises((KeyError,ValueError)):self.reg.dispatch_one()
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],0)
        self.assertEqual(self.calls,[])

    def test_future_attempt_clock_and_invalid_scope_refused(self):
        with self.assertRaises(ValueError):s.opportunity([self.now+2],self.now,self.now+1000,1)
        self.add()
        self.reg.db.execute("UPDATE subscriptions SET args='{}'")
        self.assertEqual(self.reg.delivery_diagnostics(self.now)['delivery_queue']['state'],'unknown')

    def test_failed_membership_transaction_has_no_partial_intent(self):
        self.add()
        self.reg.db.execute("CREATE TRIGGER inject_failure BEFORE INSERT ON delivery_members BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END")
        with self.assertRaises(Exception):self.reg.dispatch_one()
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM delivery_batches').fetchone()[0],0)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],0)
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'],1)
        self.assertEqual(self.calls,[])

    def test_process_interrupt_after_intent_never_retries(self):
        self.add()
        self.reg.sender=lambda *a:(_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):self.reg.dispatch_one()
        self.now+=601;self.reg.sender=self.send
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
        self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
