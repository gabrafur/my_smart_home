"""Bounded fixed-purpose SQLite custody; no SQL/path argument on the CLI.

Only the collector identity can commit. MCP uses read-only access through its
separately approved fixed reader. SQLite, not a rename temp file, provides
crash recovery. The existing notification/event stores are never modified.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import sqlite3
import stat
import sys

ROOT=Path('/var/lib/raspberry-ha-notices')
DATABASE=ROOT/'private-content.sqlite3'
MAX_PAYLOAD=4*1024*1024
MAX_DATABASE=8*1024*1024
HEX=re.compile('[0-9a-f]{64}\\Z')


class Refused(ValueError):pass
def need(ok,reason):
    if not ok:raise Refused(reason)
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')
def digest(raw):return hashlib.sha256(raw).hexdigest()
def array_hash(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf8')).hexdigest()
def metadata(info):return(info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode,info.st_nlink)


def validate_snapshot(s):
    need(type(s)is dict and s.get('schema_version')==1 and s.get('source')=='private_household_notice_records_v1'
         and type(s.get('records'))is list and len(s['records'])<=1024
         and type(s.get('events'))is list and len(s['events'])<=256
         and type(s.get('current'))is dict and len(s['current'])<=512,'invalid_private_snapshot')
    need(type(s.get('sequence'))is int and type(s.get('evicted_events'))is int and
         s['sequence']==s['evicted_events']+len(s['events'])and s['evicted_events']>=0,'private_sequence_changed')
    records={}
    for r in s['records']:
        need(type(r)is dict and r.get('source')=='homeassistant.persistent_notification.private_text'
             and all(type(r.get(k))is str and HEX.fullmatch(r[k])for k in('object_id','revision','content_digest'))
             and type(r.get('text'))is dict and set(r['text'])=={'title','message'}
             and all(type(x)is str for x in r['text'].values())and r.get('untrusted_source_text')is True
             and r.get('execution_authority')is False and r.get('mime_type')=='text/plain'
             and r.get('content_complete')is True,'invalid_private_record')
        need(r['content_digest']==array_hash([r['text']['title'],r['text']['message']])and
             r['revision']==array_hash(['private-notice-v1',r['object_id'],r.get('source_occurred_at'),r['content_digest']]),
             'private_content_digest_changed')
        text_bytes=len(json.dumps(r['text'],ensure_ascii=False,separators=(',',':')).encode('utf8'))
        need(type(r.get('content_bytes'))is int and r['content_bytes']==text_bytes<=262144
             and type(r.get('redacted_fields'))is list and len(r['redacted_fields'])<=16
             and r.get('complete_except_protected_secret_values')is True,'private_text_scope_changed')
        key=(r['object_id'],r['revision']);need(key not in records,'duplicate_private_record');records[key]=r
    for ident,rev in s['current'].items():need((ident,rev)in records,'private_current_content_missing')
    for index,e in enumerate(s['events']):
        need(type(e)is dict and e.get('phase')in('added','updated','removed')and
             all(type(e.get(k))is str and HEX.fullmatch(e[k])for k in('object_id','revision','event_id'))
             and e.get('sequence')==s['evicted_events']+index+1
             and e['event_id']==array_hash([e['object_id'],e['revision'],e['phase'],e['sequence']])
             and e.get('recovery_proven')is False,'private_event_changed')
    raw=canonical(s);need(len(raw)<=MAX_PAYLOAD,'private_payload_limit');return raw


class Store:
    def __init__(self,path=DATABASE,owner=None):
        self.path=Path(path);self.owner=pwd.getpwnam('raspberry-ha-notices').pw_uid if owner is None else owner
    def guard(self,exists=True):
        # Production path is literal; the constructor path is not a CLI input.
        parent=self.path.parent.lstat();need(stat.S_ISDIR(parent.st_mode)and parent.st_uid==self.owner
            and not stat.S_IMODE(parent.st_mode)&0o022 and not os.listxattr(self.path.parent),'unsafe_private_directory')
        try:s=self.path.lstat()
        except FileNotFoundError:
            need(not exists,'private_store_not_created');return None
        need(stat.S_ISREG(s.st_mode)and s.st_uid==self.owner and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
             and s.st_size<=MAX_DATABASE and not os.listxattr(self.path),'unsafe_private_database')
        for suffix in('-journal','-wal','-shm'):
            p=Path(str(self.path)+suffix)
            if p.exists()or p.is_symlink():
                x=p.lstat();need(stat.S_ISREG(x.st_mode)and x.st_uid==self.owner and x.st_nlink==1
                    and not stat.S_IMODE(x.st_mode)&0o077 and x.st_size<=MAX_DATABASE,'unsafe_private_journal')
        return s
    def connect(self,write=False):
        before=self.guard(exists=not write)
        if write:
            need(os.getuid()==os.geteuid()==self.owner,'collector_identity_required')
            need(os.umask(0o077)==0o077,'private_umask_required')
            if before is None:
                fd=os.open(self.path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.fsync(fd);os.close(fd)
            self.guard();db=sqlite3.connect(str(self.path),timeout=0,isolation_level=None)
            db.execute('PRAGMA synchronous=FULL');db.execute('PRAGMA journal_mode=DELETE')
            need(db.execute('PRAGMA max_page_count=2048').fetchone()[0]<=2048,'private_database_capacity')
            db.execute('CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL,digest TEXT NOT NULL)')
        else:
            db=sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,timeout=0,isolation_level=None)
            db.execute('PRAGMA query_only=ON')
        after=self.guard()
        if before is not None:need(metadata(before)==metadata(after),'private_database_replaced')
        return db
    def load(self):
        before=self.guard(exists=False)
        if before is None:return {'snapshot':None,'digest':None,'collection_error':'private_store_not_created'}
        db=self.connect()
        try:
            row=db.execute('SELECT payload,digest FROM snapshot WHERE id=1').fetchone()
            if row is None:return {'snapshot':None,'digest':None,'collection_error':'private_store_empty'}
            raw=row[0].encode('utf8');need(len(raw)<=MAX_PAYLOAD and digest(raw)==row[1],'private_snapshot_digest_changed')
            data=json.loads(raw);need(validate_snapshot(data)==raw,'private_snapshot_encoding_changed')
            need(metadata(before)==metadata(self.guard()),'private_database_replaced')
            return {'snapshot':data,'digest':row[1],'collection_error':None}
        finally:db.close()
    def commit(self,snapshot,expected_digest):
        need(expected_digest is None or type(expected_digest)is str and HEX.fullmatch(expected_digest),'invalid_CAS_digest')
        raw=validate_snapshot(snapshot);wanted=digest(raw);db=self.connect(write=True)
        try:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT digest FROM snapshot WHERE id=1').fetchone();current=row[0]if row else None
            if current==wanted:
                db.execute('ROLLBACK');return {'state':'existing_observation_only','digest':wanted,'automatic_retry':False}
            need(current==expected_digest,'private_snapshot_CAS_changed')
            db.execute('INSERT OR REPLACE INTO snapshot VALUES(1,?,?)',(raw.decode('utf8'),wanted));db.execute('COMMIT')
            self.guard();return {'state':'private_observation_committed','digest':wanted,'automatic_retry':False}
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        finally:db.close()
    def observe_writer_state(self):
        # Explicit collector-side mutation: initialise/recover only this derived
        # database through SQLite. The MCP load method NEVER calls this.
        db=self.connect(write=True);db.close();return self.load()


def main():
    need(sys.flags.isolated and sys.flags.no_site and len(sys.argv)==2 and sys.argv[1]in('load','commit','observe-writer-state'),'fixed_private_store_invocation')
    owner=pwd.getpwnam('raspberry-ha-notices').pw_uid
    need(os.getuid()==os.geteuid()==owner,'collector_identity_required')
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(2,2))
    resource.setrlimit(resource.RLIMIT_AS,(128*1024*1024,128*1024*1024));resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_DATABASE*2,MAX_DATABASE*2))
    store=Store()
    if sys.argv[1]=='load':return store.load()
    if sys.argv[1]=='observe-writer-state':return store.observe_writer_state()
    raw=sys.stdin.buffer.read(MAX_PAYLOAD+65537);need(len(raw)<=MAX_PAYLOAD+65536,'private_input_limit');value=json.loads(raw)
    need(type(value)is dict and set(value)=={'snapshot','expected_digest'},'fixed_private_input')
    return store.commit(value['snapshot'],value['expected_digest'])


if __name__=='__main__':
    try:result=main()
    except Exception as error:result={'state':'collection_failed','collection_error':str(error)if isinstance(error,Refused)else type(error).__name__,'automatic_retry':False}
    print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
