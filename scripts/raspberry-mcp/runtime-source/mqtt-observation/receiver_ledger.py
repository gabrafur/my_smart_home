"""Unarmed durable metadata ledger; transport and peer attestation remain separate.

No raw frame, event payload, topic, client identity, credentials or exception text
is persisted. Callers must provide real kernel/code binding; JSON cannot attest it.
This module makes no availability, notification or 24-hour acceptance decision.
"""
from pathlib import Path
import copy,fcntl,hashlib,json,os,re,sqlite3,stat
from protocol import accept,validate_state,Invalid

FAULTS=('reader_restart','clock_domain_changed','source_frame_rejected',
        'source_binding_unverified','transport_truncated',
        'transport_ancillary_invalid','source_identity_lost')
MAX_BODY=131072
class LedgerUnavailable(RuntimeError):pass

def fail(reason):
    raise LedgerUnavailable(reason)from None

def number(value):
    return type(value)is int and 0<=value<2**128

def encode(body):
    return json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=True)

def validate(body):
    expected={'version','revision','reader_sessions','accepted_frames','duplicate_frames',
              'faults','last_fault','clock_domain_id','state'}
    if type(body)is not dict or set(body)!=expected:fail('ledger_state_invalid')
    if type(body['version'])is not int or body['version']!=1:fail('ledger_state_invalid')
    if not all(number(body[k])for k in ['revision','reader_sessions','accepted_frames','duplicate_frames']):fail('ledger_state_invalid')
    if type(body['clock_domain_id'])is not str or re.fullmatch('[a-f0-9]{64}',body['clock_domain_id'])is None:fail('ledger_state_invalid')
    faults=body['faults']
    if type(faults)is not dict or set(faults)!=set(FAULTS)or not all(number(v)for v in faults.values()):fail('ledger_state_invalid')
    last=body['last_fault']
    if last is not None:
        if type(last)is not dict or set(last)!={'kind','at_ns','clock_domain_id'}:fail('ledger_state_invalid')
        if last['kind']not in FAULTS or not number(last['at_ns'])or not isinstance(last['clock_domain_id'],str)or re.fullmatch('[a-f0-9]{64}',last['clock_domain_id'])is None:fail('ledger_state_invalid')
    if (sum(faults.values())==0)!=(last is None):fail('ledger_state_invalid')
    if body['state']is not None:
        try:validate_state(body['state'])
        except (Invalid,KeyError,TypeError):fail('ledger_state_invalid')

def stringify(value):
    if type(value)is int:return str(value)
    if type(value)is list:return [stringify(x)for x in value]
    if type(value)is dict:return {k:stringify(v)for k,v in value.items()}
    return value

class Ledger:
    def __init__(self,path,*,create=False,clock_domain_id,started_ns,start_session=True):
        if type(start_session)is not bool or(not start_session and not create):fail('reader_session_mode_invalid')
        self.path=Path(path);self.db=None;self.lock=None;self.failed=False;self.body=None
        if type(started_ns)is not int or not 0<=started_ns<2**64:fail('reader_clock_invalid')
        if not isinstance(clock_domain_id,str)or re.fullmatch('[a-f0-9]{64}',clock_domain_id)is None:fail('clock_domain_invalid')
        try:
            parent=self.path.parent.lstat()
            if not stat.S_ISDIR(parent.st_mode)or parent.st_uid!=os.geteuid()or stat.S_IMODE(parent.st_mode)&0o077:fail('ledger_parent_unsafe')
            if not self.path.is_absolute()or self.path.parent.resolve()!=self.path.parent:fail('ledger_parent_unsafe')
            self.lock=os.open(str(self.path)+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
            self._safe_file(os.fstat(self.lock))
            try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:fail('ledger_already_open')
            flags=os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC
            if create:flags|=os.O_CREAT|os.O_EXCL
            fd=os.open(self.path,flags,0o600)
            try:
                original=os.fstat(fd);self._safe_file(original)
            finally:os.close(fd)
            self.db=sqlite3.connect(self.path.as_uri()+'?mode=rw',uri=True,timeout=0,isolation_level=None)
            current=self.path.lstat()
            if (current.st_dev,current.st_ino)!=(original.st_dev,original.st_ino):fail('ledger_file_changed')
            for pragma in ['trusted_schema=OFF','journal_mode=WAL','synchronous=FULL',
                           'wal_autocheckpoint=32','journal_size_limit=262144','max_page_count=256']:
                self.db.execute('PRAGMA '+pragma).fetchall()
            if create:
                self.db.execute('CREATE TABLE snapshot(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,sha256 TEXT NOT NULL)')
                body=self._initial_body(clock_domain_id)
                self._commit(body,first=True)
            row=self.db.execute('SELECT body,sha256 FROM snapshot WHERE id=1').fetchone()
            if row is None or len(row[0])>MAX_BODY or hashlib.sha256(row[0].encode('ascii')).hexdigest()!=row[1]:fail('ledger_state_invalid')
            body=json.loads(row[0]);self._validate(body);self.body=body
            if not start_session:return
            next_body=copy.deepcopy(body);next_body['reader_sessions']+=1
            if body['reader_sessions']:
                self._fault(next_body,'reader_restart',started_ns,clock_domain_id)
            if body['clock_domain_id']!=clock_domain_id:
                self._fault(next_body,'clock_domain_changed',started_ns,clock_domain_id)
            next_body['clock_domain_id']=clock_domain_id
            self._commit(next_body)
        except LedgerUnavailable:
            self.close();raise
        except (OSError,sqlite3.Error,ValueError,TypeError,UnicodeError,RecursionError):
            self.close();fail('ledger_open_failed')

    def _initial_body(self,clock_domain_id):
        return {'version':1,'revision':0,'reader_sessions':0,'accepted_frames':0,'duplicate_frames':0,
                'faults':dict.fromkeys(FAULTS,0),'last_fault':None,'clock_domain_id':clock_domain_id,'state':None}

    def _prepare(self,candidate):
        return candidate

    def _validate(self,body):
        validate(body)

    @staticmethod
    def _safe_file(info):
        if not stat.S_ISREG(info.st_mode)or info.st_uid!=os.geteuid()or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)&0o077:fail('ledger_file_unsafe')

    @staticmethod
    def _fault(body,kind,at_ns,domain):
        body['faults'][kind]+=1;body['last_fault']={'kind':kind,'at_ns':at_ns,'clock_domain_id':domain}

    def _commit(self,body,*,first=False):
        if self.failed or self.db is None:fail('ledger_not_writable')
        try:
            candidate=copy.deepcopy(body);candidate['revision']+=1
            candidate=self._prepare(candidate);self._validate(candidate)
            raw=encode(candidate)
            if len(raw)>MAX_BODY:fail('ledger_capacity_reached')
            digest=hashlib.sha256(raw.encode('ascii')).hexdigest()
            self.db.execute('BEGIN IMMEDIATE')
            if first:self.db.execute('INSERT INTO snapshot(id,body,sha256) VALUES(1,?,?)',(raw,digest))
            else:
                changed=self.db.execute('UPDATE snapshot SET body=?,sha256=? WHERE id=1',(raw,digest)).rowcount
                if changed!=1:fail('ledger_state_invalid')
            self.db.execute('COMMIT')
            self.body=candidate
        except (sqlite3.Error,LedgerUnavailable):
            self.failed=True
            try:self.db.execute('ROLLBACK')
            except sqlite3.Error:pass
            fail('metadata_commit_failed')

    def record_fault(self,kind,arrived_ns):
        if kind not in FAULTS or kind in ('reader_restart','clock_domain_changed'):fail('fault_kind_invalid')
        if type(arrived_ns)is not int or not 0<=arrived_ns<2**64:fail('reader_clock_invalid')
        body=copy.deepcopy(self.body);self._fault(body,kind,arrived_ns,body['clock_domain_id']);self._commit(body)
        return self.report()

    def frame(self,packet,arrived_ns,*,source_binding_verified):
        if source_binding_verified is not True:
            return {'status':'unknown','report':self.record_fault('source_binding_unverified',arrived_ns)}
        result=accept(self.body['state'],packet,arrived_ns,source_binding_verified=True)
        if result['status']=='unknown':
            return {'status':'unknown','report':self.record_fault('source_frame_rejected',arrived_ns)}
        body=copy.deepcopy(self.body)
        if result['status']=='accepted':
            body['accepted_frames']+=1;body['state']=result['state']
        else:body['duplicate_frames']+=1
        self._commit(body)
        return {'status':result['status'],'report':self.report()}

    def report(self):
        if self.failed or self.body is None:fail('ledger_not_readable')
        return {'schema_version':1,'accounting':stringify(copy.deepcopy(self.body)),
                'full24h_proven':False,'all_event_latency_proven':False,'full_goal_proven':False}

    def close(self):
        if self.db:
            try:self.db.close()
            except sqlite3.Error:pass
            self.db=None
        if self.lock is not None:
            os.close(self.lock);self.lock=None
