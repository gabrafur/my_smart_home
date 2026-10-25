"""Durable no-replay coordinator, admitted only by the sealed broker.

This module stores hashes and sanitized receipts, never task instructions.
Transport, admission and legacy serialization are supplied by the broker.
"""
import hashlib
import json
import re
import sqlite3
import time

BUSY = ('create_intent', 'create_unknown', 'send_intent', 'send_unknown',
        'accepted', 'inProgress', 'outcome_unknown')
TERMINAL = ('completed', 'failed', 'interrupted')
UUID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
                         ensure_ascii=False).encode()).hexdigest()


def creation_observation(value, thread):
    need(isinstance(value, dict) and value.get('thread_id') == thread and
         value.get('state') in ('durable_ready', 'durable_blocked', 'missing_before_first_send', 'unconfirmed'),
         'creation_observation_unconfirmed')
    fields = {'state', 'thread_id'}
    if value['state'] == 'durable_blocked':
        fields.add('reason')
        need(value.get('reason') in ('profile_mismatch', 'thread_not_ready',
             'profile_unconfirmed'), 'creation_block_reason_unconfirmed')
    if value['state'] == 'missing_before_first_send':
        fields |= {'read_code', 'resume_code'}
        need(value.get('read_code') == -32600 and value.get('resume_code') == -32600,
             'creation_absence_unconfirmed')
    need(set(value) == fields, 'creation_observation_scope')
    return value


def task_spec(q):
    need(isinstance(q, dict) and set(q) == {
        'operation_id', 'task_key', 'objective', 'acceptance'}, 'task_scope_refused')
    need(isinstance(q['operation_id'], str) and
         re.fullmatch('[a-f0-9]{32}', q['operation_id']), 'invalid_operation_id')
    need(isinstance(q['task_key'], str) and
         re.fullmatch('[a-z][a-z0-9-]{2,63}', q['task_key']), 'invalid_task_key')
    for name, limit in [('objective', 4000), ('acceptance', 1500)]:
        need(isinstance(q[name], str) and 1 <= len(q[name]) <= limit and
             '\x00' not in q[name], 'invalid_task_text')
    # Text is task data, never a command, path or privilege/configuration field.
    return q


class Store:
    """Caller holds one shared flock across this store AND legacy sends.

    The database holds hashes and sanitized receipts, never task prompts.
    Production must open a fixed UID-owned no-follow file before connecting.
    """
    def __init__(self, path, clock=time.time):
        self.clock = clock
        self.db = sqlite3.connect(path, timeout=2, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        # Enforce the existing one-MiB cap before migrating the schema, too.
        need(self.db.execute('PRAGMA page_size').fetchone()[0] == 4096,
             'task_database_page_size')
        need(self.db.execute('PRAGMA max_page_count=256').fetchone()[0] == 256,
             'task_database_page_limit')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS tasks(
            id TEXT PRIMARY KEY, task_key TEXT UNIQUE NOT NULL,
            spec_hash TEXT NOT NULL, thread TEXT UNIQUE,
            state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
            reconciled INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS sends(
            id TEXT PRIMARY KEY, task TEXT NOT NULL, input_hash TEXT NOT NULL,
            state TEXT NOT NULL, turn TEXT, created REAL NOT NULL,
            updated REAL NOT NULL, result TEXT, reconciled INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS audit(
            seq INTEGER PRIMARY KEY, id TEXT NOT NULL,
            state TEXT NOT NULL, at REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS creation_results(
            id TEXT PRIMARY KEY, result TEXT NOT NULL);
        ''')

    def close(self):
        self.db.close()

    def row(self, table, op):
        need(table in ('tasks', 'sends'), 'invalid_table')
        row = self.db.execute('SELECT * FROM ' + table + ' WHERE id=?', (op,)).fetchone()
        return dict(row) if row else None

    def audit(self, op, state):
        self.db.execute('INSERT INTO audit(id,state,at) VALUES(?,?,?)',
                        (op, state, self.clock()))

    def transaction(self, fn):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result = fn()
            self.db.execute('COMMIT')
            return result
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def idle(self):
        marks = ','.join('?' for _ in BUSY)
        for table in ('tasks', 'sends'):
            need(not self.db.execute('SELECT 1 FROM ' + table +
                 ' WHERE state IN (' + marks + ') LIMIT 1', BUSY).fetchone(),
                 'prior_task_requires_reconciliation')
        # A created thread is reserved until instructed or explicitly reconciled.
        need(not self.db.execute("SELECT 1 FROM tasks WHERE state='created' "
             'AND reconciled=0 LIMIT 1').fetchone(), 'created_task_reserved')
        need(not self.db.execute('SELECT 1 FROM sends WHERE reconciled=0 LIMIT 1')
             .fetchone(), 'result_requires_central_reconciliation')

    def create(self, q, invoke, legacy_idle):
        task_spec(q)
        op = q['operation_id']
        hashed = fingerprint(q)
        old = self.row('tasks', op)
        if old:
            need(old['spec_hash'] == hashed, 'operation_id_conflict')
            return {**old, 'duplicate': True}
        self.idle()
        legacy_idle()
        need(not self.db.execute('SELECT 1 FROM tasks WHERE task_key=?',
                                 (q['task_key'],)).fetchone(), 'duplicate_task_key')
        # Quota/account/resources are checked BEFORE persisting a dispatch intent.
        invoke({'mode': 'create_preflight'})
        def intent():
            now = self.clock()
            self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,0)',
                            (op, q['task_key'], hashed, None, 'create_intent', now, now))
            self.audit(op, 'create_intent')
        self.transaction(intent)
        thread = None
        try:
            reply = invoke({'mode': 'create', 'operation_id': op})
            need(isinstance(reply.get('thread_id'), str) and
                 UUID.fullmatch(reply['thread_id']), 'creation_unconfirmed')
            thread = reply['thread_id']
            need(reply.get('fixed_profile_verified') is True, 'creation_profile_unconfirmed')
            need(reply.get('durable_thread_verified') is True, 'creation_persistence_unconfirmed')
            state = 'created'
        except Exception:
            # Retain a returned identity even if the permission profile was
            # refused. It identifies a real thread to reconcile, never to send.
            state = 'create_unknown'
        def finish():
            self.db.execute('UPDATE tasks SET thread=?,state=?,updated=? WHERE id=?',
                            (thread, state, self.clock(), op))
            self.audit(op, state)
        self.transaction(finish)
        return self.row('tasks', op)

    def send(self, q, invoke, admission, legacy_idle):
        need(isinstance(q, dict) and set(q) == {'operation_id', 'task_id', 'text'},
             'send_scope_refused')
        need(isinstance(q['operation_id'], str) and
             re.fullmatch('[a-f0-9]{32}', q['operation_id']), 'invalid_operation_id')
        need(isinstance(q['text'], str) and 1 <= len(q['text']) <= 6000 and
             '\x00' not in q['text'], 'invalid_task_text')
        op, hashed = q['operation_id'], fingerprint(q)
        old = self.row('sends', op)
        if old:
            need(old['input_hash'] == hashed, 'operation_id_conflict')
            return {**old, 'duplicate': True}
        task = self.row('tasks', q['task_id'])
        need(task and task['state'] == 'created' and task['thread'], 'task_not_admitted')
        # Temporarily exempt only this task's reservation; all other gates remain.
        need(not self.db.execute('SELECT 1 FROM tasks WHERE id!=? AND reconciled=0',
                                 (task['id'],)).fetchone(), 'other_task_reserved')
        marks = ','.join('?' for _ in BUSY)
        need(not self.db.execute('SELECT 1 FROM sends WHERE state IN (' + marks +
             ') OR reconciled=0 LIMIT 1', BUSY).fetchone(), 'prior_send_requires_reconciliation')
        legacy_idle()
        count = self.db.execute('SELECT count(*) FROM sends WHERE created>?',
                                (self.clock() - 86400,)).fetchone()[0]
        latest = self.db.execute('SELECT max(created) FROM sends').fetchone()[0]
        # Admission checks root policy expiry, budget including legacy sends,
        # resources and spacing. The caller cannot supply a policy or expiry.
        admission(count, latest)
        observed = creation_observation(invoke({'mode': 'creation_probe',
            'thread_id': task['thread']}), task['thread'])
        need(observed['state'] == 'durable_ready', 'task_creation_not_ready')
        invoke({'mode': 'send_preflight', 'thread_id': task['thread']})
        def intent():
            now = self.clock()
            self.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
                            (op, task['id'], hashed, 'send_intent', None, now, now, None))
            self.audit(op, 'send_intent')
        self.transaction(intent)
        try:
            reply = invoke({'mode': 'send', 'thread_id': task['thread'],
                            'operation_id': op, 'text': q['text']})
            need(reply.get('operation_state') == 'accepted' and
                 isinstance(reply.get('turn_id'), str) and
                 UUID.fullmatch(reply['turn_id']), 'send_unconfirmed')
            state, turn = 'accepted', reply['turn_id']
        except Exception:
            state, turn = 'send_unknown', None
        def finish():
            self.db.execute('UPDATE sends SET state=?,turn=?,updated=? WHERE id=?',
                            (state, turn, self.clock(), op))
            self.db.execute('UPDATE tasks SET reconciled=1 WHERE id=?', (task['id'],))
            self.audit(op, state)
        self.transaction(finish)
        return self.row('sends', op)

    def observe(self, op, invoke):
        row = self.row('sends', op)
        if row is None:
            return {'id': op, 'state': 'not_recorded', 'turn': None,
                    'send_state': 'not_sent_by_adapter',
                    'reconciliation_required': False}
        # Observation failure never changes state to terminal or replays a send.
        if row['state'] in ('accepted', 'inProgress', 'outcome_unknown') and row['turn']:
            task = self.row('tasks', row['task'])
            reply = invoke({'mode': 'observe', 'thread_id': task['thread'],
                            'turn_id': row['turn'], 'operation_id': op})
            state = reply.get('operation_state')
            need(state in (*TERMINAL, 'inProgress', 'outcome_unknown'),
                 'turn_state_unconfirmed')
            # Transport returns only a validated, bounded answer schema.
            result = json.dumps(reply)
            need(len(result.encode()) <= 8192, 'result_limit')
            def finish():
                self.db.execute('UPDATE sends SET state=?,result=?,updated=? WHERE id=?',
                                (state, result, self.clock(), op))
                if row['state'] != state:
                    self.audit(op, state)
            self.transaction(finish)
        return self.row('sends', op)

    def creation_result(self, op):
        row = self.db.execute('SELECT result FROM creation_results WHERE id=?', (op,)).fetchone()
        return json.loads(row[0]) if row else None

    def observe_creation(self, op, invoke):
        task = self.row('tasks', op)
        need(task is not None, 'task_not_found')
        previous = self.creation_result(op)
        sent = self.db.execute('SELECT id FROM sends WHERE task=? ORDER BY created DESC,id ASC LIMIT 1',
                               (op,)).fetchone()
        if sent:
            collection_error = None
            try:
                send = self.observe(sent['id'], invoke)
            except Exception:
                send = self.row('sends', sent['id'])
                collection_error = 'turn_observation_failed'
            count = self.db.execute('SELECT count(*) FROM sends WHERE task=?', (op,)).fetchone()[0]
            result = {'kind': 'creation', 'operation_id': op, 'thread_id': task['thread'],
                      'state': 'creation_confirmed' if task['state'] == 'created' else 'unconfirmed',
                      'creation_confirmed': task['state'] == 'created', 'send_rows': count,
                      'send_operation_id': send['id'], 'send_state': send['state'],
                      'execution_state': send['state'], 'collection_error': collection_error}
            if collection_error:
                result['execution_state'] = 'unconfirmed'
            return {**task, 'result': json.dumps(result, sort_keys=True)}
        if task['state'] not in ('created', 'create_unknown') or not task['thread']:
            return {**task, **({'result': json.dumps(previous)} if previous else {})}
        # Runtime failures are observations, never authorization to start again.
        observed = creation_observation(invoke({'mode': 'creation_probe', 'thread_id': task['thread']}),
                                        task['thread'])
        result = {**observed, 'kind': 'creation', 'operation_id': op, 'send_rows': 0,
                  'creation_confirmed': observed['state'] in ('durable_ready', 'durable_blocked'),
                  'send_state': 'not_sent', 'execution_state': 'not_started_by_adapter'}
        raw = json.dumps(result, sort_keys=True)
        need(len(raw.encode()) <= 2048, 'creation_observation_limit')
        def persist():
            self.db.execute('INSERT INTO creation_results VALUES(?,?) ON CONFLICT(id) '
                            'DO UPDATE SET result=excluded.result', (op, raw))
            if observed['state'] in ('durable_ready', 'durable_blocked') and task['state'] == 'create_unknown':
                self.db.execute('UPDATE tasks SET state=?,updated=? WHERE id=?',
                                ('created', self.clock(), op))
            self.audit(op, 'creation_observed_' + observed['state'])
        self.transaction(persist)
        return {**self.row('tasks', op), 'result': raw}

    def reconcile_creation(self, op, result_hash, invoke):
        task = self.row('tasks', op)
        result = self.creation_result(op)
        need(task and result and result.get('state') == 'missing_before_first_send'
             and fingerprint(result) == result_hash, 'creation_result_unconfirmed')
        if task['state'] == 'creation_lost_before_send' and task['reconciled']:
            return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash,
                    'state': 'creation_lost_before_send', 'duplicate': True}
        need(task['state'] in ('created', 'create_unknown') and task['thread'] and
             not self.db.execute('SELECT 1 FROM sends WHERE task=? LIMIT 1', (op,)).fetchone(),
             'creation_has_send_or_changed_state')
        # Re-check absence under the same serial lock before releasing reservation.
        current = creation_observation(invoke({'mode': 'creation_probe', 'thread_id': task['thread']}),
                                       task['thread'])
        current = {**current, 'kind': 'creation', 'operation_id': op, 'send_rows': 0,
                   'creation_confirmed': False, 'send_state': 'not_sent',
                   'execution_state': 'not_started_by_adapter'}
        need(fingerprint(current) == result_hash, 'creation_observation_changed')
        def finish():
            self.db.execute('UPDATE tasks SET state=?,reconciled=1,updated=? WHERE id=?',
                            ('creation_lost_before_send', self.clock(), op))
            self.audit(op, 'creation_lost_centrally_reconciled')
        self.transaction(finish)
        return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash,
                'state': 'creation_lost_before_send'}

    def reconcile(self, op, result_hash):
        """Called after the central checkpoint records a real terminal result.

        A hash acknowledgment binds the reconciliation to the exact receipt.
        It cannot release an uncertain or running operation.
        """
        row = self.row('sends', op)
        need(row and row['state'] in TERMINAL and row['result'], 'not_terminal')
        need(fingerprint(json.loads(row['result'])) == result_hash, 'result_hash_conflict')
        if row['reconciled']:
            return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash}
        def finish():
            self.db.execute('UPDATE sends SET reconciled=1 WHERE id=?', (op,))
            self.audit(op, 'centrally_reconciled')
        self.transaction(finish)
        return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash}
