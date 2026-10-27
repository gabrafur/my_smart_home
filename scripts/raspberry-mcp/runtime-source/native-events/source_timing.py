"""Closed optional receipts; event identities, payloads and admission are unchanged."""
import datetime
import json
import math
import re
import sqlite3

MAX_ROWS = 4352  # Existing live-event and archive bounds combined.
PHASES = frozenset(('added', 'updated', 'removed'))
FRAMES = frozenset(('current', 'added', 'updated', 'removed'))
REASONS = frozenset(('observed', 'metadata_missing', 'metadata_invalid',
                    'source_time_missing', 'removal_source_time_unavailable',
                    'snapshot_reconciliation', 'clock_order_unconfirmed'))
INPUT_FIELDS = frozenset(('schema_version', 'frame_kind', 'source_occurred_at',
                         'collector_received_at', 'collector_observed_at'))
FIELDS = frozenset(('schema_version', 'phase', 'state', 'reason', 'frame_kind',
                   'source_occurred_at', 'collector_received_at', 'collector_observed_at',
                   'ingested_at', 'source_to_receive_wall_ms', 'source_to_observation_wall_ms',
                   'receive_to_observation_wall_ms', 'observation_to_ingest_wall_ms'))


def iso(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()


def stamp(value):
    if (type(value) is not str or re.fullmatch(r'[0-9TZ:.+\-]{20,40}', value) is None):
        raise ValueError('invalid_timing_timestamp')
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or not math.isfinite(parsed.timestamp()) or parsed.timestamp() < 0:
        raise ValueError('invalid_timing_timestamp')
    return parsed.timestamp()


def empty(phase, ingested, reason):
    row = dict.fromkeys(FIELDS)
    row.update(schema_version=1, phase=phase if phase in PHASES else None,
               state='unknown', reason=reason, ingested_at=iso(ingested))
    return row


def project(value, phase, observed, ingested):
    """Invalid values become unknown without retaining arbitrary input fields."""
    if value is None:
        return empty(phase, ingested, 'metadata_missing')
    try:
        if (type(value) is not dict or set(value) != INPUT_FIELDS
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or type(value['frame_kind']) is not str or value['frame_kind'] not in FRAMES
                or phase not in PHASES):
            raise ValueError('invalid_timing_metadata')
        received = stamp(value['collector_received_at'])
        reduced = stamp(value['collector_observed_at'])
        if abs(reduced - observed) > 1e-6:
            raise ValueError('unmatched_event_observation')
        source = stamp(value['source_occurred_at']) if value['source_occurred_at'] is not None else None
        if phase == 'removed' and source is not None:
            raise ValueError('removal_has_no_source_timestamp')
        row = empty(phase, ingested, 'source_time_missing')
        row.update(frame_kind=value['frame_kind'],
                   source_occurred_at=iso(source) if source is not None else None,
                   collector_received_at=iso(received), collector_observed_at=iso(reduced))
        if received > reduced or reduced > ingested or source is not None and source > received:
            row['reason'] = 'clock_order_unconfirmed'
            return row
        row['receive_to_observation_wall_ms'] = round((reduced - received) * 1000, 3)
        row['observation_to_ingest_wall_ms'] = round((ingested - reduced) * 1000, 3)
        if source is not None:
            row['source_to_receive_wall_ms'] = round((received - source) * 1000, 3)
            row['source_to_observation_wall_ms'] = round((reduced - source) * 1000, 3)
        if value['frame_kind'] == 'current':
            row['reason'] = 'snapshot_reconciliation'
        elif phase == 'removed':
            row['reason'] = 'removal_source_time_unavailable'
        elif source is not None:
            row.update(state='observed', reason='observed')
        return row
    except (ValueError, TypeError, KeyError, OverflowError):
        return empty(phase, ingested, 'metadata_invalid')


class SourceTiming:
    def __init__(self, db):
        self.db, self.error = db, None
        try:
            db.execute('CREATE TABLE IF NOT EXISTS event_source_timing('
                       'event TEXT PRIMARY KEY,first_ingested REAL,body TEXT)')
        except sqlite3.Error:
            self.error = 'source_timing_schema_unavailable'

    def record(self, event_id, value, phase, observed, ingested):
        """One immutable receipt; observation failure never blocks a dispatch."""
        if self.error == 'source_timing_schema_unavailable':
            return False
        try:
            if self.db.execute('SELECT 1 FROM event_source_timing WHERE event=?', (event_id,)).fetchone():
                return False
            if self.db.execute('SELECT count(*) FROM event_source_timing').fetchone()[0] >= MAX_ROWS:
                self.error = 'source_timing_capacity_reached'
                return False
            body = json.dumps(project(value, phase, observed, ingested), sort_keys=True, separators=(',', ':'))
            self.db.execute('INSERT INTO event_source_timing VALUES(?,?,?)', (event_id, ingested, body))
            return True
        except (sqlite3.Error, ValueError, TypeError, OverflowError):
            self.error = 'source_timing_record_unavailable'
            return False

    def record_many(self, rows):
        """One optional fsync for a snapshot; core events were committed first."""
        if self.error == 'source_timing_schema_unavailable':
            return
        try:
            self.db.execute('SAVEPOINT source_timing_snapshot')
            for row in rows:
                self.record(*row)
            self.db.execute('RELEASE source_timing_snapshot')
        except sqlite3.Error:
            try:
                self.db.execute('ROLLBACK TO source_timing_snapshot')
                self.db.execute('RELEASE source_timing_snapshot')
            except sqlite3.Error:
                pass
            self.error = 'source_timing_record_unavailable'

    def diagnostics(self, now):
        out = {'schema_version': 1, 'source': 'retained_HA_notification_source_timing',
               'state': 'unknown', 'collection_error': self.error,
               'window_start': iso(now - 86400), 'window_end': iso(now),
               'retained_event_records': None, 'timing_receipts': None,
               'measured_source_records': None, 'unknown_source_records': None,
               'missing_timing_receipts': None, 'unknown_reasons': {},
               'max_source_to_observation_wall_ms': None,
               'reported_source_to_observation_over_10s': None,
               'all_HA_MQTT_latency_proven': False, 'full24h_proven': False,
               'assistant_execution_proven': False,
               'coverage': ['same_retained_event_identity_only', 'first_timing_receipt_immutable',
                            'HA_create_update_source_UTC_not_removal_time',
                            'wall_clock_differences_not_monotonic_source_bounds',
                            'snapshot_reconciliation_not_live_event_receipt',
                            'missing_history_not_backfilled',
                            'not_MQTT_notification_delivery_or_assistant_execution']}
        try:
            rows = self.db.execute('WITH scope AS ('
                'SELECT id FROM events WHERE created>=? AND created<=? UNION '
                'SELECT id FROM event_archive WHERE created>=? AND created<=?) '
                'SELECT t.body FROM scope s LEFT JOIN event_source_timing t ON t.event=s.id LIMIT ?',
                (now - 86400, now, now - 86400, now, MAX_ROWS + 1)).fetchall()
            if len(rows) > MAX_ROWS:
                raise ValueError('timing_scope_capacity')
            reasons, measured, missing, receipts, values = {}, 0, 0, 0, []
            for saved in rows:
                if saved[0] is None:
                    missing += 1
                    reason = 'timing_receipt_missing'
                else:
                    receipts += 1
                    try:
                        if type(saved[0]) is not str or len(saved[0]) > 2048:
                            raise ValueError('invalid_receipt')
                        row = json.loads(saved[0])
                        if (type(row) is not dict or set(row) != FIELDS
                                or type(row['schema_version']) is not int or row['schema_version'] != 1
                                or row['phase'] not in PHASES or row['state'] not in ('observed', 'unknown')
                                or row['reason'] not in REASONS):
                            raise ValueError('invalid_receipt')
                        for field in FIELDS:
                            if field.endswith('_wall_ms') and row[field] is not None and (
                                    type(row[field]) not in (int, float)
                                    or not math.isfinite(row[field]) or row[field] < 0):
                                raise ValueError('invalid_receipt')
                        ingested = stamp(row['ingested_at'])
                        if row['reason'] in ('metadata_missing', 'metadata_invalid'):
                            rebuilt = empty(row['phase'], ingested, row['reason'])
                        else:
                            inputs = {field: row[field] for field in INPUT_FIELDS}
                            rebuilt = project(inputs, row['phase'], stamp(row['collector_observed_at']), ingested)
                        if rebuilt != row:
                            raise ValueError('inconsistent_receipt')
                        value = row['source_to_observation_wall_ms']
                        if row['state'] == 'observed':
                            if (row['reason'] != 'observed' or type(value) not in (int, float)
                                    or not math.isfinite(value) or value < 0):
                                raise ValueError('invalid_receipt')
                            measured += 1
                            values.append(value)
                            continue
                        reason = row['reason']
                    except (ValueError, TypeError, KeyError):
                        reason = 'persisted_timing_invalid'
                reasons[reason] = reasons.get(reason, 0) + 1
            out.update(state='observed', retained_event_records=len(rows), timing_receipts=receipts,
                       measured_source_records=measured, unknown_source_records=len(rows) - measured,
                       missing_timing_receipts=missing, unknown_reasons=reasons,
                       max_source_to_observation_wall_ms=max(values, default=None),
                       reported_source_to_observation_over_10s=sum(v > 10000 for v in values))
        except (sqlite3.Error, ValueError, TypeError, OverflowError):
            out['collection_error'] = self.error or 'source_timing_collection_unavailable'
        return out
