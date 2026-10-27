"""Synthetic transport evidence; never contacts a callback or household service."""
import base64
import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import registry


class ConnectionProxy:
    def __init__(self, connection, before):
        object.__setattr__(self, 'connection', connection)
        object.__setattr__(self, 'before', before)

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def __setattr__(self, name, value):
        setattr(self.connection, name, value)

    def execute(self, sql, *args):
        self.before(sql)
        return self.connection.execute(sql, *args)


class TransportTimingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.wall = 1800000000.0
        self.mono = 50.0
        self.calls = []
        self.mode = 'accepted'
        self.reg = self.open()
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('sub', 'test_owner', json.dumps({'project': registry.PROJECT, 'topics': ['ha_notification']}),
             'https://callback.example.org/events', 'whsec_'+base64.b64encode(b'x'*32).decode(),
             None, 0, self.wall+86400, self.wall, self.wall-86400, 1))

    def open(self):
        return registry.Registry(self.tmp.name, 'test_owner', approved=True,
                                 sender=self.send, clock=lambda: self.wall,
                                 monotonic=lambda: self.mono)

    def tearDown(self):
        self.reg.db.close()
        self.tmp.cleanup()

    def send(self, url, headers, body):
        self.calls.append((headers, json.loads(body)))
        self.wall += 0.25
        self.mono += 0.125
        if self.mode == 'timeout':
            raise TimeoutError('synthetic transport uncertainty')
        if self.mode == 'crash':
            raise SystemExit('synthetic process loss')
        if self.mode == 'clock_rollback':
            self.wall -= 5
        if self.mode == 'invalid_wall':
            self.reg.clock = lambda: float('nan')
        return (503 if self.mode == 'refused' else 200), b''

    def add(self):
        self.reg.enqueue('ha_notification', 'ha_persistent_notification', 'updated',
                         'a'*64, 'b'*64, self.wall-0.5)
        self.reg.observe_current([], self.wall)

    def dispatch(self):
        self.add()
        return self.reg.dispatch_one()

    def latest(self):
        return self.reg.transport_diagnostics()['latest']

    def test_success_has_native_boundary_clocks_without_assistant_claim(self):
        out = self.dispatch()
        self.assertEqual(out['state'], 'webhook_accepted')
        self.assertFalse(out['assistant_run_confirmed'])
        self.assertEqual(self.latest()['sender_duration_ms'], 125)
        self.assertEqual(self.latest()['completed_at'], registry.iso(1800000000.25))
        self.assertEqual(self.latest()['outcome'], 'response_2xx')
        self.assertEqual(self.reg.status()['webhook_transport_timing']['complete_timing_records'], 1)
        self.assertEqual(self.reg.status()['attempts_last_24h'], 1)

    def test_timeout_is_measured_but_members_remain_uncertain_and_never_replayed(self):
        self.mode = 'timeout'
        self.assertEqual(self.dispatch()['state'], 'uncertain')
        self.assertEqual(self.latest()['outcome'], 'outcome_unknown')
        self.assertEqual(self.latest()['sender_duration_ms'], 125)
        self.reg.db.close()
        self.wall += 601
        self.reg = self.open()
        self.assertEqual(self.reg.dispatch_one()['state'], 'idle')
        self.assertEqual(len(self.calls), 1)

    def test_refused_response_has_its_own_outcome(self):
        self.mode = 'refused'
        self.assertEqual(self.dispatch()['state'], 'delivery_refused')
        self.assertEqual(self.latest()['outcome'], 'response_non2xx')

    def test_wall_clock_rollback_preserves_monotonic_duration_without_complete_claim(self):
        self.mode = 'clock_rollback'
        self.assertEqual(self.dispatch()['state'], 'webhook_accepted')
        value = self.reg.transport_diagnostics()
        self.assertEqual(value['latest']['sender_duration_ms'], 125)
        self.assertEqual(value['latest']['collection_error'], 'wall_clock_reconciliation_required')
        self.assertEqual(value['complete_timing_records'], 0)

    def test_failed_boundary_clock_is_not_resampled_after_persistence(self):
        readings = iter([50.0, float('nan'), 999.0])
        self.reg.monotonic = lambda: next(readings)
        self.assertEqual(self.dispatch()['state'], 'webhook_accepted')
        self.assertIsNone(self.latest()['sender_duration_ms'])
        self.assertEqual(self.latest()['collection_error'], 'sender_duration_unavailable')
        self.assertEqual(next(readings), 999.0)

    def test_missing_optional_table_does_not_change_accepted_state_or_budget(self):
        self.reg.db.execute('DROP TABLE transport_observations')
        self.assertEqual(self.dispatch()['state'], 'webhook_accepted')
        self.assertEqual(self.reg.transport_diagnostics()['state'], 'unknown')
        self.reg.prune()
        self.assertEqual(self.reg.dispatch_one()['state'], 'budget_held')
        self.assertEqual(len(self.calls), 1)

    def test_optional_schema_failure_leaves_existing_delivery_usable(self):
        self.reg.db.execute('DROP TABLE transport_observations')
        self.reg.db.close()
        connect = sqlite3.connect

        def before(sql):
            if sql.startswith('CREATE TABLE IF NOT EXISTS transport_observations'):
                raise sqlite3.OperationalError('synthetic optional metadata failure')

        with patch.object(registry.sqlite3, 'connect',
                          lambda *a, **kw: ConnectionProxy(connect(*a, **kw), before)):
            self.reg = self.open()
        self.assertEqual(self.reg.transport_observation_error, 'transport_observation_schema_unavailable')
        self.assertEqual(self.dispatch()['state'], 'webhook_accepted')
        self.assertEqual(len(self.calls), 1)

    def test_original_sql_schema_and_fixed_arity_inserts_stay_compatible(self):
        self.assertEqual([row[1] for row in self.reg.db.execute('PRAGMA table_info(dispatch)')],
                         ['subscription', 'event', 'state', 'at'])
        self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',
                            ('sub', 'legacy', 'uncertain', self.wall))
        self.assertEqual(tuple(self.reg.db.execute('SELECT * FROM dispatch').fetchone()),
                         ('sub', 'legacy', 'uncertain', self.wall))

    def test_historical_receipt_is_not_backfilled_on_restart(self):
        self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',
                            ('sub', 'legacy', 'webhook_accepted', self.wall))
        before = tuple(self.reg.db.execute('SELECT * FROM dispatch').fetchone())
        self.reg.db.close()
        self.reg = self.open()
        value = self.reg.transport_diagnostics()
        self.assertEqual(value['records_without_completion_observation'], 1)
        self.assertEqual(value['latest']['state'], 'not_recorded')
        self.assertIsNone(value['latest']['completed_at'])
        self.assertIsNone(value['latest']['sender_duration_ms'])
        self.assertEqual(tuple(self.reg.db.execute('SELECT * FROM dispatch').fetchone()), before)

    def test_optional_writer_is_immutable_and_cannot_create_an_orphan(self):
        out = self.dispatch()
        before = tuple(self.reg.db.execute('SELECT * FROM transport_observations').fetchone())
        self.reg.record_transport('sub', out['event_id'], 1, 9, self.wall+100, 503)
        self.reg.record_transport('sub', 'not_a_dispatch', 1, 9, self.wall, 200)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM transport_observations').fetchone()[0], 1)
        self.assertEqual(tuple(self.reg.db.execute('SELECT * FROM transport_observations').fetchone()), before)

    def test_projection_excludes_foreign_principal_and_identifiers(self):
        self.dispatch()
        self.reg.db.execute('INSERT INTO subscriptions SELECT ?,?,args,url,secret,old_secret,'
            'rotated_at,expires,verified,started,active FROM subscriptions WHERE id=?',
            ('foreign_sub', 'foreign_owner', 'sub'))
        self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',
                            ('foreign_sub', 'PRIVATE_SENTINEL', 'webhook_accepted', self.wall+1))
        self.reg.record_transport('foreign_sub', 'PRIVATE_SENTINEL', 1, 2, self.wall+2, 200)
        value = self.reg.transport_diagnostics()
        self.assertEqual(value['dispatch_records'], 1)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(value))
        self.assertNotIn('callback.example.org', json.dumps(value))

    def test_pruning_tracks_existing_receipt_lifecycle_without_removing_uncertain(self):
        for identity, state in [('old_accepted', 'webhook_accepted'), ('old_uncertain', 'uncertain')]:
            self.reg.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)',
                                ('sub', identity, state, self.wall-8*86400))
            self.reg.record_transport('sub', identity, 1, 2, self.wall-8*86400, 200)
        self.reg.prune()
        self.assertEqual([row[0] for row in self.reg.db.execute('SELECT event FROM dispatch')], ['old_uncertain'])
        self.assertEqual([row[0] for row in self.reg.db.execute('SELECT event FROM transport_observations')],
                         ['old_uncertain'])

    def test_process_loss_keeps_unknown_completion_and_no_retry(self):
        self.mode = 'crash'
        with self.assertRaises(SystemExit):
            self.dispatch()
        self.assertEqual(self.latest()['state'], 'not_recorded')
        self.reg.db.close()
        self.wall += 601
        self.reg = self.open()
        self.assertEqual(self.reg.dispatch_one()['state'], 'idle')
        self.assertEqual(len(self.calls), 1)

    def test_clock_capture_precedes_slow_dispatch_state_persistence(self):
        def slow_update(sql):
            if sql.startswith('UPDATE dispatch SET state='):
                self.wall += 3
                self.mono += 3
        self.reg.db = ConnectionProxy(self.reg.db, slow_update)
        self.dispatch()
        self.assertEqual(self.latest()['sender_duration_ms'], 125)
        self.assertEqual(self.latest()['completed_at'], registry.iso(1800000000.25))

    def test_invalid_completion_clock_stays_unknown_without_retry(self):
        self.mode = 'invalid_wall'
        self.assertEqual(self.dispatch()['state'], 'webhook_accepted')
        self.assertIsNone(self.latest()['completed_at'])
        self.assertEqual(self.latest()['sender_duration_ms'], 125)
        self.assertEqual(self.latest()['collection_error'], 'completion_clock_unavailable')
        self.assertEqual(len(self.calls), 1)

    def test_malformed_stored_metadata_fails_closed_without_export(self):
        self.dispatch()
        self.reg.db.execute("UPDATE transport_observations SET outcome='PRIVATE_SENTINEL'")
        value = self.reg.transport_diagnostics()
        self.assertEqual(value['state'], 'unknown')
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(value))


if __name__ == '__main__':
    unittest.main()
