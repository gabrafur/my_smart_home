"""Historical-only restore with consumed-ID fencing; no service or grant writes.

Old operations/receipts are never installed at their live controller filenames.
A durable pending fence precedes every data write. Reconciliation verifies
existing bytes only; it never repeats an interrupted copy.
"""
from pathlib import Path
import copy,hashlib,json,os,re
from maintenance_journal import canonical,digest,closed,hex64,uint,validate_operation,validate_snapshot,Journal,MaintenanceUnavailable
from maintenance_archive import Archive
from recovery_data import directory,read,put,syncdir,restore_data,validated_data
from authorization_gate import AuthorizationGate

INDEX='restored-history.json'
MAX_OPERATIONS=4112
MAX_GENERATIONS=64
MAX_RECORD=69632
KINDS=('backup-plan','backup-rescue','binding','source-policy-seal')

def need(value,reason='restored_history_invalid'):
    if not value:raise MaintenanceUnavailable(reason)

def envelope(body):return {'body':body,'sha256':digest(body)}

class ReadOnlyFiles:
    """Read adapter for a sealed snapshot, without creating a journal lock."""
    read_only=True
    def __init__(self,root):
        self.root=directory(root,0,0,0o700);info=self.root.stat();self.identity=(info.st_dev,info.st_ino)
        self.state_fd=None
    def _anchors(self):
        directory(self.root,0,0,0o700);info=self.root.stat();need((info.st_dev,info.st_ino)==self.identity)
    def _read(self,_fd,name,mode):
        self._anchors();need(type(name)is str and '/'not in name and name not in('.','..')and mode==0o600)
        return read(self.root/name,0,0,mode,1048576)

class History:
    def __init__(self,transaction):self.tx=transaction;self.reader=Archive(transaction)
    def checked(self,snapshot,*,pending=False):
        body=snapshot['body']if snapshot else {}
        if body.get('schema_version')==3:
            need(pending or body['history_restore_state']=='complete','maintenance_restore_pending')
        try:raw,value=self.reader._read(INDEX)
        except FileNotFoundError:
            need(body.get('schema_version')!=3,'restored_history_anchor_changed');return None
        need(body.get('schema_version')==3,'restored_history_anchor_changed')
        closed(value,['body','sha256']);v=value['body'];closed(v,['schema_version','sources','operations'])
        need(type(v['schema_version'])is int and v['schema_version']==1 and value['sha256']==digest(v))
        sources=v['sources'];rows=v['operations']
        need(type(sources)is list and 1<=len(sources)<=MAX_GENERATIONS and all(hex64(s)for s in sources)
          and len(set(sources))==len(sources))
        need(type(rows)is list and len(rows)<=MAX_OPERATIONS)
        seen=set()
        for row in rows:
            closed(row,['operation_id','record_sha256']);identity=row['operation_id']
            need(type(identity)is str and re.fullmatch('[a-f0-9]{32}',identity)and identity not in seen and hex64(row['record_sha256']))
            seen.add(identity)
        need(value['sha256']==body['restored_history_sha256']and len(rows)==uint(body['restored_operations'],64),
          'restored_history_anchor_changed')
        return raw,value
    def consumed(self,identity,snapshot):
        index=self.checked(snapshot)
        return bool(index and any(r['operation_id']==identity for r in index[1]['body']['operations']))
    def record(self,row):
        identity=row['operation_id'];name='restored-operation-'+identity+'.json'
        raw,value=self.reader._read(name);closed(value,['body','sha256']);body=value['body']
        closed(body,['schema_version','operation','receipts'])
        need(type(body['schema_version'])is int and body['schema_version']==1 and len(raw)<=MAX_RECORD
          and value['sha256']==digest(body)==row['record_sha256'])
        operation=validate_operation(body['operation']);need(operation['operation_id']==identity)
        receipts=body['receipts'];need(type(receipts)is list and len(receipts)<=4)
        seen=set()
        for receipt in receipts:
            closed(receipt,['kind','bytes','sha256']);kind=receipt['kind']
            need(kind in KINDS and kind not in seen and type(receipt['bytes'])is int and 0<=receipt['bytes']<=65536 and hex64(receipt['sha256']))
            seen.add(kind)
        return name,raw,body
    def files(self,snapshot,*,pending=False):
        index=self.checked(snapshot,pending=pending)
        if index is None:return
        yield INDEX,index[0]
        for row in index[1]['body']['operations']:
            name,raw,body=self.record(row);yield name,raw;operation=body['operation']
            for item in body['receipts']:
                name='restored-receipt-'+item['kind']+'-'+operation['operation_id']+'.json'
                raw,value=self.reader._read(name)
                need(len(raw)==item['bytes']and hashlib.sha256(raw).hexdigest()==item['sha256'])
                check_receipt(value,operation);yield name,raw
        need(self.checked(snapshot,pending=pending)==index,'restored_history_changed')

def check_receipt(value,operation):
    closed(value,['body','sha256']);body=value['body']
    need(type(body)is dict and body.get('operation_id')==operation['operation_id']and
      body.get('approval_sha256')==operation['approval_sha256']and value['sha256']==digest(body))

def source_plan(snapshot,manifest):
    """Flatten existing history without turning any old operation into live state."""
    tx=ReadOnlyFiles(Path(snapshot)/'history');reader=Archive(tx)
    _,state=reader._read('maintenance.json');validate_snapshot(state)
    archive=reader.checked(state);history=History(tx);imported=history.checked(state)
    output={};operations={};source_files={'maintenance.json'}
    if archive:
        source_files.add('maintenance-archive.json')
        source_files.update('maintenance-archive-'+r['operation_id']+'.json'for r in archive[1]['body']['operations'])
    if imported:
        output.update(history.files(state))
        source_files.update(output)
        for row in imported[1]['body']['operations']:
            _,_,body=history.record(row);operations[row['operation_id']]=body['operation']
    imported_ids=set(operations)
    def current():
        yield from state['body']['operations']
        for row in archive[1]['body']['operations']if archive else []:yield reader.load(row)[1]
    for operation in current():
        identity=operation['operation_id']
        need(identity not in imported_ids,'restored_history_conflict')
        if identity in operations:
            need(operations[identity]==operation,'restored_history_conflict');continue
        operations[identity]=operation;receipts=[]
        for kind in KINDS:
            try:raw,value=reader._read(kind+'-'+identity+'.json')
            except FileNotFoundError:continue
            need(len(raw)<=65536);check_receipt(value,operation)
            source_files.add(kind+'-'+identity+'.json')
            receipts.append({'kind':kind,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
            output['restored-receipt-'+kind+'-'+identity+'.json']=raw
        record=envelope({'schema_version':1,'operation':operation,'receipts':receipts})
        raw=canonical(record);need(len(raw)<=MAX_RECORD,'restored_history_capacity')
        output['restored-operation-'+identity+'.json']=raw
    need(len(operations)<=MAX_OPERATIONS,'restored_history_capacity')
    job=operations.get(manifest['operation_id'])
    need(job is not None and job['records'][-1]['body']['phase']=='consumer_stopped','restored_history_job_missing')
    sources=copy.deepcopy(imported[1]['body']['sources'])if imported else []
    source_sha=digest(manifest);need(source_sha not in sources,'restored_history_cycle')
    sources.append(source_sha);need(len(sources)<=MAX_GENERATIONS,'restored_history_capacity')
    rows=[]
    for identity in sorted(operations):
        record=json.loads(output['restored-operation-'+identity+'.json']);rows.append({'operation_id':identity,'record_sha256':record['sha256']})
    index=envelope({'schema_version':1,'sources':sources,'operations':rows});output[INDEX]=canonical(index)
    need(len(output[INDEX])<=1048576,'restored_history_capacity')
    declared={r['path'].split('/',1)[1]for r in manifest['files']if r['path'].startswith('history/')}
    need(declared==source_files,'restored_history_inventory_unaccounted')
    return output,index

def disabled(paths):
    gate=AuthorizationGate(paths.runtime,paths.authorization)
    try:
        current,_=gate._read();need(current['enabled']is False,'restore_requires_disabled_authorization');gate.refresh()
    finally:gate.close()
    return current,read(paths.authorization,0,0,0o600,4096)

def verify_data(paths,snapshot):
    value=json.loads(read(Path(snapshot)/'data/manifest.json',0,0,0o600,8192))
    mapping={'state.sqlite3':(paths.ledger,0,0),'consumer-state.json':(paths.consumer/'state.json',1000,1000),
             'consumer-ack.json':(paths.consumer/'ack.json',1000,1000)}
    for name,item in value['files'].items():
        need(name in mapping);target,uid,gid=mapping[name]
        raw=read(target,uid,gid,0o600,item['bytes']);need(hashlib.sha256(raw).hexdigest()==item['sha256'],'restored_data_changed')
    need(read(paths.consumer/'lock',1000,1000,0o600,0)==b'')
    need(not(paths.consumer/'prepared.json').exists(),'restored_data_changed')
    if 'consumer-ack.json'not in value['files']:need(not(paths.consumer/'ack.json').exists(),'restored_data_changed')

def finish(paths,snapshot,journal,manifest,authorization,files):
    state=journal.status();need(state is not None and state['body']['schema_version']==3)
    body=state['body'];need(body['restore_snapshot_sha256']==digest(manifest)and
      body['restore_authorization_sha256']==hashlib.sha256(authorization).hexdigest(),'restore_identity_changed')
    need(disabled(paths)[1]==authorization,'restore_authorization_changed')
    actual=dict(History(journal.tx).files(state,pending=True));need(actual==files,'restored_history_changed')
    names={p.name for p in Path(paths.maintenance).iterdir()if p.name.startswith(('restored-operation-','restored-receipt-'))or p.name==INDEX}
    need(names==set(files),'restored_history_changed');verify_data(paths,snapshot)
    if body['history_restore_state']=='pending':
        complete=copy.deepcopy(body);complete['history_restore_state']='complete';complete['revision']=str(uint(body['revision'],64)+1)
        value=envelope(complete);validate_snapshot(value);need(journal.status()==state,'maintenance_concurrent_change')
        journal.tx._anchors();journal.tx._atomic(journal.tx.state_fd,'maintenance.json',canonical(value),0o600)
    return {'state':'historical_data_restored_current_authority_unchanged','consumed_operation_ids':len(json.loads(files[INDEX])['body']['operations']),
      'historical_only':True,'old_effects_replayed':False,'authorization_enabled':False,'full24h_proven':False,'consumer_runtime_validation':'pending'}

def restore_snapshot(paths,snapshot,*,reconcile=False):
    from backup_snapshot import artifact
    need(os.geteuid()==os.getegid()==0,'restore_role_invalid')
    directory(paths.state,0,0,0o700);directory(paths.runtime,0,0,0o755);directory(paths.consumer,1000,1000,0o700)
    directory(paths.maintenance,0,0,0o700)
    raw=read(Path(snapshot)/'backup-snapshot.json',0,0,0o600,16*1048576);header=json.loads(raw)
    manifest=artifact(snapshot,header['operation_id']);files,index=source_plan(snapshot,manifest)
    validated_data(Path(snapshot)/'data')
    current,authorization=disabled(paths)
    journal=Journal(paths.maintenance,current['approval_id'])
    try:
        if reconcile:return finish(paths,snapshot,journal,manifest,authorization,files)
        need(journal.status()is None and not paths.ledger.exists()and
          not any((paths.consumer/n).exists()for n in('state.json','ack.json','lock','prepared.json')),'restore_existing_state_refused')
        need(not any(p.name.startswith(('maintenance-archive','restored-'))for p in Path(paths.maintenance).iterdir()),'restore_existing_state_refused')
        fence={'schema_version':3,'revision':'1','operations':[],'archived_operations':'0','archive_sha256':None,
          'restored_operations':str(len(index['body']['operations'])),'restored_history_sha256':index['sha256'],
          'history_restore_state':'pending','restore_snapshot_sha256':digest(manifest),
          'restore_authorization_sha256':hashlib.sha256(authorization).hexdigest()}
        value=envelope(fence);validate_snapshot(value)
        journal.tx._atomic(journal.tx.state_fd,'maintenance.json',canonical(value),0o600)
        # All later failures retain this fence. Reconciliation cannot recopy.
        for name,data in files.items():
            journal.tx._anchors();put(Path(paths.maintenance)/name,data)
        syncdir(paths.maintenance);restore_data(paths,Path(snapshot)/'data')
        return finish(paths,snapshot,journal,manifest,authorization,files)
    finally:journal.close()
