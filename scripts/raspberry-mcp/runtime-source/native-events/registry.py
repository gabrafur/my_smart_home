"""Bounded durable event engine for review. No CLI, no installed service.

Transport adapter must supply principal from the authenticated local tunnel,
never from JSON-RPC parameters. Application events contain only enumerations
and opaque identifiers. Ambiguous dispatch is retained, never retried.
"""
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
from delivery_summary import (group_events, make_batch, opportunity, VERSION,
    CADENCE_VERSION, MAXIMUM_ATTEMPTS_PER_DAY, MINIMUM_ATTEMPT_SPACING_SECONDS)
from source_timing import SourceTiming
from webhook import Refused, callback_parts, key_bytes, signed_headers, verify_callback, post

PROJECT = '/mnt/data/docker'
NAME = 'smart_home.observation'
TOPICS = {'ha_notification'}
PHASES = {'added', 'updated', 'removed'}
SOURCES = {'ha_persistent_notification'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def iso(timestamp):
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat()


def protocol_integer(value):
    # JSON Schema integer is a mathematical value, independent of 1 vs 1.0.
    return (type(value) is int and value >= 0
            or type(value) is float and value >= 0 and value.is_integer())


def filters(args):
    if (not isinstance(args, dict) or set(args) != {'project', 'topics'}
            or args['project'] != PROJECT or not isinstance(args['topics'], list)
            or not len(args['topics']) == 1
            or any(not isinstance(x, str) or x not in TOPICS for x in args['topics'])
            or len(set(args['topics'])) != len(args['topics'])):
        raise Refused('scope_refused')
    return {'project': PROJECT, 'topics': sorted(args['topics'])}


class Registry:
    def __init__(self, directory, principal, *, approved=False, sender=post,
                 clock=time.time, monotonic=time.monotonic):
        if not re.fullmatch(r'[a-z0-9_-]{1,64}', principal):
            raise Refused('principal_invalid')
        root = Path(directory)
        info = root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise Refused('unsafe_state_directory')
        db = root / 'events.sqlite3'
        if db.exists() or db.is_symlink():
            info = db.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                raise Refused('unsafe_state_file')
        else:
            fd = os.open(db, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        self.db = sqlite3.connect(db, timeout=2, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA max_page_count=4096')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS subscriptions(
          id TEXT PRIMARY KEY, owner TEXT, args TEXT, url TEXT, secret TEXT,
          old_secret TEXT, rotated_at REAL, expires REAL, verified REAL, started REAL, active INTEGER);
        CREATE TABLE IF NOT EXISTS events(
          id TEXT PRIMARY KEY, topic TEXT, body TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS dispatch(
          subscription TEXT, event TEXT, state TEXT, at REAL,
          PRIMARY KEY(subscription,event));
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value REAL);
        CREATE TABLE IF NOT EXISTS delivery_batches(
          id TEXT PRIMARY KEY, subscription TEXT, body TEXT, at REAL);
        CREATE TABLE IF NOT EXISTS delivery_members(
          subscription TEXT, event TEXT, batch TEXT,
          PRIMARY KEY(subscription,event));
        CREATE TABLE IF NOT EXISTS event_archive(
          id TEXT PRIMARY KEY, topic TEXT, body TEXT, created REAL,
          retired_at REAL, reason TEXT);
        ''')
        self.principal, self.approved, self.sender, self.clock = principal, approved, sender, clock
        self.monotonic = monotonic
        self.transport_observation_error = None
        try:
            self.db.execute('CREATE TABLE IF NOT EXISTS transport_observations('
                'subscription TEXT,event TEXT,completed_at REAL,sender_duration_ms REAL,'
                'outcome TEXT,collection_error TEXT,PRIMARY KEY(subscription,event))')
        except sqlite3.Error:
            self.transport_observation_error = 'transport_observation_schema_unavailable'
        self.high_clock = None
        self.current_evidence = None
        self.source_timing = SourceTiming(self.db)

    def now(self):
        now = self.clock()
        old = self.db.execute("SELECT value FROM meta WHERE key='clock'").fetchone()
        prior=max(old[0] if old else now,self.high_clock if self.high_clock is not None else now)
        if now < prior - 1:
            raise Refused('clock_reconciliation_required')
        self.high_clock=max(prior,now)
        # Persist the clock once per 30 seconds, not on every idle poll.
        # Dispatch intent, subscription and event transactions remain FULL sync.
        if not old or now-old[0]>=30:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES ('clock',?)", (now,))
        return now

    def identity(self, name, args, delivery):
        if name != NAME:
            raise Refused('event_refused')
        args = filters(args)
        if not isinstance(delivery, dict) or delivery.get('mode') != 'webhook':
            raise Refused('delivery_refused')
        callback_parts(delivery.get('url'))
        sid = hashlib.sha256(canonical([self.principal, name, args, delivery['url']]).encode()).hexdigest()
        return sid, args

    def subscription_diagnostics(self):
        row = self.db.execute("SELECT value FROM meta WHERE key='subscription_diagnostics'").fetchone()
        if row is None:
            return []
        value = row[0]
        if not isinstance(value,str) or len(value.encode()) > 8192:
            raise Refused('diagnostic_reconciliation_required')
        try:
            rows = json.loads(value)
            if not isinstance(rows,list) or len(rows) > 32:
                raise ValueError()
            for item in rows:
                if (not isinstance(item,dict) or set(item) != {'stage','code','observed_at'}
                        or item['stage'] not in {'received','validated','callback_verification','callback_verified','callback_cached','stored','refused'}
                        or type(item['code']) is not int or item['code'] not in {0,-32602,-32024,-32023,-32015,-32000}
                        or not isinstance(item['observed_at'],str) or len(item['observed_at']) > 40
                        or datetime.datetime.fromisoformat(item['observed_at']).tzinfo is None):
                    raise ValueError()
        except (ValueError,TypeError,KeyError):
            raise Refused('diagnostic_reconciliation_required') from None
        return rows

    def note_subscription(self, stage, code):
        rows = self.subscription_diagnostics()
        rows.append({'stage':stage, 'code':code, 'observed_at':iso(self.clock())})
        data = canonical(rows[-32:])
        if len(data.encode()) > 8192:
            raise Refused('diagnostic_reconciliation_required')
        self.db.execute("INSERT OR REPLACE INTO meta VALUES('subscription_diagnostics',?)", (data,))

    def subscribe(self, params):
        # Only fixed stage/code/time fields enter this bounded private ring.
        self.note_subscription('received', 0)
        try:
            return self._subscribe(params)
        except Exception as error:
            reason = str(error) if isinstance(error,Refused) else ''
            invalid = {'invalid_params','invalid_delivery','invalid_delivery_or_cursor','invalid_ttl','invalid_signing_key','invalid_callback'}
            code = (-32602 if reason in invalid else -32024 if reason in {'scope_refused','peer_refused','activation_not_approved'}
                    else -32023 if reason == 'event_refused' else -32015 if reason == 'challenge_failed' else -32000)
            self.note_subscription('refused', code)
            raise

    def _subscribe(self, params):
        if not self.approved:
            raise Refused('activation_not_approved')
        if not isinstance(params, dict) or set(params) - {'name','arguments','delivery','cursor','ttlMs','maxAgeMs','_meta'}:
            raise Refused('invalid_params')
        if '_meta' in params and not isinstance(params['_meta'], dict):
            raise Refused('invalid_params')
        # No replay: validate the optional protocol field, then ignore it.
        if 'maxAgeMs' in params and not protocol_integer(params['maxAgeMs']):
            raise Refused('invalid_params')
        sid, args = self.identity(params.get('name'), params.get('arguments'), params.get('delivery'))
        delivery = params['delivery']
        if set(delivery) != {'mode','url','secret'} or params.get('cursor') is not None:
            raise Refused('invalid_delivery_or_cursor')
        key_bytes(delivery['secret'])
        ttl = params.get('ttlMs', 86400000)
        if ttl is None:
            ttl = 86400000
        if not protocol_integer(ttl):
            raise Refused('invalid_ttl')
        now = self.now()
        expires = now + min(ttl, 86400000) / 1000
        old = self.db.execute('SELECT * FROM subscriptions WHERE id=?', (sid,)).fetchone()
        if self.db.execute('SELECT count(*) FROM subscriptions WHERE active=1 AND expires>? AND id!=?',(now,sid)).fetchone()[0] >= 1 or (not old and self.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0] >= 8):
            raise Refused('subscription_limit')
        self.note_subscription('validated', 0)
        if not old or not old['active'] or old['secret'] != delivery['secret'] or now-old['verified'] > 300:
            self.note_subscription('callback_verification', 0)
            verify_callback(delivery['url'], delivery['secret'], sid, self.sender, self.clock)
            self.note_subscription('callback_verified', 0)
            verified = now
        else:
            self.note_subscription('callback_cached', 0)
            verified = old['verified']
        rotated = bool(old and old['secret'] != delivery['secret'])
        old_key = old['secret'] if rotated else (old['old_secret'] if old else None)
        rotated_at = now if rotated else (old['rotated_at'] if old else 0)
        started = old['started'] if old and old['active'] else now
        self.db.execute('INSERT OR REPLACE INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,1)',
                        (sid,self.principal,canonical(args),delivery['url'],delivery['secret'],old_key,
                         rotated_at,expires,verified,started))
        self.note_subscription('stored', 0)
        return {'id':sid,'refreshBefore':iso(expires),'cursor':None,'truncated':False}

    def unsubscribe(self, params):
        required = {'name','arguments','delivery'}
        if (not isinstance(params,dict) or not required <= set(params)
                or set(params) - required - {'_meta'}
                or '_meta' in params and not isinstance(params['_meta'],dict)):
            raise Refused('invalid_params')
        delivery = params['delivery']
        if not isinstance(delivery,dict) or set(delivery) not in ({'url'}, {'mode','url'}):
            raise Refused('invalid_delivery')
        delivery = {'mode':'webhook', **delivery}
        sid, _ = self.identity(params['name'], params['arguments'], delivery)
        self.db.execute("UPDATE subscriptions SET active=0,secret='',old_secret=NULL WHERE id=? AND owner=?",(sid,self.principal))
        return {}

    def enqueue(self, topic, source, phase, object_id, revision, occurred_at):
        if (topic not in TOPICS or source not in SOURCES or phase not in PHASES
                or any(not isinstance(v,str) or not re.fullmatch(r'[a-f0-9]{64}',v) for v in (object_id,revision))):
            raise Refused('unsafe_event')
        now = self.clock()
        if type(occurred_at) not in (int,float) or not now-86400 <= occurred_at <= now+1:
            raise Refused('invalid_event_time')
        data = {'project':PROJECT,'topic':topic,'source':source,'phase':phase,
                'object_id':object_id,'revision':revision}
        eid = hashlib.sha256(canonical(data).encode()).hexdigest()
        if self.db.execute('SELECT 1 FROM events WHERE id=? UNION ALL SELECT 1 FROM event_archive WHERE id=?',(eid,eid)).fetchone():
            return {'id':eid,'duplicate':True}
        # Fail closed when full; never remove uncertain receipts to permit retries.
        if self.db.execute('SELECT count(*) FROM events').fetchone()[0] >= 256:
            raise Refused('event_storage_full')
        body = canonical({'eventId':eid,'name':NAME,'timestamp':iso(occurred_at),'data':data,'cursor':None})
        self.now()
        self.db.execute('INSERT INTO events VALUES(?,?,?,?)',(eid,topic,body,occurred_at))
        return {'id':eid,'duplicate':False}

    def prune(self):
        now=self.now()
        # No uncertain dispatch receipt is ever deleted or made retryable.
        self.db.execute("UPDATE subscriptions SET active=0,secret='',old_secret=NULL WHERE expires<=? AND (active=1 OR secret!='')",(now,))
        self.db.execute("DELETE FROM dispatch WHERE state IN ('webhook_accepted','delivery_refused') AND at<?",(now-7*86400,))
        try:
            self.db.execute('DELETE FROM transport_observations WHERE NOT EXISTS '
                            '(SELECT 1 FROM dispatch d WHERE d.subscription=transport_observations.subscription '
                            'AND d.event=transport_observations.event)')
        except sqlite3.Error:
            self.transport_observation_error = 'transport_observation_prune_failed'
        # Archive, never silently discard old undelivered transitions. An archive
        # cap stops collection/delivery instead of losing history or resetting IDs.
        self.db.execute('BEGIN IMMEDIATE')
        try:
            rows = self.db.execute("SELECT * FROM events e WHERE created<? AND NOT EXISTS(SELECT 1 FROM dispatch d WHERE d.event=e.id) AND NOT EXISTS(SELECT 1 FROM delivery_members m JOIN dispatch d ON d.subscription=m.subscription AND d.event=m.batch WHERE m.event=e.id AND d.state='uncertain')", (now-86400,)).fetchall()
            count = self.db.execute('SELECT count(*) FROM event_archive').fetchone()[0]
            if count+len(rows) > 4096:
                raise Refused('event_history_archive_full')
            for row in rows:
                covered = self.db.execute('SELECT 1 FROM delivery_members WHERE event=?', (row['id'],)).fetchone()
                self.db.execute('INSERT INTO event_archive VALUES(?,?,?,?,?,?)',
                                (row['id'],row['topic'],row['body'],row['created'],now,
                                 'covered_by_summary' if covered else 'eligibility_window_elapsed'))
                self.db.execute('DELETE FROM events WHERE id=?', (row['id'],))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def event_counts(self, now):
        """Read-only snapshot of retained rows and the dispatcher's eligible work."""
        retained = pending = None
        error = None
        self.db.execute('SAVEPOINT event_count_observation')
        try:
            retained = self.db.execute('SELECT count(*) FROM events').fetchone()[0]
            active = self.db.execute('SELECT id,args,started FROM subscriptions WHERE active=1 AND expires>? AND owner=?',
                                     (now, self.principal)).fetchall()
            if len(active) > 1:
                raise ValueError('subscription_scope_unconfirmed')
            pending = 0
            for sub in active:
                allowed = filters(json.loads(sub['args']))['topics']
                started = sub['started']
                if type(started) not in (int, float) or not 0 <= started <= now:
                    raise ValueError('subscription_time_unconfirmed')
                placeholders = ','.join('?' for _ in allowed)
                pending = self.db.execute(
                    'SELECT count(*) FROM events e WHERE e.created>=? AND e.topic IN (' + placeholders +
                    ') AND NOT EXISTS (SELECT 1 FROM dispatch d WHERE d.subscription=? AND d.event=e.id) AND NOT EXISTS (SELECT 1 FROM delivery_members m WHERE m.subscription=? AND m.event=e.id)',
                    (max(now-86400, started), *allowed, sub['id'], sub['id'])).fetchone()[0]
        except (ValueError, TypeError, KeyError, sqlite3.Error):
            pending = None
            error = 'event_count_scope_or_collection_unconfirmed'
        finally:
            self.db.execute('RELEASE event_count_observation')
        return {'retained_event_records': retained, 'eligible_pending_event_records': pending,
                'queued_event_records': pending,
                'queued_event_records_semantics': 'eligible_pending_current_active_principal',
                'event_count_collection_error': error,
                'event_count_coverage': ['retained_all_event_rows',
                    'pending_active_same_principal_topic_last24h_and_subscription_start',
                    'existing_dispatch_intents_excluded_regardless_of_outcome',
                    'budget_and_assistant_execution_are_separate']}

    @staticmethod
    def observation_clock(clock):
        # Optional evidence must never prevent or repeat an admitted delivery.
        try:
            value = clock()
            return float(value) if type(value) in (int, float) and math.isfinite(value) else None
        except Exception:
            return None

    def record_transport(self, subscription, event, started, ended, completed, status):
        duration = ((ended-started)*1000 if started is not None and ended is not None
                    and ended >= started else None)
        if duration is not None and not math.isfinite(duration):
            duration = None
        if completed is not None and not 0 <= completed <= 253402300799:
            completed = None
        error = ('sender_duration_unavailable' if duration is None else
                 'completion_clock_unavailable' if completed is None else None)
        outcome = ('response_2xx' if type(status) is int and 200 <= status < 300 else
                   'response_non2xx' if type(status) is int and 100 <= status <= 599 else
                   'outcome_unknown')
        try:
            # The dispatch intent already exists; this table cannot make an
            # event eligible, change its state, or overwrite earlier evidence.
            self.db.execute('INSERT OR IGNORE INTO transport_observations '
                            'SELECT ?,?,?,?,?,? WHERE EXISTS '
                            '(SELECT 1 FROM dispatch WHERE subscription=? AND event=?)',
                            (subscription, event, completed,
                             round(duration, 3) if duration is not None else None, outcome, error,
                             subscription, event))
            self.transport_observation_error = None
        except (sqlite3.Error, ValueError, TypeError, OverflowError):
            self.transport_observation_error = 'transport_observation_write_failed'

    def transport_diagnostics(self):
        try:
            counts = self.db.execute('SELECT count(*),count(t.event),'
                "sum(CASE WHEN typeof(t.completed_at) IN ('real','integer') AND t.completed_at>=d.at "
                "AND typeof(t.sender_duration_ms) IN ('real','integer') AND t.sender_duration_ms>=0 "
                "AND t.outcome IN ('response_2xx','response_non2xx','outcome_unknown') "
                'AND t.collection_error IS NULL '
                'THEN 1 ELSE 0 END) FROM dispatch d JOIN subscriptions s ON s.id=d.subscription '
                'LEFT JOIN transport_observations t ON t.subscription=d.subscription AND t.event=d.event '
                'WHERE s.owner=?', (self.principal,)).fetchone()
            row = self.db.execute('SELECT d.at,t.event IS NOT NULL AS recorded,t.completed_at,'
                't.sender_duration_ms,t.outcome,t.collection_error FROM dispatch d '
                'JOIN subscriptions s ON s.id=d.subscription LEFT JOIN transport_observations t '
                'ON t.subscription=d.subscription AND t.event=d.event WHERE s.owner=? '
                'ORDER BY d.at DESC,d.event DESC LIMIT 1', (self.principal,)).fetchone()
            latest = None
            if row is not None:
                if row['recorded']:
                    if (row['outcome'] not in ('response_2xx', 'response_non2xx', 'outcome_unknown') or
                            row['collection_error'] not in
                            (None, 'sender_duration_unavailable', 'completion_clock_unavailable') or
                            any(value is not None and
                                (type(value) not in (int, float) or not math.isfinite(value) or value < 0)
                                for value in (row['completed_at'], row['sender_duration_ms']))):
                        raise ValueError('invalid_transport_observation')
                error = row['collection_error'] if row['recorded'] else 'completion_not_recorded'
                ordered = None if row['completed_at'] is None else row['completed_at'] >= row['at']
                if ordered is False:
                    error = 'wall_clock_reconciliation_required'
                latest = {'state': 'not_recorded' if not row['recorded'] else
                          'partial' if error else 'recorded',
                          'intent_at': iso(row['at']),
                          'completed_at': None if row['completed_at'] is None else iso(row['completed_at']),
                          'sender_duration_ms': row['sender_duration_ms'],
                          'wall_clock_ordered': ordered, 'outcome': row['outcome'],
                          'collection_error': error}
            return {'schema_version': 1, 'state': 'observed',
                    'collection_error': self.transport_observation_error,
                    'dispatch_records': counts[0], 'observation_records': counts[1],
                    'complete_timing_records': counts[2] or 0,
                    'records_without_completion_observation': counts[0]-counts[1],
                    'latest': latest,
                    'coverage': ['same_principal_only', 'sender_call_only_excludes_queue_and_persistence',
                                 'monotonic_duration_and_wall_clock_completion',
                                 'missing_historical_completion_stays_unknown',
                                 'not_assistant_processing_or_end_to_end_latency']}
        except (sqlite3.Error, ValueError, TypeError, OverflowError):
            return {'schema_version': 1, 'state': 'unknown',
                    'collection_error': 'transport_observation_collection_unconfirmed',
                    'dispatch_records': None, 'observation_records': None,
                    'complete_timing_records': None,
                    'records_without_completion_observation': None, 'latest': None}

    def status(self):
        try:
            diagnostics = self.subscription_diagnostics()
            diagnostic_error = None
        except Refused:
            diagnostics = []
            diagnostic_error = 'diagnostic_reconciliation_required'
        now=self.clock()
        lease=self.db.execute('SELECT id,started,expires,active FROM subscriptions WHERE owner=? ORDER BY (active=1 AND expires>?) DESC,expires DESC,id LIMIT 1',(self.principal,now)).fetchone()
        lease_metadata=None if lease is None else {
            'subscription_id_sha256':hashlib.sha256(lease['id'].encode()).hexdigest(),
            'started_at':iso(lease['started']),'expires_at':iso(lease['expires']),
            'state':'active' if lease['active'] and lease['expires']>now else 'expired' if lease['expires']<=now else 'inactive',
            'coverage':['existing_same_principal_lease_only','expiry_advance_requires_two_observations','not_callback_verified_or_key_rotated_time']}
        states={row[0]:row[1] for row in self.db.execute('SELECT state,count(*) FROM dispatch GROUP BY state')}
        return {'source':'persistent_mcp_event_delivery','observed_at':iso(now),
                'subscription_lease':lease_metadata,
                'active_subscriptions':self.db.execute('SELECT count(*) FROM subscriptions WHERE active=1 AND expires>?',(now,)).fetchone()[0],
                **self.event_counts(now), **self.delivery_diagnostics(now),
                'webhook_transport_timing': self.transport_diagnostics(),
                'ha_notification_source_timing': self.source_timing.diagnostics(now),
                'dispatch_states':states,'attempts_last_24h':self.db.execute('SELECT count(*) FROM dispatch WHERE at>?',(now-86400,)).fetchone()[0],
                'delivery_cadence_version':CADENCE_VERSION,
                'maximum_attempts_per_day':MAXIMUM_ATTEMPTS_PER_DAY,
                'minimum_attempt_spacing_seconds':MINIMUM_ATTEMPT_SPACING_SECONDS,
                'assistant_run_confirmed':False,'automatic_retry':False,
                'subscription_attempts':diagnostics,'subscription_diagnostic_error':diagnostic_error,
                'subscription_diagnostic_coverage':['worker_received_only','not_platform_or_frontend_arrival','last_32_stages_max_8192_bytes'],
                'coverage':['webhook_acceptance_not_assistant_execution','no_private_callback_or_key_export','uncertain_receipts_preserved']}

    def observe_current(self, notifications, observed_at):
        now = self.clock()
        if (not isinstance(notifications,list) or len(notifications)>512
                or type(observed_at) not in (int,float) or not 0<=now-observed_at<=15):
            raise Refused('summary_current_evidence_unconfirmed')
        current = {}
        for item in notifications:
            if (not isinstance(item,dict) or any(not isinstance(item.get(k),str)
                    or not re.fullmatch('[a-f0-9]{64}',item[k]) for k in ('id','revision'))
                    or item['id'] in current):
                raise Refused('summary_current_evidence_unconfirmed')
            current[item['id']]=item['revision']
        self.current_evidence = (observed_at,current)

    def summary_plan(self, now):
        active=self.db.execute('SELECT * FROM subscriptions WHERE active=1 AND expires>? AND owner=?', (now,self.principal)).fetchall()
        if len(active)>1:
            raise Refused('summary_subscription_scope_unconfirmed')
        if not active:
            return None, [], []
        sub=active[0]
        allowed=filters(json.loads(sub['args']))['topics']
        if type(sub['started']) not in (int,float) or not 0<=sub['started']<=now:
            raise Refused('summary_subscription_scope_unconfirmed')
        marks=','.join('?' for _ in allowed)
        rows=self.db.execute('SELECT e.* FROM events e WHERE e.created>=? AND e.topic IN ('+marks+') AND NOT EXISTS(SELECT 1 FROM dispatch d WHERE d.subscription=? AND d.event=e.id) AND NOT EXISTS(SELECT 1 FROM delivery_members m WHERE m.subscription=? AND m.event=e.id) ORDER BY e.created,e.id',
                             (max(now-86400,sub['started']),*allowed,sub['id'],sub['id'])).fetchall()
        evidence=self.current_evidence
        current=evidence[1] if evidence and 0<=now-evidence[0]<=15 else None
        return sub, rows, group_events(rows,now,current)

    def delivery_diagnostics(self, now):
        self.db.execute('SAVEPOINT delivery_observation')
        try:
            sub,rows,groups=self.summary_plan(now)
            times=[r[0] for r in self.db.execute('SELECT at FROM dispatch WHERE at>?',(now-86400,))]
            upcoming=opportunity(times,now,sub['expires'] if sub else None,len(rows))
            archived=self.db.execute('SELECT reason,count(*) FROM event_archive GROUP BY reason').fetchall()
            batches=self.db.execute('SELECT count(*) FROM delivery_batches').fetchone()[0]
            members=self.db.execute('SELECT count(*) FROM delivery_members').fetchone()[0]
            return {'delivery_summary_version':VERSION,
                    'delivery_queue':{'state':'observed','collection_error':None,
                      'eligible_event_records':len(rows),'notification_groups':len(groups),
                      'revisions_coalescible':len(rows)-len(groups),
                      'oldest_eligible_at':iso(min(r['created'] for r in rows)) if rows else None,
                      'oldest_eligible_age_seconds':round(now-min(r['created'] for r in rows),3) if rows else None,
                      'newest_eligible_at':iso(max(r['created'] for r in rows)) if rows else None,
                      'ordering':'current_then_latest_change_desc_no_severity_inferred',
                      'max_groups_per_delivery':8,'durable_summary_batches':batches,
                      'durable_covered_event_records':members,
                      'covered_revisions_coalesced':members-sum(len(json.loads(r[0])['data']['notifications']) for r in self.db.execute('SELECT body FROM delivery_batches')),
                      'archived_event_records':sum(r[1] for r in archived),
                      'archive_reasons':{r[0]:r[1] for r in archived},
                      'history_archive_limit':4096,'archive_full_behavior':'fail_closed_no_silent_discard',
                      'existing_intents_excluded_including_uncertain':True},
                    'delivery_opportunity':upcoming}
        except (ValueError,TypeError,KeyError,sqlite3.Error,OverflowError):
            return {'delivery_summary_version':VERSION,
                    'delivery_queue':{'state':'unknown','collection_error':'summary_scope_or_collection_unconfirmed'},
                    'delivery_opportunity':{'state':'unknown','collection_error':'delivery_opportunity_unconfirmed'}}
        finally:
            self.db.execute('RELEASE delivery_observation')

    def dispatch_one(self):
        if not self.approved:
            raise Refused('activation_not_approved')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            now=self.now()
            recent=self.db.execute('SELECT count(*),max(at) FROM dispatch WHERE at>?',(now-86400,)).fetchone()
            if recent[0]>=MAXIMUM_ATTEMPTS_PER_DAY or recent[1] is not None and now-recent[1]<MINIMUM_ATTEMPT_SPACING_SECONDS:
                self.db.execute('COMMIT')
                return {'state':'budget_held'}
            sub,rows,groups=self.summary_plan(now)
            evidence=self.current_evidence
            at=iso(evidence[0]) if evidence and 0<=now-evidence[0]<=15 else None
            batch=make_batch(groups,sub['id'],now,at) if sub else None
            if not batch:
                self.db.execute('COMMIT')
                return {'state':'idle'}
            identity,body,members=batch
            self.db.execute('INSERT INTO delivery_batches VALUES(?,?,?,?)',(identity,sub['id'],body,now))
            for member in members:
                self.db.execute('INSERT INTO delivery_members VALUES(?,?,?)',(sub['id'],member,identity))
            self.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(sub['id'],identity,now))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        # Batch body and ALL memberships were durably committed before any I/O.
        # A lost reply never makes any covered revision eligible for another send.
        raw=body.encode()
        old=sub['old_secret'] if now-sub['rotated_at']<300 else None
        headers=signed_headers(sub['secret'],identity,raw,int(now),sub['id'],old)
        started = self.observation_clock(self.monotonic)
        ended = completed = response_status = None
        sender_returned = False
        try:
            status,_=self.sender(sub['url'],headers,raw)
            sender_returned = True
            ended = self.observation_clock(self.monotonic)
            completed = self.observation_clock(self.clock)
            response_status = status
            state='webhook_accepted' if 200<=status<300 else 'delivery_refused'
            self.db.execute('UPDATE dispatch SET state=? WHERE subscription=? AND event=?',(state,sub['id'],identity))
            if status in (401,403,410):
                self.db.execute('UPDATE subscriptions SET active=0 WHERE id=?',(sub['id'],))
        except Exception:
            state='uncertain'
        if not sender_returned:
            ended = self.observation_clock(self.monotonic)
            completed = self.observation_clock(self.clock)
        self.record_transport(sub['id'], identity, started, ended, completed, response_status)
        return {'event_id':identity,'state':state,'covered_event_records':len(members),
                'delivery_kind':VERSION,'assistant_run_confirmed':False,'automatic_retry':False}
