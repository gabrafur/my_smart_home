"""Bounded observation journal. No credentials; no replay API or effect retries."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
import uuid

LIMIT=4096
RETENTION=7*86400
FAILURE_CATEGORIES=frozenset(('dns_resolution_error','tls_certificate_error','tls_error',
    'timeout_exception','connection_error','http_protocol_error','os_error',
    'transport_exception_unclassified','unexpected_provider_response','http_refused'))


def check_file(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size>2*1048576+16384:
        raise ValueError('unsafe_history_file')


class History:
    def __init__(self,root,clock=time.time):
        root=Path(root);info=root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700:
            raise ValueError('unsafe_history_directory')
        if {p.name for p in root.iterdir()}-{'history.sqlite3','history.sqlite3-journal','lock','status.json','.status.tmp'}:raise ValueError('unexpected_history_entry')
        self.root=root
        self.lock=os.open(root/'lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        try:
            check_file(root/'lock');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            target=root/'history.sqlite3'
            if not os.path.lexists(target):
                fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.close(fd)
            for p in root.iterdir():check_file(p)
            self.db=sqlite3.connect(target,timeout=1,isolation_level=None)
            self.db.execute('PRAGMA synchronous=FULL');self.db.execute('PRAGMA journal_mode=DELETE');
            if self.db.execute('PRAGMA max_page_count=512').fetchone()[0]>512:raise ValueError('history_storage_limit')
            self.db.executescript('''CREATE TABLE IF NOT EXISTS samples(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,at REAL,state TEXT,http INTEGER,duration_ms REAL);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value REAL);
            CREATE TABLE IF NOT EXISTS failure_diagnostics(id TEXT PRIMARY KEY,category TEXT);''')
            self.clock=clock
        except BaseException:
            if hasattr(self,'db'):self.db.close()
            os.close(self.lock);raise

    def begin(self):
        at=self.clock();identifier=uuid.uuid4().hex
        self.db.execute('BEGIN IMMEDIATE')
        try:
            old=self.db.execute("SELECT value FROM meta WHERE key='last_wall'").fetchone()
            if old and at<old[0]-1:raise ValueError('clock_reconciliation_required')
            seq=self.db.execute("SELECT value FROM meta WHERE key='sequence'").fetchone()
            sequence=int(seq[0])+1 if seq else 1
            # These are bounded metric observations, not repair receipts. Pruning
            # never permits reissuing an observation; the monotonic sequence stays.
            self.db.execute('DELETE FROM samples WHERE at<?',(at-RETENTION,))
            self.db.execute('DELETE FROM samples WHERE seq IN (SELECT seq FROM samples ORDER BY seq DESC LIMIT -1 OFFSET ?)',(LIMIT-1,))
            self.db.execute('DELETE FROM failure_diagnostics WHERE id NOT IN (SELECT id FROM samples)')
            self.db.execute("INSERT INTO samples VALUES(?,?,?,'uncertain',NULL,NULL)",(sequence,identifier,at))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('sequence',?)",(sequence,))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('last_wall',?)",(at,))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK');raise
        return identifier

    def finish(self,identifier,result):
        if result.get('state') not in ('provider_accepted','provider_refused','uncertain'):raise ValueError('invalid_sample_state')
        status=result.get('http_status');duration=result.get('duration_ms')
        if status is not None and (type(status) is not int or not 100<=status<=599):raise ValueError('invalid_http_status')
        if type(duration) not in (int,float) or not 0<=duration<=30000:raise ValueError('invalid_duration')
        category=result.get('failure_category')
        if category is not None and (not isinstance(category,str) or category not in FAILURE_CATEGORIES):raise ValueError('invalid_failure_category')
        if result['state']=='provider_accepted' and category is not None:raise ValueError('conflicting_failure_category')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            changed=self.db.execute('UPDATE samples SET state=?,http=?,duration_ms=? WHERE id=? AND duration_ms IS NULL',(result['state'],status,duration,identifier)).rowcount
            if changed!=1:raise ValueError('sample_already_finished_or_missing')
            if category is not None:
                self.db.execute('INSERT INTO failure_diagnostics VALUES(?,?)',(identifier,category))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK');raise

    def summary(self):
        now=self.clock();row=self.db.execute('SELECT seq,at,state,http,duration_ms FROM samples ORDER BY seq DESC LIMIT 1').fetchone()
        count=self.db.execute('SELECT count(*) FROM samples').fetchone()[0]
        latest=self.db.execute('SELECT s.seq,s.at,s.state,s.http,d.category,s.duration_ms FROM samples s LEFT JOIN failure_diagnostics d ON s.id=d.id WHERE s.state!=? ORDER BY s.seq DESC LIMIT 1',('provider_accepted',)).fetchone()
        failure=None if latest is None else {'observed_at':datetime.datetime.fromtimestamp(latest[1],datetime.timezone.utc).isoformat(),
            'state':latest[2],'http_status':latest[3],'failure_category':latest[4] if latest[4] in FAILURE_CATEGORIES else 'not_recorded',
            'is_latest_attempt':bool(row and row[0]==latest[0]),'sample_completion_recorded':latest[5] is not None,
            'transport_outcome_not_service_health':True}
        return {'source':'bounded_local_heartbeat_history','diagnostic_schema_version':2,'latest_failed_or_uncertain_sample':failure,'observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),
                'samples_retained':count,'maximum_samples':LIMIT,'maximum_age_days':7,
                'last_sequence':row[0] if row else None,'last_sample_observed_at':datetime.datetime.fromtimestamp(row[1],datetime.timezone.utc).isoformat() if row else None,'last_http_status':row[3] if row else None,'last_sample_age_seconds':round(now-row[1],3) if row else None,
                'last_sample_state':row[2] if row else 'unknown',
                'collection_error':'no_sample' if row is None else 'sample_stale' if not 0<=now-row[1]<=120 else None,
                'coverage':['local_attempt_history','not_external_delivery_confirmation','retention_not_retry_permission']}

    def publish_status(self):
        # Cache only; rebuilding this cache never changes/replays an observation.
        path=self.root/'.status.tmp'
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:raise ValueError('unsafe_status_cache')
            raw=(json.dumps(self.summary(),separators=(',',':'))+'\n').encode()
            if len(raw)>4096:raise ValueError('status_limit')
            os.ftruncate(fd,0)
            pending=memoryview(raw)
            while pending:
                size=os.write(fd,pending)
                if size<=0:raise OSError('short_write')
                pending=pending[size:]
            os.fsync(fd)
        finally:os.close(fd)
        os.replace(path,self.root/'status.json')
        parent=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(parent)
        finally:os.close(parent)

    def close(self):
        self.db.close();os.close(self.lock)
