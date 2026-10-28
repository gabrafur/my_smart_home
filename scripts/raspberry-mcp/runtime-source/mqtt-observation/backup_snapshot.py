"""Private, bounded snapshot and streaming transport; never exports authority.

Only the fixed backup CLI supplies real paths and a checked stopped-source
boundary. History is evidence, including old policy bytes, never a permission.
"""
from pathlib import Path
import base64,datetime,hashlib,json,os,re
from recovery_data import snapshot_data,directory,read,put,syncdir,RecoveryUnavailable
from maintenance_journal import canonical,pairs

SCOPE='mqtt_metadata_backup_snapshot_v1'
MAX_BYTES=64*1048576
MAX_FILES=20566
MAX_MANIFEST=8*1048576
CHUNK_BYTES=32768
DATA={'state.sqlite3':1048576,'consumer-state.json':131072,'consumer-ack.json':4096,'manifest.json':8192}
HISTORY=re.compile(r'(?:maintenance(?:-archive)?\.json|maintenance-archive-[a-f0-9]{32}\.json|(?:backup-plan-|backup-rescue-|binding-|source-policy-seal-)[a-f0-9]{32}\.json)')

def need(value,reason='backup_snapshot_invalid'):
    if not value:raise RecoveryUnavailable(reason)

def file_limit(name):
    need(type(name)is str and name.count('/')==1)
    folder,base=name.split('/')
    if folder=='data'and base in DATA:return DATA[base]
    if folder=='history'and HISTORY.fullmatch(base):return 1048576 if base in('maintenance.json','maintenance-archive.json')else 65536
    raise RecoveryUnavailable('backup_snapshot_path_refused')

def role(name):return 'observer_data'if name.startswith('data/')else'historical_maintenance_data_not_authority'

def artifact(root,operation_id):
    root=directory(root,0,0,0o700)
    raw=read(root/'backup-snapshot.json',0,0,0o600,MAX_MANIFEST)
    value=json.loads(raw,object_pairs_hook=pairs)
    need(canonical(value)==raw and type(value)is dict and set(value)=={'schema_version','scope','operation_id',
        'captured_at_utc','consistency','full24h_proven','current_authority_included','files'})
    need(type(value['schema_version'])is int and value['schema_version']==1 and value['scope']==SCOPE
      and type(operation_id)is str and re.fullmatch('[a-f0-9]{32}',operation_id)
      and value['operation_id']==operation_id and value['consistency']=='coordinated_metadata_cut'
      and value['full24h_proven']is False and value['current_authority_included']is False)
    stamp=value['captured_at_utc']
    need(type(stamp)is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)',stamp))
    need(datetime.datetime.fromisoformat(stamp).utcoffset()==datetime.timedelta(0))
    rows=value['files'];need(type(rows)is list and 4<=len(rows)<=MAX_FILES)
    seen=set();total=0
    for row in rows:
        need(type(row)is dict and set(row)=={'path','bytes','sha256','role'})
        name=row['path'];limit=file_limit(name)
        need(name not in seen and type(row['bytes'])is int and 0<=row['bytes']<=limit
          and type(row['sha256'])is str and re.fullmatch('[a-f0-9]{64}',row['sha256'])and row['role']==role(name))
        directory(root/name.split('/')[0],0,0,0o700)
        data=read(root/name,0,0,0o600,limit)
        need(len(data)==row['bytes']and hashlib.sha256(data).hexdigest()==row['sha256'])
        seen.add(name);total+=len(data);need(total<=MAX_BYTES,'backup_snapshot_capacity')
    need({'data/state.sqlite3','data/consumer-state.json','data/manifest.json','history/maintenance.json'}<=seen)
    actual=set()
    for folder in root.iterdir():
        if folder.name=='backup-snapshot.json':continue
        need(folder.name in('data','history'));directory(folder,0,0,0o700)
        for item in folder.iterdir():actual.add(folder.name+'/'+item.name)
    need(actual==seen,'backup_snapshot_inventory_changed');return value

def prepare(paths,journal,destination,operation_id,boundary):
    need(os.geteuid()==os.getegid()==0,'backup_snapshot_role_invalid')
    need(type(operation_id)is str and re.fullmatch('[a-f0-9]{32}',operation_id))
    operation=journal.find(operation_id)
    need(operation is not None and operation['records'][-1]['body']['phase']=='consumer_stopped','backup_snapshot_boundary_changed')
    boundary()
    root=Path(destination);directory(root.parent,0,0,0o700)
    # An incomplete capture is retained, never overwritten or silently retried.
    root.mkdir(mode=0o700);root.chmod(0o700)
    snapshot_data(paths,root/'data');(root/'history').mkdir(mode=0o700)
    for name,data in journal.history_files():
        file_limit('history/'+name);put(root/'history'/name,data)
    boundary();need(journal.find(operation_id)==operation,'backup_snapshot_boundary_changed')
    rows=[];total=0
    for folder in ('data','history'):
        for path in sorted((root/folder).iterdir()):
            name=folder+'/'+path.name;data=read(path,0,0,0o600,file_limit(name));total+=len(data)
            need(total<=MAX_BYTES and len(rows)<MAX_FILES,'backup_snapshot_capacity')
            rows.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'role':role(name)})
        syncdir(root/folder)
    value={'schema_version':1,'scope':SCOPE,'operation_id':operation_id,
      'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'consistency':'coordinated_metadata_cut','full24h_proven':False,'current_authority_included':False,'files':rows}
    put(root/'backup-snapshot.json',canonical(value));syncdir(root)
    return artifact(root,operation_id)

def stream(root,operation_id,output):
    value=artifact(root,operation_id);root=Path(root)
    def send(frame):output.write(canonical(frame)+b'\n');output.flush()
    send({'frame':'begin','schema_version':1,'scope':SCOPE,'operation_id':operation_id,
          'current_authority_included':False,'full24h_proven':False})
    for row in value['files']:
        data=read(root/row['path'],0,0,0o600,file_limit(row['path']))
        need(len(data)==row['bytes']and hashlib.sha256(data).hexdigest()==row['sha256'])
        send({'frame':'file',**row})
        for offset in range(0,len(data),CHUNK_BYTES):
            send({'frame':'chunk','offset':offset,'data':base64.b64encode(data[offset:offset+CHUNK_BYTES]).decode('ascii')})
        send({'frame':'file_end'})
    # A complete file list and successful process exit are both required.
    need(artifact(root,operation_id)==value,'backup_snapshot_inventory_changed')
    send({'frame':'complete','metadata':{k:v for k,v in value.items()if k!='files'},
          'files':len(value['files']),'bytes':sum(r['bytes']for r in value['files']),
          'manifest_sha256':hashlib.sha256(canonical(value)).hexdigest()})
