"""Bounded durable event engine for review. No CLI, no installed service.

Transport adapter must supply principal from the authenticated local tunnel,
never from JSON-RPC parameters. Application events contain only enumerations
and opaque identifiers. Ambiguous dispatch is retained, never retried.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
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
    def __init__(self, directory, principal, *, approved=False, sender=post, clock=time.time):
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
        ''')
        self.principal, self.approved, self.sender, self.clock = principal, approved, sender, clock
        self.high_clock = None

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
        if self.db.execute('SELECT 1 FROM events WHERE id=?',(eid,)).fetchone():
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
        self.db.execute("DELETE FROM events WHERE created<? AND NOT EXISTS(SELECT 1 FROM dispatch WHERE dispatch.event=events.id)",(now-86400,))

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
                    ') AND NOT EXISTS (SELECT 1 FROM dispatch d WHERE d.subscription=? AND d.event=e.id)',
                    (max(now-86400, started), *allowed, sub['id'])).fetchone()[0]
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
                **self.event_counts(now),
                'dispatch_states':states,'attempts_last_24h':self.db.execute('SELECT count(*) FROM dispatch WHERE at>?',(now-86400,)).fetchone()[0],
                'maximum_attempts_per_day':6,'minimum_attempt_spacing_seconds':600,
                'assistant_run_confirmed':False,'automatic_retry':False,
                'subscription_attempts':diagnostics,'subscription_diagnostic_error':diagnostic_error,
                'subscription_diagnostic_coverage':['worker_received_only','not_platform_or_frontend_arrival','last_32_stages_max_8192_bytes'],
                'coverage':['webhook_acceptance_not_assistant_execution','no_private_callback_or_key_export','uncertain_receipts_preserved']}

    def dispatch_one(self):
        if not self.approved:
            raise Refused('activation_not_approved')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            now = self.now()
            recent = self.db.execute('SELECT count(*),max(at) FROM dispatch WHERE at>?',(now-86400,)).fetchone()
            # Six attempts per rolling day, including uncertain/failed requests.
            if recent[0] >= 6 or (recent[1] is not None and now-recent[1] < 600):
                self.db.execute('COMMIT')
                return {'state':'budget_held'}
            chosen = None
            for sub in self.db.execute('SELECT * FROM subscriptions WHERE active=1 AND expires>? AND owner=?',(now,self.principal)):
                topics=json.loads(sub['args'])['topics']
                for event in self.db.execute('SELECT * FROM events WHERE created>=? ORDER BY created,id',(max(now-86400,sub['started']),)):
                    if event['topic'] in topics and not self.db.execute('SELECT 1 FROM dispatch WHERE subscription=? AND event=?',(sub['id'],event['id'])).fetchone():
                        chosen=(sub,event);break
                if chosen:break
            if not chosen:
                self.db.execute('COMMIT');return {'state':'idle'}
            sub,event=chosen
            self.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(sub['id'],event['id'],now))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK');raise
        # Once intent is durable, a crash or exception prevents automatic repeat.
        body=event['body'].encode()
        old=sub['old_secret'] if now-sub['rotated_at'] < 300 else None
        headers=signed_headers(sub['secret'],event['id'],body,int(now),sub['id'],old)
        try:
            status,_=self.sender(sub['url'],headers,body)
            state='webhook_accepted' if 200<=status<300 else 'delivery_refused'
            self.db.execute('UPDATE dispatch SET state=? WHERE subscription=? AND event=?',(state,sub['id'],event['id']))
            if status in (401,403,410):
                self.db.execute('UPDATE subscriptions SET active=0 WHERE id=?',(sub['id'],))
        except Exception:
            state='uncertain'
        return {'event_id':event['id'],'state':state,'assistant_run_confirmed':False,'automatic_retry':False}
