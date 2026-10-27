"""Fixed readonly source projection. No user arguments, shell or service control."""
import datetime,http.client,json,math,os,re,socket,stat,sys
from pathlib import Path
INPUT=Path('/run/raspberry-nodered-diagnostics-inputs')
OUTPUT=Path('/var/lib/raspberry-nodered-diagnostics/root-snapshot.json')
PUBLIC_EXPORT_UNARMED=True
SOURCES={'safe_update':'safe-update'}
VERS=re.compile(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]{1,60})?\Z')
DATE_KEYS={'checked_at','applied_at','rollback_at','started_at','finished_at','updated_at'}
STATE_KEYS={'state','status','mode','patch_state','reason_code'}
STATES={'unknown','unavailable','compatible','conflict','checking','applying','applied','rollback','failed','running','deferred','pending','idle','requested','processing','success','completed','applied_pending_git','audit','install','clean','patched','skipped','blocked'}
REASONS={'no_update_needed','audit_only','conflict','busy','maintenance_lock_busy','processing','candidate_pending','promotion_failed','runtime_validation_failed','publication_pending','applied_pending_git','invalid_request','target_invalid','unknown'}
PATCH_FILES=frozenset(('coordinator.py','sensor.py','__init__.py','manifest.json','config_flow.py','device_tracker.py','const.py','button.py','lock.py','climate.py','switch.py','binary_sensor.py','number.py','select.py'))
def patch_conflict(data):
 out={'state':'unknown','collection_error':'invalid_conflict_details','reported_details':None,'classified_details':0,'files':[],'categories':[]}
 values=data.get('conflicts')
 if type(values)is not list or len(values)>20 or any(type(x)is not str or len(x)>8192 for x in values):return out
 files=set();categories=set();classified=0
 for text in values:
  match=re.fullmatch(r'error: patch failed: ([a-z_]+\.py|manifest\.json):[1-9][0-9]{0,6}',text);category='patch_hunk_failed'
  if not match:match=re.fullmatch(r'error: ([a-z_]+\.py|manifest\.json): patch does not apply',text);category='patch_does_not_apply'
  if match and match[1]in PATCH_FILES:files.add(match[1]);categories.add(category);classified+=1
 return dict(out,state='observed',collection_error=None,reported_details=len(values),classified_details=classified,files=sorted(files),categories=sorted(categories))
def stamp(v):
 try:
  if not isinstance(v,str)or len(v)>40:return None
  d=datetime.datetime.fromisoformat(v.replace('Z','+00:00'));return d.astimezone(datetime.timezone.utc).isoformat()if d.tzinfo is not None and math.isfinite(d.timestamp())else None
 except(ValueError,OverflowError):return None
def read(path,limit=262144):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd)
  if not stat.S_ISREG(a.st_mode)or a.st_nlink!=1 or a.st_size>limit:raise ValueError('fixed_source_invalid')
  raw=os.read(fd,limit+1);z=os.fstat(fd)
  if len(raw)>limit or(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)!=(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns):raise ValueError('fixed_source_changed')
  return raw
 finally:os.close(fd)
def project(name,v):
 if not isinstance(v,dict):raise ValueError('fixed_schema_invalid')
 out={}
 for k in DATE_KEYS:
  if k in v:
   out[k]=stamp(v[k])
   if v[k] is not None and out[k]is None:raise ValueError('fixed_source_time_invalid')
 for k in STATE_KEYS:
  if k in v:out[k]=v[k]if v[k]in(REASONS if k=='reason_code'else STATES)else None
 for k in ('installed_version','latest_version','target'):
  if k in v:out[k]=v[k]if isinstance(v[k],str)and VERS.fullmatch(v[k])else None
 if 'request_id'in v:out['request_id']=v['request_id']if isinstance(v['request_id'],str)and re.fullmatch(r'\d{8}T\d{6}Z-\d{1,12}',v['request_id'])else None
 for k in ('commit','source_commit','upstream_commit'):
  if k in v:out[k]=v[k]if isinstance(v[k],str)and re.fullmatch('[a-f0-9]{40}',v[k])else None
 if isinstance(v.get('conflicts'),list):out['conflicts_count']=len(v['conflicts'])
 if name=='safe_update'and v.get('state')=='conflict'and v.get('patch_state')=='conflict':out['patch_conflict']=patch_conflict(v)
 return out
class Docker(http.client.HTTPConnection):
 def __init__(self):super().__init__('localhost',timeout=2)
 def connect(self):self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(2);self.sock.connect(str(INPUT/'docker.sock'))
def timezone():
 c=Docker()
 try:
  c.request('GET','/containers/nodered/json');r=c.getresponse();raw=r.read(262145)
  if r.status!=200 or len(raw)>262144:raise ValueError('fixed_timezone_unavailable')
  v=json.loads(raw);env=v.get('Config',{}).get('Env');tz=[x[3:]for x in env if isinstance(x,str)and x.startswith('TZ=')]if isinstance(env,list)else[]
  if len(tz)!=1 or tz[0]not in('America/Sao_Paulo','Etc/UTC','UTC'):raise ValueError('fixed_timezone_unknown')
  return {'timezone':tz[0],'source':'current_nodered_container_configuration_TZ','collection_error':None,'coverage':['configured_TZ_not_direct_JS_Intl_attestation']}
 finally:c.close()
def snapshot(now):
 result={'source':'fixed_root_readonly_Kia_update_receipts','observed_at':now,'collection_error':None,'sources':{},'pending':{},'timezone':None,'coverage':['latest_fixed_receipts_only','no_raw_error_reason_message_paths_secrets_or_vehicle_values','no_update_check_install_refresh_or_service_control']}
 for name,alias in SOURCES.items():
  row={'observed_at':now,'collection_error':None,'data':None}
  try:
   raw=read(INPUT/alias)
   if name=='worker_result':
    line=raw.decode().strip()
    if len(line)>2048 or '\n'in line:raise ValueError('fixed_worker_schema_invalid')
    parts=line.split();v={}
    if not parts or parts[0]!='kia-uvo-update':raise ValueError('fixed_worker_schema_invalid')
    for token in parts[1:]:
     k,sep,val=token.partition('=')
     if not sep or k in v:raise ValueError('fixed_worker_schema_invalid')
     v[k]=val
    clean=project(name,v);row['data']='kia-uvo-update '+' '.join(k+'='+str(val)for k,val in clean.items()if val is not None)
   else:row['data']=project(name,json.loads(raw))
  except FileNotFoundError:pass
  except Exception:row['collection_error']='fixed_source_collection_failed'
  result['sources'][name]=row
 for name in ('audit-requested','audit-processing','audit-followup','merge-requested','merge-processing'):
  try:
   # Only existence of the fixed intent; contents are never read.
   s=(INPUT/name).stat();result['pending'][name.replace('-','_')]=stat.S_ISREG(s.st_mode)
  except FileNotFoundError:result['pending'][name.replace('-','_')]=False
  except OSError:result['pending'][name.replace('-','_')]=None
 try:result['timezone']=timezone()
 except Exception:result['timezone']={'timezone':None,'collection_error':'fixed_timezone_unavailable'}
 return result
def main():
 if os.geteuid()!=0 or len(sys.argv)!=1:raise ValueError('fixed_root_entrypoint_required')
 if os.path.lexists(OUTPUT.parent/'revoked'):raise ValueError('readonly_scope_revoked')
 if PUBLIC_EXPORT_UNARMED:raise ValueError('public_export_unarmed')
 out=snapshot(datetime.datetime.now(datetime.timezone.utc).isoformat());parent=OUTPUT.parent.lstat()
 if not stat.S_ISDIR(parent.st_mode)or parent.st_uid!=0 or stat.S_IMODE(parent.st_mode)!=0o755:raise ValueError('unsafe_fixed_state_parent')
 raw=(json.dumps(out,sort_keys=True)+'\n').encode()
 if len(raw)>16384:raise ValueError('fixed_snapshot_limit')
 tmp=OUTPUT.with_name('.root-snapshot-new');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
 with os.fdopen(fd,'wb')as f:os.fchmod(f.fileno(),0o644);f.write(raw);f.flush();os.fsync(f.fileno())
 os.replace(tmp,OUTPUT)
if __name__=='__main__':
 try:main()
 except Exception:print('{"collection_error":"fixed_root_snapshot_unconfirmed","raw_error_withheld":true}');raise SystemExit(1)
