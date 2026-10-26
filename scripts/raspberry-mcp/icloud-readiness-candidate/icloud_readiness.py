"""Candidate bounded native iCloud observation. No CLI, caller paths or effects.
Root socket dispatch must first validate sealed code, peer, scope and expiry.
"""
import datetime,hashlib,http.client,json,math,os,pwd,re,socket,stat,time
from pathlib import Path
PROOF=Path('/run/raspberry-icloud-read/proof.json')
ACTIVATION=Path('/run/raspberry-icloud-read/activation.json')
SERVICE=Path('/var/lib/raspberry-ha-notices/public/icloud-service.json')
DOCKER='/run/raspberry-icloud-read/docker.sock'
PHASES=frozenset(('entry_ready','entry_waiting_user','entry_contained','domain_loaded'))
ERRORS=frozenset(('starting','transport_unconfirmed','response_refused','invalid_response','scope_expired','scope_revoked','connection_unverified'))
def need(v):
 if not v:raise ValueError('fixed_readiness_observation_refused')
def sha(v):return isinstance(v,str)and re.fullmatch('[a-f0-9]{64}',v)is not None
def stamp(value):
 try:
  if not isinstance(value,str)or len(value)>40:return None
  date=datetime.datetime.fromisoformat(value.replace('Z','+00:00'));return date.timestamp()if date.tzinfo else None
 except ValueError:return None
def age(value,now):
 at=stamp(value);return now-at if at is not None and math.isfinite(now-at)and now-at>=0 else None
def iso(now):return datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat()
def project(proof,activation,process_verified,service,now,expected_release):
 out={'source':'fixed_icloud_loaded_and_service_observation','component_id':'icloud_adapter','observed_at':iso(now),'state':'unknown','collection_error':'partial_collection_failure','loaded':{'state':'unknown','collection_error':'process_or_proof_unconfirmed','observed_at':None,'age_seconds':None,'code_sha256':None,'release_revision':None,'entry_phase':'unknown'},'expected_node_contract':{'source':'reviewed_NodeRED_contract_not_live_configuration','service':'public_bindings.call','action':'refresh_location','current_NodeRED_configuration_observed':False},'service_registration':{'state':'unknown','collection_error':'source_invalid_or_unavailable','observed_at':None,'age_seconds':None,'service':'public_bindings.call','registered':None,'last_success':None},'functional_health':'unknown','functional_recovery_proven':False,'service_call_executed':False,'authentication_or_location_refresh_called':False,'coverage':['fixed_native_process_proof_and_nonce_binding','fixed_readonly_HA_service_registry','entry_ready_and_registration_are_not_handler_or_Apple_health','no_credentials_location_raw_logs_or_prompts','not_Eva_execution_or_full_goal_acceptance']}
 if isinstance(proof,dict)and isinstance(activation,dict):
  seconds=age(proof.get('observed_at'),now);nonce=activation.get('operation_id')
  if (sha(expected_release)and process_verified is True and type(proof.get('schema_version'))is int and proof['schema_version']==1 and type(activation.get('schema_version'))is int and activation['schema_version']==1 and proof.get('source')=='homeassistant.main_process.icloud'and isinstance(nonce,str)and re.fullmatch('[a-f0-9]{32}',nonce)and proof.get('operation_id')==nonce and proof.get('release_revision')==activation.get('release_revision')==expected_release and seconds is not None and seconds<=60 and proof.get('ha_running')is True and proof.get('manual_auth_guard_loaded')is True and sha(proof.get('loaded_code_sha256'))and proof.get('phase')in PHASES):
   out['loaded']={'state':'observed','collection_error':None,'observed_at':proof['observed_at'],'age_seconds':round(seconds,3),'code_sha256':proof['loaded_code_sha256'],'identity_kind':'python_code_objects_v1','release_revision':expected_release,'entry_phase':proof['phase'],'native_process_identity_verified':True}
 if isinstance(service,dict)and set(service)=={'schema_version','source','observed_at','state','collection_error','service','registered','last_success','lookup','not_service_execution','not_handler_or_provider_health'}and type(service.get('schema_version'))is int and service['schema_version']==1 and service.get('source')=='HA_fixed_readonly_service_registry'and service.get('service')=='public_bindings.call'and service.get('lookup')=='fixed_service_registry_membership'and service.get('not_service_execution')is True and service.get('not_handler_or_provider_health')is True:
  row=out['service_registration'];seconds=age(service.get('observed_at'),now);last=service.get('last_success')
  if isinstance(last,dict)and set(last)=={'observed_at','registered'}and type(last.get('registered'))is bool and age(last.get('observed_at'),now)is not None:row['last_success']={'observed_at':last['observed_at'],'registered':last['registered'],'historical_not_current':True}
  row.update(observed_at=service.get('observed_at')if seconds is not None else None,age_seconds=round(seconds,3)if seconds is not None else None)
  if seconds is not None and seconds<=90 and service.get('state')=='observed'and service.get('collection_error')is None and type(service.get('registered'))is bool:
   row.update(state='observed',collection_error=None,registered=service['registered'])
  else:row['collection_error']=service.get('collection_error')if service.get('collection_error')in ERRORS else'service_observation_stale_or_invalid'
 if out['loaded']['state']=='observed'and out['service_registration']['state']=='observed':out.update(state='observed',collection_error=None)
 return out

def read(path,owner,mode,limit):
 directory=os.open('/',os.O_PATH|os.O_DIRECTORY)
 try:
  for part in path.parts[1:-1]:
   nxt=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=nxt
  fd=os.open(path.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)
  try:
   a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_uid==owner and stat.S_IMODE(a.st_mode)==mode and a.st_nlink==1 and a.st_size<=limit);raw=os.read(fd,limit+1);b=os.fstat(fd);need(len(raw)<=limit and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns));return raw
  finally:os.close(fd)
 finally:os.close(directory)
class FixedDockerMetadata(http.client.HTTPConnection):
 def __init__(self):super().__init__('localhost',timeout=2)
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(2);self.sock.connect(DOCKER)
def process_ids(connection_factory=FixedDockerMetadata):
 connection=connection_factory()
 try:
  connection.request('GET','/containers/homeassistant/top?ps_args=-eo%20pid');response=connection.getresponse();need(response.status==200);raw=response.read(8193);need(len(raw)<=8192);data=json.loads(raw)
  need(isinstance(data,dict)and set(data)=={'Titles','Processes'}and data['Titles']==['PID']and isinstance(data['Processes'],list)and 1<=len(data['Processes'])<=128);pids=[]
  for row in data['Processes']:
   need(isinstance(row,list)and len(row)==1 and isinstance(row[0],str)and re.fullmatch('[0-9]{1,7}',row[0].strip())is not None);pid=int(row[0]);need(0<pid<2**22 and pid not in pids);pids.append(pid)
  return pids
 finally:connection.close()
def kernel_identity(pid):
 need(type(pid)is int and 0<pid<2**22)
 def kernel(name,limit):
  fd=os.open('/proc/'+str(pid)+'/'+name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:raw=os.read(fd,limit+1);need(len(raw)<=limit);return raw.decode('ascii')
  finally:os.close(fd)
 status=kernel('status',8192);rows=[line.split()[1:]for line in status.splitlines()if line.startswith('NSpid:')];need(len(rows)==1 and 1<=len(rows[0])<=8 and all(re.fullmatch('[0-9]{1,7}',v)is not None and 0<int(v)<2**22 for v in rows[0]));inside=int(rows[0][-1]);ticks=kernel('stat',4096).rsplit(')',1)[1].split()[19];need(re.fullmatch('[0-9]{1,20}',ticks)is not None);return inside,ticks

def process_identity(proof,pids=process_ids,kernel=kernel_identity):
 try:
  inside=proof.get('pid');ticks=proof.get('process_start_ticks');need(type(inside)is int and 0<inside<2**22 and isinstance(ticks,str)and re.fullmatch('[0-9]{1,20}',ticks)is not None);matching=[]
  for host in pids():
   try:
    if kernel(host)==(inside,ticks):matching.append(host)
   except (OSError,ValueError,IndexError,UnicodeError):continue
  return len(matching)==1 and matching[0]in pids()and kernel(matching[0])==(inside,ticks)
 except Exception:return False

def collect(expected_release,clock=time.time):
 need(os.geteuid()==0 and sha(expected_release));proof=activation=service=None;process=False
 try:
  proof=json.loads(read(PROOF,0,0o600,4096));activation=json.loads(read(ACTIVATION,0,0o644,1024));process=process_identity(proof)
 except Exception:pass
 try:service=json.loads(read(SERVICE,pwd.getpwnam('raspberry-ha-notices').pw_uid,0o640,4096))
 except Exception:pass
 return project(proof,activation,process,service,clock(),expected_release)
