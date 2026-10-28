import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('metadata_test_webhook', ROOT/'webhook.py')
webhook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webhook)
# Load the isolated source without changing the installed service's module path.
with patch.dict(sys.modules, {'webhook': webhook}):
    spec = importlib.util.spec_from_file_location('metadata_test_registry', ROOT/'registry.py')
    registry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry)


class EventCountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.now = 1000000
        self.reg = registry.Registry(self.tmp.name, 'synthetic_owner', clock=lambda: self.now)
        self.subscription('owned', 'synthetic_owner')

    def tearDown(self):
        self.reg.db.close()
        self.tmp.cleanup()

    def subscription(self, identity, owner, active=1, expires=None, started=None, topics=None):
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (identity, owner, json.dumps({'project': registry.PROJECT, 'topics': topics or ['ha_notification']}),
             None, None, None, 0, expires or self.now+1000, 0, self.now-100 if started is None else started, active))

    def event(self, identity, created=None, topic='ha_notification'):
        self.reg.db.execute('INSERT INTO events VALUES(?,?,?,?)',
            (identity, topic, 'PRIVATE_SENTINEL', self.now-1 if created is None else created))

    def test_total_retained_is_not_pending_and_read_has_no_effects(self):
        for name in ['pending', 'accepted', 'refused', 'uncertain']:
            self.event(name)
        for name, state in [('accepted', 'webhook_accepted'), ('refused', 'delivery_refused'), ('uncertain', 'uncertain')]:
            self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('owned', name, state, self.now-1))
        before = list(self.reg.db.iterdump())
        counts = self.reg.event_counts(self.now)
        self.assertEqual(counts['retained_event_records'], 4)
        self.assertEqual(counts['eligible_pending_event_records'], 1)
        self.assertEqual(counts['queued_event_records'], 1)
        self.assertIsNone(counts['event_count_collection_error'])
        self.assertEqual(before, list(self.reg.db.iterdump()))
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(counts))

    def test_owner_topic_time_and_subscription_start_match_dispatch_scope(self):
        for name, at, topic in [('eligible', self.now-1, 'ha_notification'),
                               ('before_start', self.now-101, 'ha_notification'),
                               ('old', self.now-86401, 'ha_notification'),
                               ('other_topic', self.now-1, 'other')]:
            self.event(name, at, topic)
        self.subscription('other', 'other_owner')
        self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('other', 'eligible', 'uncertain', self.now))
        result = self.reg.event_counts(self.now)
        self.assertEqual(result['retained_event_records'], 4)
        self.assertEqual(result['eligible_pending_event_records'], 1, 'another owner intent does not consume current owner work')

    def test_no_active_owner_subscription_means_zero_eligible_not_no_history(self):
        self.event('retained')
        for expression in ['active=0', 'expires=999999', "owner='another_owner'"]:
            with self.subTest(expression=expression):
                self.reg.db.execute('UPDATE subscriptions SET active=1,expires=?,owner=?', (self.now+1000, 'synthetic_owner'))
                self.reg.db.execute('UPDATE subscriptions SET '+expression)
                result = self.reg.event_counts(self.now)
                self.assertEqual(result['eligible_pending_event_records'], 0)
                self.assertEqual(result['retained_event_records'], 1)

    def test_ambiguous_scope_invalid_dates_or_filters_stay_unknown(self):
        for change in ["started=1000001", "args='{}'", "args='invalid_json'"]:
            with self.subTest(change=change):
                before = self.reg.db.execute('SELECT args,started FROM subscriptions').fetchone()
                self.reg.db.execute('UPDATE subscriptions SET '+change)
                self.assertIsNone(self.reg.event_counts(self.now)['eligible_pending_event_records'])
                self.reg.db.execute('UPDATE subscriptions SET args=?,started=?', tuple(before))
        self.subscription('duplicate', 'synthetic_owner')
        self.assertIsNone(self.reg.event_counts(self.now)['eligible_pending_event_records'])

    def test_budget_hold_is_separate_and_does_not_consume_pending_work(self):
        self.event('pending')
        for index in range(144):
            self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('owned', str(index), 'uncertain', self.now-1000))
        self.reg.approved = True
        self.assertEqual(self.reg.dispatch_one()['state'], 'budget_held')
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'], 1)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0], 144)

    def test_collection_failure_stays_unknown(self):
        self.reg.db.execute('DROP TABLE events')
        result = self.reg.event_counts(self.now)
        self.assertIsNone(result['retained_event_records'])
        self.assertIsNone(result['eligible_pending_event_records'])
        self.assertEqual(result['event_count_collection_error'], 'event_count_scope_or_collection_unconfirmed')


if __name__ == '__main__':
    unittest.main()
