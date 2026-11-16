"""Staged durable coordinator. No production paths, shell execution or credentials.

Transport, admission and legacy serialization must be supplied by a sealed broker.
This module is not installed and cannot admit work on its own.
"""
import datetime
import hashlib
import json
import re
import sqlite3
import time
import os,stat,zlib
from pathlib import Path

BUSY = ('create_intent', 'create_unknown', 'send_intent', 'send_unknown',
        'accepted', 'inProgress', 'outcome_unknown')
TERMINAL = ('completed', 'failed', 'interrupted')
UUID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
WORKSPACE_PREFIX = 'workspace:'
MAX_WORKSPACE_REFERENCES = 64
HISTORY_RESULT='{"history_archive":true}'


def need(value, reason):
    if not value:
        raise ValueError(reason)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
                         ensure_ascii=False).encode()).hexdigest()


INCIDENT_PREFIX = 'incident_binding_v1:'
INCIDENT_PROVENANCE = 'authenticated_request_binding_not_incident_cause_or_recovery'
INCIDENT_TEMPLATE = re.compile(
    r'Diagnostique e corrija somente o autorizado para objeto ([a-f0-9]{64}) e '
    r'(?:revisão ([a-f0-9]{64}); prepare os demais e reporte evidências\.|'
    r'revisao ([a-f0-9]{64}); prepare os demais e reporte evidencias\.)')


def incident_request(text):
    match = INCIDENT_TEMPLATE.fullmatch(text)
    return (match.group(1), match.group(2) or match.group(3)) if match else None


CONTEXT_MARKER = '\n\nTASK_CONTEXT_V1\n'


def incident_context(text):
    header, separator, raw = text.partition(CONTEXT_MARKER)
    binding = incident_request(header)
    if not separator or not binding:
        return incident_request(text), None
    def closed_object(pairs):
        value = dict(pairs)
        need(len(value) == len(pairs), 'incident_context_invalid')
        return value
    try:
        context = json.loads(raw, object_pairs_hook=closed_object,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, RecursionError):
        raise ValueError('incident_context_invalid') from None
    need(type(context) is dict and set(context) == {'objective', 'acceptance', 'incident'},
         'incident_context_invalid')
    def bounded(value, limit):
        return type(value) is str and 1 <= len(value) <= limit and '\x00' not in value
    need(bounded(context['objective'], 4000) and bounded(context['acceptance'], 1500),
         'incident_context_invalid')
    incident = context['incident']
    need(type(incident) is dict and set(incident) == {'object_id', 'revision', 'source',
         'observed_at', 'collection_error', 'coverage', 'summary'}, 'incident_context_invalid')
    need((incident['object_id'], incident['revision']) == binding,
         'incident_context_identity_mismatch')
    need(bounded(incident['source'], 128) and bounded(incident['summary'], 1000)
         and (incident['collection_error'] is None or bounded(incident['collection_error'], 256))
         and type(incident['coverage']) is list and len(incident['coverage']) <= 16
         and all(bounded(item, 128) for item in incident['coverage']), 'incident_context_invalid')
    timestamp = incident['observed_at']
    need(timestamp is None or (bounded(timestamp, 40) and
         re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', timestamp)),
         'incident_context_invalid')
    if timestamp is not None:
        try:
            datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('incident_context_invalid') from None
    return binding, context


def incident_decode(state, op, send_state):
    need(isinstance(state, str) and state.startswith(INCIDENT_PREFIX), 'invalid_incident_binding')
    value = state[len(INCIDENT_PREFIX):].split(':')
    need(len(value) == 2 and all(re.fullmatch('[a-f0-9]{64}', part) for part in value)
         and re.fullmatch('[a-f0-9]{32}', op) and op == value[1][-32:],
         'invalid_incident_binding')
    return {'object_id': value[0], 'revision': value[1], 'operation_id': op,
            'send_state': send_state, 'provenance': INCIDENT_PROVENANCE}


def history_read(db,kind,identity):
    """Exact immutable snapshot lookup; archive is separate from active slots."""
    need(kind in ('tasks','sends','profile_transitions','bindings')and re.fullmatch('[a-f0-9]{32}',identity),'history_lookup_scope')
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table'AND name='history_refs'").fetchone():return None
    ref=db.execute('SELECT version FROM history_refs WHERE kind=?AND id=?',(kind,identity)).fetchone()
    if ref is None:return None
    main=[r[2]for r in db.execute('PRAGMA database_list')if r[1]=='main']
    need(len(main)==1 and main[0],'history_file_database_required')
    path=Path(main[0]).with_name('task-history.sqlite3');a=path.lstat();owner=Path(main[0]).lstat().st_uid
    need(stat.S_ISREG(a.st_mode)and not path.is_symlink()and a.st_uid==owner and stat.S_IMODE(a.st_mode)==0o600 and a.st_nlink==1,'history_database_custody')
    archive=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        archive.execute('PRAGMA query_only=ON')
        row=archive.execute('SELECT body FROM snapshots WHERE kind=?AND id=?AND version=?',(kind,identity,ref[0])).fetchone()
        need(row is not None,'history_snapshot_missing')
        raw=_bounded_history_inflate(row[0])
        value=json.loads(raw);need(fingerprint(value)==ref[0]and value['kind']==kind and value['id']==identity,'history_snapshot_changed')
    finally:archive.close()
    z=path.lstat();need((a.st_dev,a.st_ino)==(z.st_dev,z.st_ino),'history_database_replaced')
    return value

def _bounded_history_inflate(raw):
    need(type(raw)is bytes and len(raw)<=1048576,'history_snapshot_storage_bound')
    inflater=zlib.decompressobj();body=inflater.decompress(raw,1048577)
    need(len(body)<=1048576 and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail,'history_snapshot_expansion_bound')
    return body

def incident_task_projection(db, task_id):
    # Scan the complete recorded binding history, bounded explicitly. Do not
    # mistake either a recent-send window or a truncated scan for completeness.
    rows = db.execute(
        "SELECT a.state,a.id,s.state AS send_state FROM audit a JOIN sends s ON s.id=a.id "
        "WHERE s.task=? AND a.state LIKE 'incident_binding_v1:%' ORDER BY a.seq LIMIT 2049",
        (task_id,)).fetchall()
    need(len(rows) <= 2048, 'incident_binding_history_capacity')
    history=history_read(db,'bindings',task_id)or history_read(db,'tasks',task_id)
    prior=history.get('incident_binding')if history else None
    if not rows:
        return prior or {'state': 'unknown', 'history_coverage': 'no_recorded_binding'}
    bindings = [incident_decode(row[0], row[1], row[2]) for row in rows]
    if prior and prior.get('state')=='recorded':bindings=[prior['first_recorded'],prior['latest_recorded']]+bindings
    first, latest = bindings[0], bindings[-1]
    need(all(binding['object_id'] == first['object_id'] and
             binding['object_id'][:32] == task_id for binding in bindings),
         'incident_binding_conflict')
    return {'state': 'recorded', 'object_id': first['object_id'],
            'first_recorded': first, 'latest_recorded': latest,
            'history_coverage': 'all_bindings_validated_first_and_latest_shown',
            'provenance': INCIDENT_PROVENANCE}


def workspace_thread(value):
    """Decode only the internal fixed namespace, never a path or native profile."""
    if isinstance(value, str) and value.startswith(WORKSPACE_PREFIX):
        identifier = value[len(WORKSPACE_PREFIX):]
        need(UUID.fullmatch(identifier) is not None, 'invalid_workspace_message_reference')
        return identifier
    return None


def workspace_reference(value):
    need(isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value),
         'invalid_workspace_message_reference')
    return '-'.join((value[:8], value[8:12], value[12:16], value[16:20], value[20:]))


def workspace_context(thread, plan=None):
    value = {'route': 'workspace_thread_communication', 'target_thread_id': thread,
             'delivery_mode': None, 'expected_turn_id': None,
             'profile_preserved': True, 'authority_changed': False,
             'assistant_acknowledged': False}
    if plan is not None:
        need(isinstance(plan, dict) and set(plan) == {'operation_state', 'thread_id',
             'delivery_mode', 'expected_turn_id', 'profile_preserved', 'authority_changed'}
             and plan['operation_state'] == 'ready' and plan['thread_id'] == thread
             and plan['profile_preserved'] is True and plan['authority_changed'] is False,
             'workspace_preflight_unconfirmed')
        mode, expected = plan['delivery_mode'], plan['expected_turn_id']
        need(mode in ('idle_start', 'active_steer') and
             ((mode == 'idle_start' and expected is None) or
              (mode == 'active_steer' and isinstance(expected, str) and UUID.fullmatch(expected))),
             'workspace_preflight_unconfirmed')
        value.update(delivery_mode=mode, expected_turn_id=expected)
    return value


def checked_workspace_receipt(value, thread, context, allow_ack=False, operation=None, turn=None):
    need(isinstance(value, dict) and all(value.get(k) == v for k, v in context.items() if k!='assistant_acknowledged')
         and value.get('route') == 'workspace_thread_communication'
         and value.get('target_thread_id') == thread
         and value.get('profile_preserved') is True and value.get('authority_changed') is False,
         'workspace_receipt_context_unconfirmed')
    acknowledgement=value.get('assistant_acknowledged')
    need((acknowledgement is False) if not allow_ack else
         (acknowledgement is None or type(acknowledgement) is bool),
         'workspace_ack_evidence_unconfirmed')
    if acknowledgement is True:
        evidence=value.get('acknowledgement_evidence')
        need(isinstance(evidence,dict) and set(evidence)=={'source','operation_id','turn_id','item_id'}
             and evidence['source']=='exact_operation_reference_after_delivery'
             and evidence['operation_id']==operation and evidence['turn_id']==turn
             and isinstance(evidence['item_id'],str) and re.fullmatch('[A-Za-z0-9_-]{1,128}',evidence['item_id']),
             'workspace_ack_evidence_unconfirmed')
    return value


def creation_observation(value, thread):
    need(isinstance(value, dict) and value.get('thread_id') == thread and
         value.get('state') in ('durable_ready', 'present_not_ready', 'missing_before_first_send', 'unconfirmed'),
         'creation_observation_unconfirmed')
    fields = {'state', 'thread_id'}
    if value['state'] == 'present_not_ready':
        fields.add('reason')
        need(value.get('reason') in ('thread_not_ready', 'thread_profile_changed', 'resume_unconfirmed',
                                     'project_binding_unconfirmed'),
             'creation_readiness_unconfirmed')
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
          CREATE TABLE IF NOT EXISTS history_refs(kind TEXT,id TEXT,version TEXT,PRIMARY KEY(kind,id));
          CREATE TABLE IF NOT EXISTS profile_transitions(
            id TEXT PRIMARY KEY, operation TEXT NOT NULL, thread TEXT,
            grant_sha256 TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
            receipt TEXT, created REAL NOT NULL, updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS result_checkpoints(
            id TEXT PRIMARY KEY, result_hash TEXT NOT NULL,
            terminal_state TEXT NOT NULL, reply_available INTEGER NOT NULL,
            recorded REAL NOT NULL);
        ''')

    def _archive_snapshot(self,kind,identity,snapshot):
        """FULL-sync immutable write/readback BEFORE primary row compaction."""
        main=[r[2]for r in self.db.execute('PRAGMA database_list')if r[1]=='main']
        need(len(main)==1 and main[0],'history_file_database_required')
        primary=Path(main[0]);path=primary.with_name('task-history.sqlite3');owner=primary.lstat().st_uid
        if not path.exists():
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            try:os.fchmod(fd,0o600);os.fsync(fd)
            finally:os.close(fd)
        a=path.lstat();need(stat.S_ISREG(a.st_mode)and not path.is_symlink()and a.st_uid==owner and stat.S_IMODE(a.st_mode)==0o600 and a.st_nlink==1,'history_database_custody')
        raw=json.dumps(snapshot,sort_keys=True,separators=(',',':')).encode();need(len(raw)<=1048576,'history_snapshot_bound')
        version=fingerprint(snapshot);body=zlib.compress(raw)
        archive=sqlite3.connect(path,timeout=2,isolation_level=None)
        try:
            need(archive.execute('PRAGMA page_size').fetchone()[0]==4096,'history_page_size')
            need(archive.execute('PRAGMA max_page_count=8192').fetchone()[0]==8192,'history_physical_budget')
            archive.execute('PRAGMA journal_mode=DELETE');archive.execute('PRAGMA synchronous=FULL')
            archive.execute('CREATE TABLE IF NOT EXISTS snapshots(kind TEXT,id TEXT,version TEXT,body BLOB,created REAL,PRIMARY KEY(kind,id,version))')
            archive.execute('BEGIN IMMEDIATE')
            old=archive.execute('SELECT body FROM snapshots WHERE kind=?AND id=?AND version=?',(kind,identity,version)).fetchone()
            if old:need(_bounded_history_inflate(old[0])==raw,'history_existing_snapshot_conflict')
            else:archive.execute('INSERT INTO snapshots VALUES(?,?,?,?,?)',(kind,identity,version,body,self.clock()))
            archive.execute('COMMIT')
            saved=archive.execute('SELECT body FROM snapshots WHERE kind=?AND id=?AND version=?',(kind,identity,version)).fetchone()
            need(saved is not None and _bounded_history_inflate(saved[0])==raw,'history_snapshot_readback')
        finally:
            if archive.in_transaction:archive.execute('ROLLBACK')
            archive.close()
        z=path.lstat();need((a.st_dev,a.st_ino)==(z.st_dev,z.st_ino),'history_database_replaced')
        return version

    def archive_terminal_history(self,limit=8):
        """Only settled, acknowledged rows older than the quota window retire.
        Stable tombstones keep uniqueness/IDs and original budget timestamps.
        Uncertain, active or unacknowledged rows NEVER become archive candidates.
        """
        now=self.clock();cutoff=now-86400
        profiles=self.db.execute("SELECT *FROM profile_transitions p WHERE state='confirmed'AND updated<?AND (EXISTS(SELECT 1 FROM sends s WHERE s.id=p.operation AND s.reconciled=1 AND s.state IN ('completed','failed','interrupted','not_dispatched','archived'))OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=p.operation AND t.reconciled=1 AND t.state IN ('created','archived')))ORDER BY updated LIMIT ?",(cutoff,limit)).fetchall()
        sends=self.db.execute("SELECT *FROM sends WHERE state IN ('completed','failed','interrupted','not_dispatched')AND reconciled=1 AND updated<?AND created<?AND (result IS NULL OR result!=?)ORDER BY updated LIMIT ?",(cutoff,cutoff,HISTORY_RESULT,limit)).fetchall()
        tasks=self.db.execute("SELECT *FROM tasks WHERE state='created'AND reconciled=1 AND updated<?AND NOT EXISTS(SELECT 1 FROM sends WHERE task=tasks.id AND (reconciled!=1 OR state NOT IN ('completed','failed','interrupted','not_dispatched','archived')OR created>=?OR updated>=?))AND NOT EXISTS(SELECT 1 FROM profile_transitions WHERE thread=tasks.thread AND state IN ('intent','uncertain'))ORDER BY updated LIMIT ?",(cutoff,cutoff,cutoff,limit)).fetchall()
        # Preserve first/latest association before deleting ANY per-send audit,
        # even when a task spans several bounded compaction batches.
        for task_id in sorted({r['task']for r in sends if re.fullmatch('[a-f0-9]{32}',r['task'])}):
            projection=incident_task_projection(self.db,task_id)
            snapshot={'schema':'task_exact_terminal_history_v1','kind':'bindings','id':task_id,'incident_binding':projection}
            version=self._archive_snapshot('bindings',task_id,snapshot)
            self.transaction(lambda:self.db.execute('INSERT INTO history_refs VALUES(?,?,?)ON CONFLICT(kind,id)DO UPDATE SET version=excluded.version',('bindings',task_id,version)))
        task_context={r['id']:incident_task_projection(self.db,r['id'])for r in tasks}
        for kind,rows in (('profile_transitions',profiles),('sends',sends),('tasks',tasks)):
            for row in rows:
                original=dict(row);identity=original['id'];prior_ref=self.db.execute('SELECT version FROM history_refs WHERE kind=?AND id=?',(kind,identity)).fetchone();snapshot={'schema':'task_exact_terminal_history_v1','kind':kind,'id':identity,'row':original,'previous_version':prior_ref[0]if prior_ref else None}
                if kind in ('tasks','sends'):
                    snapshot['audit']=[dict(r)for r in self.db.execute('SELECT *FROM audit WHERE id=?ORDER BY seq',(identity,))]
                if kind=='sends':
                    cp=self.db.execute('SELECT *FROM result_checkpoints WHERE id=?',(identity,)).fetchone()
                    if cp is None or not original['result']or cp['result_hash']!=fingerprint(json.loads(original['result'])):continue
                    snapshot['checkpoint']=dict(cp)
                    bound=next((r for r in snapshot['audit']if r['state'].startswith(INCIDENT_PREFIX)),None)
                    snapshot['incident_binding']=incident_decode(bound['state'],identity,original['state'])if bound else{'state':'unknown'}
                if kind=='tasks':
                    if self.db.execute("SELECT 1 FROM sends WHERE task=?AND (result IS NULL OR result!=?)LIMIT 1",(identity,HISTORY_RESULT)).fetchone():continue
                    snapshot['incident_binding']=task_context[identity]
                    snapshot['creation']=[dict(r)for r in self.db.execute('SELECT *FROM creation_results WHERE id IN (?,?)',(identity,'binding:'+identity))]
                    prior=history_read(self.db,'tasks',identity)
                    if prior:
                        existing={r['id']for r in snapshot['creation']}
                        snapshot['creation'] += [r for r in prior['creation']if r['id']not in existing]
                version=self._archive_snapshot(kind,identity,snapshot)
                def compact():
                    current=self.db.execute('SELECT *FROM '+kind+' WHERE id=?',(identity,)).fetchone()
                    need(current is not None and dict(current)==original,'history_primary_CAS_changed')
                    self.db.execute('INSERT INTO history_refs VALUES(?,?,?)ON CONFLICT(kind,id)DO UPDATE SET version=excluded.version',(kind,identity,version))
                    if kind=='profile_transitions':self.db.execute("UPDATE profile_transitions SET state='archived',receipt=NULL WHERE id=?",(identity,))
                    elif kind=='sends':
                        self.db.execute('UPDATE sends SET result=?WHERE id=?',(HISTORY_RESULT,identity));self.db.execute('DELETE FROM result_checkpoints WHERE id=?',(identity,))
                        self.db.execute('DELETE FROM audit WHERE id=?',(identity,))
                    else:
                        self.db.execute("UPDATE tasks SET state='archived'WHERE id=?",(identity,));self.db.execute('DELETE FROM creation_results WHERE id IN (?,?)',(identity,'binding:'+identity));self.db.execute('DELETE FROM audit WHERE id=?',(identity,))
                self.transaction(compact)

    def restore_history_for_source_rollback(self):
        """Own inverse before removing the history-capable source, under its lock.

        One primary transaction restores exact results/checkpoints/association
        records. Immutable archive is retained. Physical-budget failure rolls
        back all primary changes; old source MUST NOT be installed on failure.
        """
        snapshots=[]
        for ref in self.db.execute("SELECT kind,id FROM history_refs WHERE kind IN ('tasks','sends','profile_transitions')ORDER BY kind,id"):
            snapshots.append((ref['kind'],ref['id'],history_read(self.db,ref['kind'],ref['id'])))
        def restore():
            for kind,identity,snapshot in snapshots:
                need(snapshot is not None,'rollback_history_missing')
                current=self.db.execute('SELECT *FROM '+kind+' WHERE id=?',(identity,)).fetchone()
                need(current is not None,'rollback_tombstone_missing')
                row=snapshot['row']
                if kind=='tasks':
                    need(current['task_key']==row['task_key']and current['thread']==row['thread'],'rollback_task_identity_changed')
                    if current['state']=='archived':self.db.execute("UPDATE tasks SET state='created'WHERE id=?",(identity,))
                    for saved in snapshot['creation']:
                        old=self.db.execute('SELECT result FROM creation_results WHERE id=?',(saved['id'],)).fetchone()
                        if old is None:self.db.execute('INSERT INTO creation_results VALUES(?,?)',(saved['id'],saved['result']))
                elif kind=='sends':
                    if current['result']!=HISTORY_RESULT:continue
                    need(all(current[k]==row[k]for k in row if k!='result'),'rollback_send_tombstone_changed')
                    self.db.execute('UPDATE sends SET result=?WHERE id=?',(row['result'],identity))
                    cp=snapshot['checkpoint'];self.db.execute('INSERT INTO result_checkpoints VALUES(?,?,?,?,?)',(cp['id'],cp['result_hash'],cp['terminal_state'],cp['reply_available'],cp['recorded']))
                else:
                    if current['state']!='archived':continue
                    self.db.execute('UPDATE profile_transitions SET state=?,receipt=?WHERE id=?',(row['state'],row['receipt'],identity))
                if kind in ('tasks','sends'):
                    for event in snapshot['audit']:
                        if not self.db.execute('SELECT 1 FROM audit WHERE id=?AND state=?AND at=?',(event['id'],event['state'],event['at'])).fetchone():
                            self.db.execute('INSERT INTO audit(id,state,at)VALUES(?,?,?)',(event['id'],event['state'],event['at']))
            need(not self.db.execute("SELECT 1 FROM tasks WHERE state='archived'").fetchone()and not self.db.execute('SELECT 1 FROM sends WHERE result=?',(HISTORY_RESULT,)).fetchone(),'rollback_history_not_fully_restored')
        self.transaction(restore)
        return {'state':'exact_history_restored','immutable_archive_retained':True,'records':len(snapshots)}

    def activate_task(self,identity):
        row=self.db.execute('SELECT *FROM tasks WHERE id=?',(identity,)).fetchone()
        if row is None or row['state']!='archived':return
        snapshot=history_read(self.db,'tasks',identity);need(snapshot is not None,'task_archive_missing')
        original=snapshot['row'];need(original['state']=='created'and original['reconciled']==1 and original['task_key']==row['task_key']and original['thread']==row['thread'],'task_archive_identity_changed')
        def activate():
            self.db.execute("UPDATE tasks SET state='created',updated=?WHERE id=?AND state='archived'",(self.clock(),identity))
            self.audit(identity,'reactivated_from_exact_history')
        self.transaction(activate)

    def history_profile(self,identity):
        snapshot=history_read(self.db,'profile_transitions',identity);need(snapshot is not None,'profile_history_missing');return snapshot['row']

    def begin_profile_transition(self,identity,operation,thread,grant_sha256,mode):
        """Durable resume/start intent before profile mutation; no prompt stored."""
        self.archive_terminal_history()
        previous=self.db.execute('SELECT * FROM profile_transitions WHERE id=?',(identity,)).fetchone()
        if previous is not None and previous['state']=='archived':previous=history_read(self.db,'profile_transitions',identity)['row']
        if previous:
            need(previous['operation']==operation and previous['thread']==thread and previous['grant_sha256']==grant_sha256 and previous['mode']==mode,'profile_transition_identity_conflict')
            return dict(previous)
        if thread is not None:
            need(not self.db.execute("SELECT 1 FROM profile_transitions WHERE thread=? AND state IN ('intent','uncertain')",(thread,)).fetchone(),'broad_profile_uncertain_observe_same_operation')
        need(self.db.execute("SELECT count(*)FROM profile_transitions WHERE state!='archived'").fetchone()[0]<256,'profile_receipt_capacity_preserve_history')
        def write():
            now=self.clock();self.db.execute('INSERT INTO profile_transitions VALUES(?,?,?,?,?,?,?,?,?)',(identity,operation,thread,grant_sha256,mode,'intent',None,now,now))
        self.transaction(write);return None

    def finish_profile_transition(self,identity,state,reply):
        need(state in ('confirmed','uncertain'),'profile_transition_state')
        def finish():
            row=self.db.execute('SELECT * FROM profile_transitions WHERE id=?',(identity,)).fetchone()
            need(row is not None,'profile_transition_missing')
            if row['state']!='intent':return
            # RPC result is already sanitized/bounded; no input text/config or
            # credential is accepted as a receipt. Complete bytes are retained.
            body=json.dumps(reply,sort_keys=True)if reply is not None else None
            need(body is None or len(body.encode())<=16384,'profile_transition_receipt_bound')
            self.db.execute('UPDATE profile_transitions SET state=?,receipt=?,updated=?WHERE id=?',(state,body,self.clock(),identity))
        self.transaction(finish)


    def close(self):
        self.db.close()

    def row(self, table, op):
        need(table in ('tasks', 'sends'), 'invalid_table')
        row = self.db.execute('SELECT * FROM ' + table + ' WHERE id=?', (op,)).fetchone()
        result = dict(row) if row else None
        archived=history_read(self.db,table,op)if result and (table=='tasks'and result['state']=='archived'or table=='sends'and result.get('result')==HISTORY_RESULT)else None
        if archived:result={**archived['row'],'record_storage':'immutable_archive','historical_record':True}
        if result and table == 'tasks':
            result['incident_binding'] = incident_task_projection(self.db, op)
            proof = self.project_binding_proof(op)
            if proof:
                result['project_binding_proof'] = proof
        if result and table == 'sends':
            binding = self.db.execute("SELECT state FROM audit WHERE id=? AND state LIKE 'incident_binding_v1:%' ORDER BY seq LIMIT 1", (op,)).fetchone()
            result['incident_binding'] = incident_decode(binding[0], op, result['state']) if binding else archived['incident_binding']if archived else {'state': 'unknown'}
        if result and table == 'sends' and result.get('result'):
            checkpoint = self.db.execute('SELECT * FROM result_checkpoints WHERE id=?',
                                         (op,)).fetchone()
            if archived:checkpoint=archived['checkpoint']
            if checkpoint and checkpoint['result_hash'] == fingerprint(json.loads(result['result'])):
                result['central_checkpoint'] = {
                    'source': 'durable_exact_terminal_receipt_v1',
                    'operation_id': op, 'result_hash': checkpoint['result_hash'],
                    'terminal_state': checkpoint['terminal_state'],
                    'reply_text_available': bool(checkpoint['reply_available']),
                    'functional_recovery_proven': False,
                    'recorded_at': checkpoint['recorded'], 'ready_for_reconciliation': True}
        return result

    def _binding_row(self, op):
        raw = self.db.execute('SELECT result FROM creation_results WHERE id=?',
                              ('binding:' + op,)).fetchone()
        if not raw:
            snapshot=history_read(self.db,'tasks',op)
            saved=next((r for r in snapshot['creation']if r['id']=='binding:'+op),None)if snapshot else None
            if saved is None:return None
            raw=(saved['result'],)
        value = json.loads(raw[0])
        need(isinstance(value, dict) and value.get('binding') == 'eva_project_v1'
             and isinstance(value.get('project_id'), str)
             and isinstance(value.get('project_name'), str)
             and isinstance(value.get('project_root'), str)
             and value.get('verified') in (0, 1)
             and (value.get('verified_at') is None or type(value.get('verified_at')) in (int, float)),
             'task_project_binding_schema')
        return value

    def project_binding_proof(self, op):
        row = self._binding_row(op)
        if not row:
            return None
        verified = row['verified'] == 1
        latest = self.creation_result(op)
        if latest is None:
            collection_error = 'not_yet_collected'
        elif latest.get('state') == 'durable_ready':
            collection_error = None
        elif latest.get('state') == 'present_not_ready':
            collection_error = latest.get('reason') or 'readiness_unconfirmed'
        elif latest.get('state') == 'missing_before_first_send':
            collection_error = 'thread_missing_before_first_send'
        else:
            collection_error = 'creation_metadata_unconfirmed'
        age = (None if not verified or row['verified_at'] is None else
               max(0.0, self.clock() - row['verified_at']))
        covered = bool(verified)
        return {
            'binding': row['binding'], 'project_id': row['project_id'],
            'project_name': row['project_name'], 'project_root': row['project_root'],
            'verified': verified, 'verified_at': row['verified_at'] if verified else None,
            'source': 'native_project_and_durable_thread_readback_v1' if verified else None,
            'age_seconds': age, 'collection_error': collection_error,
            'coverage': {'project_identity': covered, 'thread_assignment': covered,
                         'project_root': covered, 'durable_thread_path': covered,
                         'live_membership': False},
            'historical_only': True, 'live_membership_verified': False}

    def _mark_project_binding_verified(self, op):
        # First successful complete proof wins; later failures never erase it.
        row = self._binding_row(op)
        if row and row['verified'] == 0:
            updated = {**row, 'verified': 1, 'verified_at': self.clock()}
            self.db.execute('INSERT INTO creation_results VALUES(?,?) ON CONFLICT(id) '
                            'DO UPDATE SET result=excluded.result',
                            ('binding:' + op, json.dumps(updated, sort_keys=True)))

    def _checkpoint_terminal(self, row):
        # Called inside the existing serial custody/SQL transaction. Metadata
        # only: no paths, prompts, new dispatch, or invented functional result.
        need(row and row['state'] in (*TERMINAL, 'not_dispatched') and row['result'],
             'checkpoint_requires_terminal_receipt')
        value = json.loads(row['result'])
        digest = fingerprint(value)
        prior = self.db.execute('SELECT result_hash FROM result_checkpoints WHERE id=?',
                                (row['id'],)).fetchone()
        need(not prior or prior['result_hash'] == digest, 'checkpoint_result_changed')
        reply = value.get('agent_reply')
        answer = value.get('answer')
        available = ((isinstance(reply, dict) and reply.get('state') == 'observed'
                      and isinstance(reply.get('text'), str) and bool(reply['text']))
                     or (value.get('answer_withheld') is False and isinstance(answer, dict)
                         and isinstance(answer.get('summary'), str) and bool(answer['summary'])))
        self.db.execute('INSERT OR IGNORE INTO result_checkpoints VALUES(?,?,?,?,?)',
                        (row['id'], digest, row['state'], int(available), self.clock()))
        return digest

    def _acknowledged_workspace_turn(self, thread):
        # Exempt only communication already acknowledged on this same active
        # turn. Never release an old row or an actual registered repair task.
        marks = ','.join('?' for _ in BUSY)
        need(not self.db.execute('SELECT 1 FROM tasks WHERE state IN (' + marks +
             ") OR (state='created' AND reconciled=0) LIMIT 1", BUSY).fetchone(),
             'prior_task_requires_reconciliation')
        rows = self.db.execute('SELECT * FROM sends WHERE reconciled=0 OR state IN (' +
                               marks + ')', BUSY).fetchall()
        need(0 < len(rows) < 8, 'workspace_followup_pending_limit')
        expected = None
        for raw in rows:
            row = dict(raw)
            need(row['task'] == WORKSPACE_PREFIX + thread and row['reconciled'] == 0
                 and row['state'] in ('accepted', 'inProgress') and row['turn']
                 and row['result'], 'prior_task_requires_reconciliation')
            value = json.loads(row['result'])
            # The first input may have started an idle receiver. Its immutable
            # receipt keeps idle_start/None even after that turn becomes active.
            # Validate that original delivery context; only the NEW preflight
            # must prove active_steer on the exact recorded running turn.
            context = workspace_context(thread, {
                'operation_state': 'ready', 'thread_id': thread,
                'delivery_mode': value.get('delivery_mode'),
                'expected_turn_id': value.get('expected_turn_id'),
                'profile_preserved': value.get('profile_preserved'),
                'authority_changed': value.get('authority_changed')})
            need(context['delivery_mode'] == 'idle_start'
                 or context['expected_turn_id'] == row['turn'],
                 'workspace_followup_turn_changed')
            checked_workspace_receipt(value, thread, context, allow_ack=True,
                                      operation=row['id'], turn=row['turn'])
            need(value.get('assistant_acknowledged') is True and value.get('input_accepted') is True,
                 'prior_task_requires_reconciliation')
            need(expected is None or row['turn'] == expected, 'workspace_followup_turn_changed')
            expected = row['turn']
        return expected

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
        self.archive_terminal_history()
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
            marker = {'binding': 'eva_project_v1',
                      'project_id': '${EVA_PROJECT_ID}',
                      'project_name': 'Raspberry — Eva',
                      'project_root': '/mnt/data/docker',
                      'verified': 0, 'verified_at': None}
            self.db.execute('INSERT INTO creation_results VALUES(?,?)',
                            ('binding:' + op, json.dumps(marker, sort_keys=True)))
            self.audit(op, 'create_intent')
        self.transaction(intent)
        thread = None
        reply = None
        try:
            reply = invoke({'mode': 'create', 'operation_id': op,
                            'project_binding_required': True})
            need(isinstance(reply.get('thread_id'), str) and
                 UUID.fullmatch(reply['thread_id']), 'creation_unconfirmed')
            thread = reply['thread_id']
            need(reply.get('fixed_profile_verified') is True, 'creation_profile_unconfirmed')
            need(reply.get('project_binding_verified') is True, 'creation_project_unconfirmed')
            need(reply.get('durable_thread_verified') is True, 'creation_persistence_unconfirmed')
            state = 'created'
        except Exception:
            # Retain a returned identity even if the permission profile was
            # refused. It identifies a real thread to reconcile, never to send.
            state = 'create_unknown'
        def finish():
            self.db.execute('UPDATE tasks SET thread=?,state=?,updated=? WHERE id=?',
                            (thread, state, self.clock(), op))
            proof_verified = (thread is not None and isinstance(reply, dict) and
                              reply.get('fixed_profile_verified') is True and
                              reply.get('project_binding_verified') is True and
                              reply.get('durable_thread_verified') is True)
            if proof_verified:
                self._mark_project_binding_verified(op)
            self.audit(op, state)
        self.transaction(finish)
        return self.row('tasks', op)

    def send(self, q, invoke, admission, legacy_idle, allow_workspace=False):
        need(isinstance(q, dict) and set(q) == {'operation_id', 'task_id', 'text'},
             'send_scope_refused')
        need(isinstance(q['operation_id'], str) and
             re.fullmatch('[a-f0-9]{32}', q['operation_id']), 'invalid_operation_id')
        need(isinstance(q['task_id'], str) and re.fullmatch('[a-f0-9]{32}', q['task_id']),
             'invalid_task_identifier')
        need(isinstance(q['text'], str) and 1 <= len(q['text']) <= 6000 and
             '\x00' not in q['text'], 'invalid_task_text')
        op, hashed = q['operation_id'], fingerprint(q)
        old = self.row('sends', op)
        if old:
            if old['state'] == 'not_dispatched' and old['input_hash'] == '0' * 64:
                # Imported historical refusal has no retained caller text.
                # Return its immutable no-send receipt, never admit new input.
                return {**old, 'duplicate': True, 'input_evidence': 'historical_not_retained',
                        'execution_replay_allowed': False}
            need(old['input_hash'] == hashed, 'operation_id_conflict')
            return {**old, 'duplicate': True}
        self.archive_terminal_history()
        self.activate_task(q['task_id'])
        task = self.row('tasks', q['task_id'])
        if task is None and allow_workspace is True:
            return self.send_workspace(q, invoke, admission, legacy_idle, hashed)
        # An existing task row always owns this ID, even if invalid/closed.
        # Never reinterpret that task ID as another native thread reference.
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
        rpc_binding = {'project_binding_required': True} if self._binding_row(task['id']) else {}
        try:
            invoke({'mode': 'send_preflight', 'thread_id': task['thread'], **rpc_binding})
        except Exception as error:
            reason = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]{1,60}', str(error)) else 'preflight_unconfirmed'
            result = {'operation_state': 'not_dispatched', 'send_called': False,
                      'execution_proven': False, 'reason': reason, 'automatic_retry': False}
            def refused():
                now = self.clock()
                self.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
                                (op, task['id'], hashed, 'not_dispatched', None, now, now,
                                 json.dumps(result, sort_keys=True)))
                self.audit(op, 'preflight_refused_no_dispatch')
            self.transaction(refused)
            return self.row('sends', op)
        binding, context = incident_context(q['text']) if task['task_key'].startswith('eva-workspace-') else (None, None)
        def intent():
            if binding:
                obj, revision = binding
                if context is not None:
                    spec = {'operation_id': task['id'], 'task_key': task['task_key'],
                            'objective': context['objective'], 'acceptance': context['acceptance']}
                    need(fingerprint(spec) == task['spec_hash'], 'incident_context_spec_mismatch')
                need(task['id'] == obj[:32] and task['task_key'] == 'eva-workspace-' + obj[:32]
                     and op == revision[-32:], 'incident_binding_recipe_mismatch')
                prior = incident_task_projection(self.db, task['id'])
                need(prior['state'] == 'unknown' or prior['object_id'] == obj,
                     'incident_object_collision')
            now = self.clock()
            self.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
                            (op, task['id'], hashed, 'send_intent', None, now, now, None))
            self.audit(op, 'send_intent')
            if binding:
                self.audit(op, INCIDENT_PREFIX + binding[0] + ':' + binding[1])
        self.transaction(intent)
        try:
            reply = invoke({'mode': 'send', 'thread_id': task['thread'],
                            'operation_id': op, 'text': q['text'], **rpc_binding})
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

    def send_workspace(self, q, invoke, admission, legacy_idle, hashed):
        """One new message to an existing project thread; no task/SQL migration."""
        thread = workspace_reference(q['task_id'])
        namespace = WORKSPACE_PREFIX + thread
        need(self.row('tasks', q['task_id']) is None, 'workspace_reference_task_collision')
        # All normal serial gates remain. A bounded same-turn followup may
        # coexist only with exact acknowledged communication, never repair work.
        followup_turn = None
        try:
            self.idle()
        except ValueError as error:
            need(str(error) in ('prior_task_requires_reconciliation',
                               'result_requires_central_reconciliation'), str(error))
            followup_turn = self._acknowledged_workspace_turn(thread)
        legacy_idle()
        references = self.db.execute("SELECT count(DISTINCT task) FROM sends WHERE task LIKE 'workspace:%'").fetchone()[0]
        already = self.db.execute('SELECT 1 FROM sends WHERE task=? LIMIT 1', (namespace,)).fetchone()
        need(already or references < MAX_WORKSPACE_REFERENCES, 'workspace_reference_capacity')
        count = self.db.execute('SELECT count(*) FROM sends WHERE created>?',
                                (self.clock() - 86400,)).fetchone()[0]
        latest = self.db.execute('SELECT max(created) FROM sends').fetchone()[0]
        admission(count, latest)
        op = q['operation_id']
        context = workspace_context(thread)
        try:
            plan = invoke({'mode': 'workspace_message_preflight', 'thread_id': thread})
            context = workspace_context(thread, plan)
            if followup_turn is not None:
                need(context['delivery_mode'] == 'active_steer'
                     and context['expected_turn_id'] == followup_turn,
                     'workspace_followup_turn_changed')
        except Exception as error:
            reason = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]{1,60}', str(error)) else 'preflight_unconfirmed'
            extra = ({'prior_acknowledged_turn_id': followup_turn}
                     if followup_turn is not None and reason == 'workspace_followup_turn_changed' else {})
            result = {**context, **extra, 'operation_state': 'not_dispatched', 'send_called': False,
                      'execution_proven': False, 'reason': reason, 'automatic_retry': False}
            def refused():
                now = self.clock()
                self.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
                    (op, namespace, hashed, 'not_dispatched', None, now, now, json.dumps(result, sort_keys=True)))
                self.audit(op, 'workspace_preflight_refused_no_dispatch')
            self.transaction(refused)
            return self.row('sends', op)
        def intent():
            now = self.clock()
            result = {**context, 'operation_state': 'send_intent', 'input_accepted': None,
                      'automatic_retry': False}
            self.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,0)',
                (op, namespace, hashed, 'send_intent', None, now, now, json.dumps(result, sort_keys=True)))
            self.audit(op, 'send_intent')
        self.transaction(intent)
        try:
            reply = invoke({'mode': 'workspace_message', 'thread_id': thread,
                'operation_id': op, 'text': q['text'], 'delivery_mode': context['delivery_mode'],
                'expected_turn_id': context['expected_turn_id']})
            checked_workspace_receipt(reply, thread, context)
            need(reply.get('operation_state') == 'accepted' and reply.get('input_accepted') is True
                 and isinstance(reply.get('turn_id'), str) and UUID.fullmatch(reply['turn_id'])
                 and (context['delivery_mode'] != 'active_steer' or reply['turn_id'] == context['expected_turn_id']),
                 'workspace_send_unconfirmed')
            result = reply
            state, turn = 'accepted', reply['turn_id']
        except Exception:
            # In particular, completion of the expected old receiver turn can
            # never prove that an uncertain steer was delivered. Do not record
            # it as an accepted turn or automatically retry the input.
            result = {**context, 'operation_state': 'send_unknown', 'input_accepted': None,
                      'automatic_retry': False}
            state, turn = 'send_unknown', None
        raw = json.dumps(result, sort_keys=True)
        need(len(raw.encode()) <= 8192, 'result_limit')
        def finish():
            self.db.execute('UPDATE sends SET state=?,turn=?,result=?,updated=? WHERE id=?',
                (state, turn, raw, self.clock(), op))
            self.audit(op, state)
        self.transaction(finish)
        return self.row('sends', op)

    def observe(self, op, invoke):
        row = self.row('sends', op)
        need(row is not None, 'send_not_found')
        # Observation failure never changes state to terminal or replays a send.
        if row['state'] in ('accepted', 'inProgress', 'outcome_unknown') and row['turn']:
            thread = workspace_thread(row['task'])
            if thread is not None:
                previous = json.loads(row['result'])
                context = workspace_context(thread)
                context.update(delivery_mode=previous.get('delivery_mode'),
                               expected_turn_id=previous.get('expected_turn_id'))
                reply = invoke({'mode': 'workspace_message_observe', 'thread_id': thread,
                    'turn_id': row['turn'], 'operation_id': op,
                    'delivery_mode': context['delivery_mode'], 'expected_turn_id': context['expected_turn_id'],
                    'reply_boundary':previous.get('reply_boundary',{'state':'unknown','item_id':None}),
                    'known_ack':previous.get('acknowledgement_evidence')})
                checked_workspace_receipt(reply, thread, context,allow_ack=True,operation=op,turn=row['turn'])
                need(reply.get('input_accepted') is True and type(reply.get('answer_withheld')) is bool
                     and reply.get('completion_scope') == 'receiver_turn_and_bounded_agent_reply',
                     'workspace_observation_unconfirmed')
                prior_reply = previous.get('agent_reply')
                current_reply = reply.get('agent_reply')
                if (isinstance(prior_reply, dict) and prior_reply.get('state') == 'observed'
                        and isinstance(prior_reply.get('text'), str) and bool(prior_reply['text'])
                        and prior_reply.get('operation_reference_observed') is True
                        and prior_reply.get('ordering_after_delivery_proven') is True
                        and isinstance(previous.get('acknowledgement_evidence'), dict)
                        and reply.get('assistant_acknowledged') is True
                        and reply.get('acknowledgement_evidence') == previous.get('acknowledgement_evidence')
                        and isinstance(current_reply, dict)
                        and current_reply.get('collection_error') == 'verified_ack_retained_reply_not_in_bounded_page'):
                    reply = {**reply, 'answer_withheld': False,
                             'agent_reply': {**prior_reply, 'retained_from_prior_verified_observation': True}}
            else:
                task = self.row('tasks', row['task'])
                need(task and task['thread'], 'task_not_admitted')
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
        current = self.row('sends', op)
        if current['state'] in (*TERMINAL, 'not_dispatched'):
            self.transaction(lambda: self._checkpoint_terminal(self.row('sends', op)))
        return self.row('sends', op)

    def creation_result(self, op):
        row = self.db.execute('SELECT result FROM creation_results WHERE id=?', (op,)).fetchone()
        if row is None:
            snapshot=history_read(self.db,'tasks',op)
            saved=next((r for r in snapshot['creation']if r['id']==op),None)if snapshot else None
            return json.loads(saved['result'])if saved else None
        return json.loads(row[0])

    def observe_creation(self, op, invoke):
        task = self.row('tasks', op)
        need(task is not None, 'task_not_found')
        previous = self.creation_result(op)
        if (task['state'] not in ('created', 'create_unknown') or not task['thread'] or
            self.db.execute('SELECT 1 FROM sends WHERE task=? LIMIT 1', (op,)).fetchone()):
            return {**task, **({'result': json.dumps(previous)} if previous else {})}
        # Runtime failures are observations, never authorization to start again.
        rpc_binding = {'project_binding_required': True} if self._binding_row(op) else {}
        observed = creation_observation(invoke({'mode': 'creation_probe', 'thread_id': task['thread'],
                                                **rpc_binding}), task['thread'])
        result = {**observed, 'kind': 'creation', 'operation_id': op, 'send_rows': 0}
        raw = json.dumps(result, sort_keys=True)
        need(len(raw.encode()) <= 2048, 'creation_observation_limit')
        def persist():
            self.db.execute('INSERT INTO creation_results VALUES(?,?) ON CONFLICT(id) '
                            'DO UPDATE SET result=excluded.result', (op, raw))
            if observed['state'] == 'durable_ready' and task['state'] == 'create_unknown':
                self.db.execute('UPDATE tasks SET state=?,updated=? WHERE id=?',
                                ('created', self.clock(), op))
            if observed['state'] == 'durable_ready' and self._binding_row(op):
                self._mark_project_binding_verified(op)
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
        rpc_binding = {'project_binding_required': True} if self._binding_row(op) else {}
        current = creation_observation(invoke({'mode': 'creation_probe', 'thread_id': task['thread'],
                                               **rpc_binding}), task['thread'])
        current = {**current, 'kind': 'creation', 'operation_id': op, 'send_rows': 0}
        need(fingerprint(current) == result_hash, 'creation_observation_changed')
        def finish():
            self.db.execute('UPDATE tasks SET state=?,reconciled=1,updated=? WHERE id=?',
                            ('creation_lost_before_send', self.clock(), op))
            self.audit(op, 'creation_lost_centrally_reconciled')
        self.transaction(finish)
        return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash,
                'state': 'creation_lost_before_send'}

    def reconcile(self, op, result_hash):
        """Durably checkpoint and acknowledge an exact terminal receipt.

        No client file write is needed. Missing reply text remains unknown;
        reconciliation cannot release uncertain/running work or prove recovery.
        """
        row = self.row('sends', op)
        need(row and row['state'] in (*TERMINAL, 'not_dispatched') and row['result'], 'not_terminal')
        need(fingerprint(json.loads(row['result'])) == result_hash, 'result_hash_conflict')
        if row['reconciled'] and row['state'] != 'not_dispatched':
            return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash}
        def finish():
            current = self.row('sends', op)
            need(current and current['task'] == row['task'] and current['turn'] == row['turn']
                 and current['state'] == row['state'] and current['result'] == row['result']
                 and fingerprint(json.loads(current['result'])) == result_hash, 'result_changed')
            if current['state'] == 'not_dispatched':
                proof = json.loads(current['result'])
                need(isinstance(proof, dict) and proof.get('operation_state') == 'not_dispatched'
                     and proof.get('send_called') is False and proof.get('execution_proven') is False
                     and current['turn'] is None, 'not_dispatched_proof_unconfirmed')
                thread = workspace_thread(current['task'])
                task = self.row('tasks', current['task']) if thread is None else None
                if thread is not None:
                    context = workspace_context(thread)
                    if proof.get('delivery_mode') is not None:
                        context = workspace_context(thread, {
                            'operation_state': 'ready', 'thread_id': thread,
                            'delivery_mode': proof.get('delivery_mode'),
                            'expected_turn_id': proof.get('expected_turn_id'),
                            'profile_preserved': True, 'authority_changed': False})
                    checked_workspace_receipt(proof, thread, context)
                else:
                    need(task is not None and task['state'] == 'created' and task['thread']
                         and UUID.fullmatch(task['thread']), 'task_not_admitted')
                if task is not None and not task['reconciled']:
                    marks = ','.join('?' for _ in BUSY)
                    need(not self.db.execute('SELECT 1 FROM sends WHERE task=? AND id!=? AND '
                        '(state IN (' + marks + ') OR reconciled=0) LIMIT 1',
                        (current['task'], op, *BUSY)).fetchone(), 'task_has_other_unresolved_sends')
                    self.db.execute('UPDATE tasks SET reconciled=1 WHERE id=? AND reconciled=0', (current['task'],))
                    self.audit(op, 'no_dispatch_reservation_released')
            self._checkpoint_terminal(current)
            if not current['reconciled']:
                self.db.execute('UPDATE sends SET reconciled=1 WHERE id=?', (op,))
                self.audit(op, 'centrally_reconciled')
        self.transaction(finish)
        return {'operation_id': op, 'reconciled': True, 'result_hash': result_hash}
