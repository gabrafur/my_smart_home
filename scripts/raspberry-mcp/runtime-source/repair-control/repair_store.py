"""Isolated durable ledger: commit before dispatch; uncertain execution never retries.

Runtime integration additionally uses the installed shared coordinator lock and
mirrors dispatch in the legacy jobs table, so existing task gates see it too.
"""
import hashlib
import json
import re
import sqlite3
import time

TASK = 'repair_health_summary'
THREAD = '${AUTHORIZED_THREAD_ID_1}'
TERMINAL = {'completed', 'failed', 'interrupted'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def validate(name, args):
    fields = {
        'codex_repair_submit': {'host', 'operation_id', 'task'},
        'codex_repair_status': {'host', 'operation_id'},
        'codex_repair_result': {'host', 'operation_id'},
        'codex_repair_reconcile': {'host', 'operation_id', 'result_hash'},
        'codex_repair_revoke': {'host'},
        'codex_repair_capabilities': {'host'},
    }
    need(name in fields and isinstance(args, dict) and set(args) == fields[name]
         and args.get('host') == 'raspberry', 'repair_scope_refused')
    if 'task' in args:
        need(args['task'] == TASK, 'repair_task_not_approved')
    for key, size in [('operation_id', 32), ('result_hash', 64)]:
        if key in args:
            need(isinstance(args[key], str) and re.fullmatch('[a-f0-9]{%d}' % size, args[key]),
                 'invalid_repair_identifier')


class Store:
    def __init__(self, connection, clock=time.time):
        self.db = connection
        self.db.row_factory = sqlite3.Row
        self.clock = clock
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS repair_receipts('
                        'id TEXT PRIMARY KEY, task TEXT NOT NULL, result_hash TEXT, result TEXT, '
                        'ack INTEGER NOT NULL DEFAULT 0)')

    def reserve(self, op):
        prior = self.db.execute('SELECT * FROM repair_receipts WHERE id=?', (op,)).fetchone()
        if prior:
            return False
        need(self.db.execute('SELECT count(*) FROM repair_receipts WHERE ack=0').fetchone()[0] == 0,
             'repair_prior_result_requires_reconciliation')
        need(self.db.execute('SELECT count(*) FROM repair_receipts').fetchone()[0] < 8,
             'repair_history_capacity')
        self.db.execute('INSERT INTO repair_receipts(id,task) VALUES(?,?)', (op, TASK))
        return True

    def terminal(self, op, result):
        need(result.get('operation_state') in TERMINAL, 'repair_result_not_terminal')
        h = digest(result)
        self.db.execute('UPDATE repair_receipts SET result_hash=?,result=? WHERE id=? AND ack=0',
                        (h, json.dumps(result, sort_keys=True), op))
        return h

    def get(self, op):
        row = self.db.execute('SELECT * FROM repair_receipts WHERE id=?', (op,)).fetchone()
        if row is None:
            return None
        value = dict(row)
        value['result'] = json.loads(value['result']) if value['result'] else None
        return value

    def reconcile(self, op, h):
        row = self.db.execute('SELECT * FROM repair_receipts WHERE id=?', (op,)).fetchone()
        need(row is not None and row['result_hash'] == h, 'repair_result_hash_unconfirmed')
        self.db.execute('UPDATE repair_receipts SET ack=1 WHERE id=?', (op,))
        return {'operation_id': op, 'reconciled': True, 'result_hash': h,
                'duplicate': bool(row['ack'])}
