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
    def __init__(self, connection, clock=time.time, *, standing=False, archive_reader=None):
        self.db = connection
        self.db.row_factory = sqlite3.Row
        self.clock = clock
        self.standing = standing
        self.archive_reader = archive_reader
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS repair_receipts('
                        'id TEXT PRIMARY KEY, task TEXT NOT NULL, result_hash TEXT, result TEXT, '
                        'ack INTEGER NOT NULL DEFAULT 0)')
        if standing:
            columns = {row[1] for row in self.db.execute('PRAGMA table_info(repair_receipts)')}
            for name, kind in (('created','REAL'),('archive_hash','TEXT'),('terminal_state','TEXT')):
                if name not in columns:
                    self.db.execute('ALTER TABLE repair_receipts ADD COLUMN '+name+' '+kind)
            # Backfill only the exact durable legacy dispatch timestamp.
            self.db.execute('UPDATE repair_receipts SET created=(SELECT created FROM jobs '
                            'WHERE jobs.id=repair_receipts.id) WHERE created IS NULL')

    @staticmethod
    def rolling_accounting(db, now):
        rows = db.execute('SELECT id,task,created,ack,result,result_hash FROM repair_receipts').fetchall()
        count = unknown = 0
        for row in rows:
            if row['created'] is None:
                # No timestamp is invented or forgiven: a settled unknown
                # reservation occupies one slot in every rolling window.
                try: result = json.loads(row['result'])
                except (TypeError, ValueError): result = None
                need(row['task'] == TASK and row['ack'] == 1 and type(result) is dict
                     and result.get('operation_state') in TERMINAL
                     and digest(result) == row['result_hash'],
                     'historical_repair_timestamp_unconfirmed')
                unknown += 1
                count += 1
            else:
                need(type(row['created']) in (int, float) and 0 < row['created'] <= now,
                     'historical_repair_timestamp_unconfirmed')
                count += row['created'] > now - 86400
        return {'rolling_reserved_count': count, 'unknown_timestamp_reserved_count': unknown,
                'unknown_timestamp_policy': 'settled_unknown_charged_in_every_window'}

    def rolling_count(self, now):
        need(self.standing, 'standing_accounting_required')
        return self.rolling_accounting(self.db, now)['rolling_reserved_count']


    def reserve(self, op):
        prior = self.db.execute('SELECT * FROM repair_receipts WHERE id=?', (op,)).fetchone()
        if prior:
            return False
        need(self.db.execute('SELECT count(*) FROM repair_receipts WHERE ack=0').fetchone()[0] == 0,
             'repair_prior_result_requires_reconciliation')
        need(self.db.execute('SELECT count(*) FROM repair_receipts').fetchone()[0] < (4096 if self.standing else 8),
             'repair_history_capacity')
        if self.standing:
            self.db.execute('INSERT INTO repair_receipts(id,task,created) VALUES(?,?,?)', (op, TASK, self.clock()))
        else:
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
        if self.standing and value.get('archive_hash'):
            need(value['ack'] == 1 and value['terminal_state'] in TERMINAL and callable(self.archive_reader), 'repair_archive_reader_required')
            archived = self.archive_reader(op, value['archive_hash'])
            need(archived['result_hash'] == value['result_hash'] and digest(archived['result']) == value['result_hash'], 'repair_archive_result_changed')
            value['result'] = archived['result']
        return value


    def archive_ready(self, now):
        need(self.standing, 'standing_archive_required')
        rows = [dict(r) for r in self.db.execute(
            'SELECT r.*,j.thread,j.intent,j.state,j.created AS job_created,j.updated,j.attempts,j.turn,j.result AS job_result '
            'FROM repair_receipts r JOIN jobs j ON j.id=r.id WHERE r.ack=1 AND r.archive_hash IS NULL '
            'AND r.created<? AND j.created<? ORDER BY r.created,r.id LIMIT 8', (now-86400,now-86400))]
        for row in rows:
            need(all(type(row[k]) in (int,float) and 0 < row[k] < now-86400 for k in ('created','job_created')), 'repair_archive_timestamp_unconfirmed')
        return rows

    def archive_payload(self, row):
        need(type(row['id']) is str and re.fullmatch('[a-f0-9]{32}',row['id']) and row['task'] == TASK and row['thread'] == THREAD and row['intent'] == TASK and
             row['state'] in TERMINAL and row['ack'] == 1 and row['result'] is not None,
             'repair_archive_not_owned_terminal')
        result = json.loads(row['result'])
        need(result.get('operation_state') == row['state'] and digest(result) == row['result_hash'],
             'repair_archive_terminal_mismatch')
        audit = [dict(x) for x in self.db.execute('SELECT seq,id,state,at FROM audit WHERE id=? ORDER BY seq',(row['id'],))]
        need(len(audit) <= 256, 'repair_archive_audit_limit')
        return {'schema':'fixed_repair_archive_v1','operation_id':row['id'],'task':TASK,'thread_id':THREAD,
                'created':row['created'],'terminal_state':row['state'],'result':result,'result_hash':row['result_hash'],
                'legacy_job':{k:row[k] for k in ('thread','intent','state','job_created','updated','attempts','turn','job_result')},
                'audit':audit}

    def archive_commit(self, row, archive_hash):
        # Archive publication and readback must precede this atomic compaction.
        need(callable(self.archive_reader), 'repair_archive_reader_required')
        expected = self.archive_payload(row)
        need(self.archive_reader(row['id'], archive_hash) == expected, 'repair_archive_readback_mismatch')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            current = self.db.execute('SELECT * FROM repair_receipts WHERE id=?',(row['id'],)).fetchone()
            job = self.db.execute('SELECT * FROM jobs WHERE id=?',(row['id'],)).fetchone()
            need(current is not None and job is not None and current['ack'] == 1 and current['archive_hash'] is None and
                 current['result_hash'] == row['result_hash'] and current['result'] == row['result'] and
                 job['state'] == row['state'] and job['result'] == row['job_result'] and job['turn'] == row['turn'] and
                 job['created'] == row['job_created'] and job['updated'] == row['updated'], 'repair_archive_cas_conflict')
            audit = [dict(x) for x in self.db.execute('SELECT seq,id,state,at FROM audit WHERE id=? ORDER BY seq',(row['id'],))]
            need(audit == expected['audit'], 'repair_archive_audit_cas_conflict')
            self.db.execute('UPDATE repair_receipts SET result=NULL,archive_hash=?,terminal_state=? WHERE id=?',
                            (archive_hash,row['state'],row['id']))
            self.db.execute('DELETE FROM audit WHERE id=?',(row['id'],))
            self.db.execute('DELETE FROM jobs WHERE id=?',(row['id'],))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK');raise
        return {'operation_id':row['id'],'archived':True,'id_retained':True}

    def restore_archive(self, op, archive_hash):
        """Own inverse for a custodied installer; never a caller-selected RPC."""
        need(callable(self.archive_reader), 'repair_archive_reader_required')
        saved=self.archive_reader(op,archive_hash);job=saved['legacy_job']
        self.db.execute('BEGIN IMMEDIATE')
        try:
            current=self.db.execute('SELECT * FROM repair_receipts WHERE id=?',(op,)).fetchone()
            need(current is not None and current['archive_hash']==archive_hash and current['ack']==1 and
                 current['result_hash']==saved['result_hash'] and current['result'] is None,
                 'repair_archive_inverse_cas_conflict')
            need(self.db.execute('SELECT 1 FROM jobs WHERE id=?',(op,)).fetchone()is None,
                 'repair_archive_inverse_job_conflict')
            need(all(self.db.execute('SELECT 1 FROM audit WHERE seq=?',(r['seq'],)).fetchone()is None
                     for r in saved['audit']), 'repair_archive_inverse_audit_conflict')
            self.db.execute('INSERT INTO jobs(id,thread,intent,state,created,updated,attempts,turn,result) VALUES(?,?,?,?,?,?,?,?,?)',
                (op,job['thread'],job['intent'],job['state'],job['job_created'],job['updated'],job['attempts'],job['turn'],job['job_result']))
            for r in saved['audit']:
                self.db.execute('INSERT INTO audit(seq,id,state,at)VALUES(?,?,?,?)',(r['seq'],r['id'],r['state'],r['at']))
            self.db.execute('UPDATE repair_receipts SET result=?,archive_hash=NULL,terminal_state=NULL WHERE id=?',
                            (json.dumps(saved['result'],sort_keys=True),op))
            self.db.execute('COMMIT')
        except BaseException:self.db.execute('ROLLBACK');raise
        return {'operation_id':op,'restored':True,'archive_retained':True}

    def reconcile(self, op, h):
        row = self.db.execute('SELECT * FROM repair_receipts WHERE id=?', (op,)).fetchone()
        need(row is not None and row['result_hash'] == h, 'repair_result_hash_unconfirmed')
        self.db.execute('UPDATE repair_receipts SET ack=1 WHERE id=?', (op,))
        return {'operation_id': op, 'reconciled': True, 'result_hash': h,
                'duplicate': bool(row['ack'])}


class ResumeStore:
    """Operation-bound profile application; uncertainty never repeats resume."""
    def __init__(self, db):
        self.db = db
        db.execute('CREATE TABLE IF NOT EXISTS repair_resume_receipts('
                   'id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL,'
                   'result TEXT,created REAL NOT NULL)')

    def begin(self, op, request_hash, now):
        need(re.fullmatch('[a-f0-9]{32}',op) and re.fullmatch('[a-f0-9]{64}',request_hash),
             'repair_resume_identity')
        row = self.db.execute('SELECT request_hash,state FROM repair_resume_receipts WHERE id=?',(op,)).fetchone()
        if row is not None:
            need(row[0] == request_hash, 'repair_resume_binding_changed')
            need(row[1] == 'verified', 'repair_resume_uncertain_observe_same_operation')
            return False
        need(self.db.execute("SELECT count(*) FROM repair_resume_receipts WHERE state!='verified'").fetchone()[0]==0,'repair_resume_prior_uncertain_observe_same_operation')
        need(self.db.execute('SELECT count(*) FROM repair_resume_receipts').fetchone()[0]<4096,'repair_resume_history_capacity')
        self.db.execute('INSERT INTO repair_resume_receipts VALUES(?,?,?,?,?)',
                        (op,request_hash,'resume_intent',None,now))
        return True

    def verified(self, op, request_hash, result):
        need(type(result) is dict and result.get('profile_readback_verified') is True,
             'repair_resume_profile_unconfirmed')
        encoded=json.dumps(result,sort_keys=True,separators=(',',':'))
        need(len(encoded.encode())<=4096,'repair_resume_result_bound')
        changed=self.db.execute("UPDATE repair_resume_receipts SET state='verified',result=? "
                                "WHERE id=? AND request_hash=? AND state='resume_intent'",
                                (encoded,op,request_hash)).rowcount
        need(changed==1,'repair_resume_receipt_cas')

    def ready(self, op, request_hash):
        row=self.db.execute('SELECT request_hash,state,result FROM repair_resume_receipts WHERE id=?',(op,)).fetchone()
        need(row is not None and row[0]==request_hash and row[1]=='verified',
             'repair_resume_verified_receipt_required')
        return json.loads(row[2])
