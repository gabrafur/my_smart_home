"""Synthetic SQLite and source frames only; no callback or household access."""
import json
import os
from unittest.mock import patch
import test_worker_summary as fixture
import source_timing


class SourceTimingTests(fixture.WorkerSummaryTests):
    # Reuse fixture helpers, not its seven inherited test cases.
    test_engine_fresh_snapshot_drives_current_state_once = None
    test_removed_snapshot_reports_removed_not_recovered = None
    test_invalid_current_snapshot_no_enqueue_or_dispatch = None
    test_stale_or_failed_snapshot_never_dispatches_old_queue = None
    test_worker_uncertain_and_budget_persist_no_retry = None
    test_natural_batch_intent_before_sender = None
    test_archive_pressure_reports_a_blocker_without_sending = None

    def timed(self, index=0, phase='added', frame=None):
        event = self.event(index, phase)
        event['source_timing'] = {
            'schema_version': 1, 'frame_kind': frame or phase,
            'source_occurred_at': None if phase == 'removed' else self.iso(self.now - 0.4),
            'collector_received_at': self.iso(self.now - 0.1),
            'collector_observed_at': event['observed_at']}
        return event

    def ingest(self, *events):
        self.write(list(events))
        self.assertTrue(self.engine.ingest())
        return self.reg.status()['ha_notification_source_timing']

    def test_known_source_and_consumer_stages_are_separate(self):
        result = self.ingest(self.timed())
        self.assertEqual(result['measured_source_records'], 1)
        self.assertEqual(result['unknown_source_records'], 0)
        self.assertAlmostEqual(result['max_source_to_observation_wall_ms'], 400, places=3)
        body = json.loads(self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0])
        self.assertAlmostEqual(body['source_to_receive_wall_ms'], 300, places=3)
        self.assertAlmostEqual(body['receive_to_observation_wall_ms'], 100, places=3)
        self.assertFalse(result['all_HA_MQTT_latency_proven'])
        self.assertFalse(result['full24h_proven'])

    def test_absent_source_and_removal_remain_unknown(self):
        event = self.timed()
        event['source_timing']['source_occurred_at'] = None
        result = self.ingest(event, self.timed(1, 'removed'))
        self.assertEqual(result['unknown_source_records'], 2)
        self.assertEqual(result['unknown_reasons'], {
            'source_time_missing': 1, 'removal_source_time_unavailable': 1})
        self.assertIsNone(result['max_source_to_observation_wall_ms'])

    def test_reconnect_snapshot_is_not_a_live_receipt(self):
        result = self.ingest(self.timed(frame='current'))
        self.assertEqual(result['unknown_reasons'], {'snapshot_reconciliation': 1})
        self.assertEqual(result['measured_source_records'], 0)

    def test_private_or_malformed_metadata_is_not_persisted(self):
        event = self.timed()
        event['source_timing']['private'] = 'PRIVATE_SENTINEL'
        result = self.ingest(event)
        self.assertEqual(result['unknown_reasons'], {'metadata_invalid': 1})
        body = self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0]
        self.assertNotIn('PRIVATE_SENTINEL', body)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))

    def test_clock_reversal_is_not_clamped_to_zero(self):
        event = self.timed()
        event['source_timing']['source_occurred_at'] = self.iso(self.now + 1)
        result = self.ingest(event)
        self.assertEqual(result['unknown_reasons'], {'clock_order_unconfirmed': 1})
        self.assertIsNone(result['max_source_to_observation_wall_ms'])

    def test_duplicate_does_not_rewrite_first_receipt_or_event(self):
        event = self.timed()
        self.ingest(event)
        before = self.reg.db.execute('SELECT * FROM event_source_timing').fetchone()
        native = self.reg.db.execute('SELECT body FROM events').fetchone()[0]
        self.now += 2
        event['source_timing']['source_occurred_at'] = self.iso(self.now - 0.1)
        self.ingest(event)
        self.assertEqual(tuple(before), tuple(self.reg.db.execute('SELECT * FROM event_source_timing').fetchone()))
        self.assertEqual(native, self.reg.db.execute('SELECT body FROM events').fetchone()[0])

    def test_legacy_missing_metadata_is_not_backfilled(self):
        event = self.event()
        result = self.ingest(event)
        self.assertEqual(result['unknown_reasons'], {'metadata_missing': 1})
        self.ingest(self.timed())
        self.assertEqual(self.reg.source_timing.diagnostics(self.now)['unknown_reasons'], {'metadata_missing': 1})

    def test_ingestion_does_not_put_timing_in_signed_event_payload(self):
        self.write([self.timed()])
        self.engine.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn('source_timing', json.dumps(self.sent))
        self.assertEqual(self.reg.status()['attempts_last_24h'], 1)
        self.assertEqual(self.reg.status()['ha_notification_source_timing']['measured_source_records'], 1)

    def test_optional_store_failure_does_not_block_or_repeat_delivery(self):
        self.reg.db.execute("CREATE TRIGGER timing_failure BEFORE INSERT ON event_source_timing "
                            "BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
        self.write([self.timed()])
        self.engine.tick()
        self.engine.tick()
        self.assertEqual(len(self.sent), 1)
        result = self.reg.status()['ha_notification_source_timing']
        self.assertEqual(result['missing_timing_receipts'], 1)
        self.assertEqual(result['collection_error'], 'source_timing_record_unavailable')

    def test_capacity_preserves_events_and_old_receipts(self):
        with patch.object(source_timing, 'MAX_ROWS', 1):
            self.write([self.timed(0), self.timed(1)])
            self.engine.tick()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0], 2)
            self.assertEqual(self.reg.db.execute('SELECT count(*) FROM event_source_timing').fetchone()[0], 1)
            self.assertEqual(self.reg.source_timing.error, 'source_timing_capacity_reached')

    def test_restart_preserves_receipt_and_uncertain_intent(self):
        self.write([self.timed()])
        self.reg.sender = lambda *args: (_ for _ in ()).throw(TimeoutError('synthetic'))
        self.engine.tick()
        saved = self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0]
        self.reg.db.close()
        from registry import Registry
        from worker import Engine
        self.reg = Registry(self.tmp.name, 'test_owner', approved=True, sender=self.send, clock=lambda: self.now)
        self.engine = Engine(self.reg, os.getuid(), os.getuid(),
                             snapshot=self.snapshot, clock=lambda: self.now)
        self.now += 601
        self.write([self.timed()])
        self.engine.tick()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0], 'uncertain')
        self.assertEqual(saved, self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0])

    def test_corrupt_receipt_is_unknown_and_never_exports_its_fields(self):
        self.ingest(self.timed())
        self.reg.db.execute('UPDATE event_source_timing SET body=?',
                            (json.dumps({'reason': 'PRIVATE_SENTINEL', 'state': 'observed'}),))
        result = self.reg.source_timing.diagnostics(self.now)
        self.assertEqual(result['unknown_reasons'], {'persisted_timing_invalid': 1})
        self.assertEqual(result['measured_source_records'], 0)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))

    def test_receipt_survives_native_event_archive_without_replaying(self):
        self.write([self.timed()])
        self.engine.tick()
        saved = self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0]
        self.now += 86401
        self.reg.prune()
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM event_archive').fetchone()[0], 1)
        self.assertEqual(saved, self.reg.db.execute('SELECT body FROM event_source_timing').fetchone()[0])
        result = self.reg.source_timing.diagnostics(self.now)
        self.assertEqual(result['retained_event_records'], 0)
        self.assertIsNone(result['max_source_to_observation_wall_ms'])
        self.assertFalse(result['full24h_proven'])
        self.assertEqual(len(self.sent), 1)
