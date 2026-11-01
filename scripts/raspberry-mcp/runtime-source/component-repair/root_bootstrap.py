"""Sealed fixed Root entrypoint. Operator policy/hash are unit bindings, not RPC.
This source does not install itself or grant permission when imported.
"""
import ast,hashlib,json,os,re,socket,stat,struct,sys,time,types
from pathlib import Path
LIB=Path('/usr/local/lib/raspberry-component-repair');STATE=Path('/var/lib/raspberry-component-repair')
ORDER=('admission','workflow','worker_parent','revision_review','executor_observer','component_jobs','reciprocal_gate','readonly_parent','root_coordinator','canonical_worker','source_writer','preparation_storage','validation_profile','owner_lease','functional','preparer','publisher_parent','native_factory','initial_host_contract','task_adapter')
FILES={n+'.py'for n in ORDER}|{'root_bootstrap.py','attestation_model.cjs','revision_store.cjs','effects/nodered_job.cjs','effects/nodered_effect.cjs','effects/nodered_observe.cjs','publication_bridge.cjs'}
END=0  # Public source is disarmed; bind an approved private deadline.
NATIVE_ALLOWED={'/usr/local/lib/raspberry-task-control/task_store.py','/usr/local/lib/raspberry-task-control/task_control.py','/usr/local/lib/raspberry-mcp/codex_control.py','/usr/local/lib/raspberry-task-control/policy.json','/usr/local/lib/raspberry-mcp/codex-control-approval.json','/usr/local/lib/raspberry-repair-control/policy.json','/usr/local/lib/raspberry-admin-executor/policy.json','/usr/local/lib/raspberry-nodered-diagnostics/config.json','/usr/bin/node','/usr/bin/systemctl','/usr/bin/systemd-run','/var/lib/raspberry-component-repair/profiles/observacao_host.json','/usr/local/lib/raspberry-mcp-events/worker.py','/usr/local/lib/raspberry-nodered-binding/broker.py','/usr/local/lib/raspberry-nodered-binding/approval.json','/usr/local/lib/raspberry-component-repair/initial-host-proposal.json'}
def need(v,r):
 if not v:raise ValueError(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(path,maximum=1048576):
 for parent in (Path(path).parent,*Path(path).parent.parents):
  s=parent.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o022,'unsafe_bootstrap_parent')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_uid==0 and a.st_nlink==1 and not a.st_mode&0o022 and 0<a.st_size<=maximum,'unsafe_bootstrap_file');raw=bytearray()
  while len(raw)<=maximum:
   part=os.read(fd,min(65536,maximum+1-len(raw)))
   if not part:break
   raw.extend(part)
  z=os.fstat(fd);need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns)and len(raw)==a.st_size,'bootstrap_source_changed_during_read');return bytes(raw)
 finally:os.close(fd)
def file_hash(path):
 # Native Node may be larger than memory limits: never read the full executable.
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_uid==0 and not a.st_mode&0o022 and a.st_size<=512*1048576,'unsafe_bootstrap_binary');h=hashlib.sha256();size=0
  while True:
   b=os.read(fd,65536)
   if not b:break
   size+=len(b);need(size<=a.st_size,'bootstrap_binary_grew');h.update(b)
  z=os.fstat(fd);need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns)and size==a.st_size,'bootstrap_binary_changed');return h.hexdigest()
 finally:os.close(fd)
def load(expected):
 need(re.fullmatch('[a-f0-9]{64}',expected)is not None,'unit_policy_hash_required');raw=read(LIB/'policy.json',65536);need(sha(raw)==expected,'unit_policy_hash_changed');p=json.loads(raw)
 fields={'schema_version','host','project','enabled','issued_at','expires_at','boot_id','principal_sha256','allowed_peer_uid','activated_components','recurring_execution_enabled','source_hashes','dependencies'}
 need(type(p)is dict and set(p)==fields and p['schema_version']==1 and p['host']=='raspberry'and p['project']=='/mnt/data/docker'and p['enabled']is True and p['expires_at']==END and p['recurring_execution_enabled']is False and p['allowed_peer_uid']==1001 and p['activated_components']==['observacao_host'],'closed_root_bootstrap_policy_changed')
 need(re.fullmatch('[a-f0-9]{64}',p['principal_sha256'])is not None and 0<END-p['issued_at']<=604800,'operator_root_lease_changed')
 need(Path('/proc/sys/kernel/random/boot_id').read_text().strip()==p['boot_id'],'root_bootstrap_boot_changed')
 need(not os.path.lexists(STATE/'revoked'),'component_operator_access_revoked')
 need(set(p['source_hashes'])==FILES and set(p['dependencies'])==NATIVE_ALLOWED,'root_bootstrap_source_scope_changed')
 verified={}
 for name,h in p['source_hashes'].items():
  need(re.fullmatch('[a-f0-9]{64}',h)is not None,'invalid_root_source_hash');b=read(LIB/name);need(sha(b)==h,'root_component_source_changed');verified[name]=b
 for name,h in p['dependencies'].items():
  need(re.fullmatch('[a-f0-9]{64}',h)is not None,'invalid_root_dependency_hash')
  if name.startswith('/usr/bin/'):
   need(file_hash(name)==h,'root_binary_changed')
  else:
   b=read(name);need(sha(b)==h,'root_dependency_changed');verified[name]=b
 principal_tree=ast.parse(verified['/usr/local/lib/raspberry-mcp-events/worker.py'])
 principal_values=[x.value.value for x in principal_tree.body if isinstance(x,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='PRINCIPAL'for t in x.targets)and isinstance(x.value,ast.Constant)and type(x.value.value)is str]
 need(len(principal_values)==1 and sha(principal_values[0].encode())==p['principal_sha256'],'authenticated_native_owner_principal_changed')
 for name in ORDER:
  mod=types.ModuleType(name);mod.__file__=str(LIB/(name+'.py'));mod.__package__='';mod.__cached__=None;sys.modules[name]=mod;exec(compile(verified[name+'.py'],mod.__file__,'exec'),mod.__dict__)
 return p,sys.modules['native_factory'].Factory(p,verified)
def serve(policy,factory):
 stream=socket.fromfd(0,socket.AF_UNIX,socket.SOCK_STREAM);_,uid,_=struct.unpack('3i',stream.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==policy['allowed_peer_uid'],'component_broker_peer_refused');stream.settimeout(5);raw=bytearray()
 while b'\n'not in raw:
  b=stream.recv(4096);need(b and len(raw)+len(b)<=16384,'component_request_limit');raw.extend(b)
 need(raw.count(b'\n')==1 and raw.endswith(b'\n'),'one_component_request_only');q=json.loads(raw);need(type(q)is dict and set(q)=={'name','arguments'},'component_request_shape')
 if q['name']=='_registered_mutation_guard':
  need(type(q['arguments'])is dict and set(q['arguments'])=={'host','kind'}and q['arguments']['host']=='raspberry','closed_native_mutation_guard_request')
  from reciprocal_gate import ReciprocalGuard,ForeignHeldOperations
  result=ReciprocalGuard(STATE/'workflow.sqlite3',ForeignHeldOperations(struct.unpack('3i',stream.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0])).check(q['arguments']['kind'])
  body=(json.dumps({'ok':True,'result':result},separators=(',',':'))+'\n').encode();need(len(body)<=16384,'component_reply_limit');stream.sendall(body);return
 from reciprocal_gate import ForeignHeldOperations
 peer_pid=struct.unpack('3i',stream.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]
 factory.caller_operations=ForeignHeldOperations(peer_pid)
 if q['name']in ('_prepare_registered_component','_seal_registered_component'):
  args=q['arguments'];need(type(args)is dict and args.get('host')=='raspberry','internal_component_request_invalid')
  if q['name']=='_prepare_registered_component':
   need(set(args)=={'host','operation_id','task_id','send_id','expires_at','expected_loaded_sha256','proposal_id'},'internal_preparation_fields')
   binding={'operation_id':args['operation_id'],'task_id':args['task_id'],'principal_sha256':policy['principal_sha256'],'component_id':'observacao_host','action':'observe'}
   result=factory.prepare_operation(binding,args['send_id'],args['expires_at'],args['expected_loaded_sha256'],args['proposal_id'])
  else:
   need(set(args)=={'host','operation_id','root_decision_id'},'internal_seal_fields');result=factory.seal_and_publish(args['operation_id'],args['root_decision_id'])
  body=(json.dumps({'ok':True,'result':result},separators=(',',':'))+'\n').encode();need(len(body)<=16384,'component_reply_limit');stream.sendall(body);return
 read_only=q['name']=='component_repair_status'
 coord,flow,jobs,_,_=factory.make(read_only,caller_operations=factory.caller_operations)
 try:
  # Historical status is available after expiry. No new effect bypasses expiry.
  if not read_only:need(time.time()+90<policy['expires_at'],'operator_root_lease_expired')
  result=coord.dispatch(q['name'],q['arguments']);reply={'ok':True,'result':result}
 except Exception as e:
  reason=str(e)if type(e)is ValueError and re.fullmatch('[a-zA-Z_]{1,80}',str(e))else'component_operation_unconfirmed';reply={'ok':False,'error':reason,'automatic_retry':False}
 finally:flow.close();jobs.close()
 body=(json.dumps(reply,separators=(',',':'))+'\n').encode();need(len(body)<=16384,'component_reply_limit');stream.sendall(body)
def contract_wire_summary(full):
 # The same pinned helper provides full details through its closed read-only
 # describe route. Keep the existing MCP frame limit and all nine source hashes.
 return {'schema_version':1,'projection':'summary_read_full_before_any_effect',
  'source':full['source'],'state':full['state'],'observed_at':full['observed_at'],
  'age_seconds':0,'collection_error':full['collection_error'],
  'coverage':['source_hashes_and_typed_read_route_only;full_contract_required'],
  'component_id':full['component_id'],'policy_sha256':full['policy_sha256'],
  'profile_sha256':full['profile_sha256'],'prepare_invocable':full['prepare_invocable'],
  'source_sha256_by_id':{r['source_id']:r['before_sha256']for r in full['sources']},
  'initial_proposal_id':full['initial_template']['proposal_id'],
  'typed_cli':{k:full['typed_cli'][k]for k in('entrypoint','entrypoint_sha256','describe_argv')},
  'registry':{k:full['registry'][k]for k in('collection_error','records','requests')},
  'read_full_contract_before_any_effect':True,'recurring_execution_enabled':False,
  'native_full_flow_replay':False}
def guard_only(policy):
 # This endpoint has no credential, task, execution or mutation dispatch route.
 peer=socket.socket(fileno=os.dup(0));peer.settimeout(4)
 try:
  pid,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==policy['allowed_peer_uid'],'component_guard_peer_refused')
  data=bytearray()
  while b'\n'not in data:
   part=peer.recv(2048);need(part and len(data)+len(part)<=4096,'component_guard_frame_limit');data.extend(part)
  need(data.count(b'\n')==1 and data.endswith(b'\n'),'one_component_guard_frame_only');query=json.loads(data)
  need(type(query)is dict and set(query)=={'name','arguments'}and query['name']in('_registered_mutation_guard','_component_catalogue_status'),'guard_only_request_required')
  from reciprocal_gate import ReciprocalGuard,ForeignHeldOperations
  lock=ForeignHeldOperations(pid);lock.check();args=query['arguments']
  if query['name']=='_registered_mutation_guard':
   need(type(args)is dict and set(args)=={'host','kind'}and args['host']=='raspberry','guard_only_arguments_required')
   proof=ReciprocalGuard(STATE/'workflow.sqlite3',lock).check(args['kind'])
  else:
   need(args=={'host':'raspberry'},'closed_component_metadata_request')
   from component_jobs import JobLedger
   from source_writer import SourceWriter
   profile=json.loads(read(STATE/'profiles/observacao_host.json'));writer=SourceWriter(profile)
   current=writer.current();matches=all(sha(v)==profile['snapshot_hashes'][name]for name,v in current.items())
   ledger=JobLedger(STATE/'jobs.sqlite3',read_only=True)
   try:pending=len(ledger.pending_jobs())
   finally:ledger.close()
   import sqlite3
   from component_jobs import protected
   protected(STATE/'workflow.sqlite3',0,0o600)
   db=sqlite3.connect((STATE/'workflow.sqlite3').as_uri()+'?mode=ro',uri=True)
   try:
    db.execute('PRAGMA query_only=ON');reservations=db.execute("SELECT count(*)FROM operations WHERE state!='released'").fetchone()[0]
   finally:db.close()
   proof={'source':'protected_registered_component_catalogue','state':'observed','observed_at':time.time(),'age_seconds':0,'collection_error':None,'execution_active':sys.modules['owner_lease'].observed_active(profile['owner_lease'])and time.time()+190<policy['expires_at']and matches and pending==0 and reservations==0 and not(STATE/'revoked').exists(),'expires_at':policy['expires_at'],'recurring_execution_enabled':False,'model_provider_dependency':None,'new_MCP_tools':0,'new_accounts':0,'component_id':'observacao_host','other_component_profiles_enabled':False,'canonical_before_matches_profile':matches,'profile_refresh_required':not matches,'pending_jobs':pending,'active_reservations':reservations,'admission_semantics':'new preparation only; own operation phases retain independent gates','route':{'create':'codex_task_create','send':'codex_task_send','status':'codex_task_status','ack':'codex_task_reconcile'},'closed_cli':'/usr/local/lib/raspberry-component-repair/root_bootstrap.py','policy_sha256':sha(read(LIB/'policy.json')),'purposes':['prepare','validate','seal','apply','rollback','status','reconcile','verify','cancel','release'],'functional_proof_coverage':['host_observer_test_reset_status_isolation'],'coverage':['protected_profile_and_job_metadata_only','not_task_execution_receipt_or_whole_host_health']}
   from initial_host_contract import describe
   try:proof['execution_contract']=contract_wire_summary(describe(sys.modules['native_factory'].Factory(policy,{str(STATE/'profiles/observacao_host.json'):read(STATE/'profiles/observacao_host.json')})))
   except Exception:proof['execution_contract']={'schema_version':1,'state':'unknown','source':'protected_initial_host_execution_contract','observed_at':time.time(),'age_seconds':0,'collection_error':'execution_contract_collection_failed','prepare_invocable':False,'coverage':['no_effect_or_replay_from_collection_failure']}
   lock.check()
  peer.sendall((json.dumps({'ok':True,'result':proof},separators=(',',':'))+'\n').encode())
 finally:peer.close()
def worker(policy,factory,instance):
 need(time.time()+90<policy['expires_at'],'operator_root_lease_expired');match=re.fullmatch('([a-f0-9]{32})-(prepare|seal|verify|apply|rollback)',instance);need(match is not None,'fixed_component_job_instance_required');coord,flow,jobs,_,_=factory.make()
 try:
  if match.group(2)in ('prepare','seal','verify'):
   from task_adapter import TaskAdapter
   TaskAdapter(factory).run_phase(*match.groups())
  else:coord.run_once(*match.groups())
 finally:flow.close();jobs.close()
def validation_worker(policy,factory,instance):
 need(time.time()+190<policy['expires_at']and re.fullmatch('[a-f0-9]{32}',instance)is not None,'fixed_validation_instance_required')
 coord,flow,jobs,_,_=factory.make()
 try:coord.run_validation(instance)
 finally:flow.close();jobs.close()
def initialize(policy,factory):
 # Administrative activation only, never an MCP action. Refuse existing state.
 need(time.time()+90<policy['expires_at'],'component_state_initialization_expired')
 # The activation package prestages only its pinned immutable profile so load()
 # can verify it. Any ledger, intent, journal or unknown entry refuses init.
 need(STATE.is_dir()and set(os.listdir(STATE))=={'profiles'},'component_state_exists_or_unconfirmed')
 state_info=STATE.lstat();need(state_info.st_uid==state_info.st_gid==0 and stat.S_IMODE(state_info.st_mode)==0o700,'unsafe_initial_component_state')
 profile_info=(STATE/'profiles').lstat();need(stat.S_ISDIR(profile_info.st_mode)and profile_info.st_uid==profile_info.st_gid==0 and stat.S_IMODE(profile_info.st_mode)==0o700 and set(os.listdir(STATE/'profiles'))=={'observacao_host.json'},'initial_component_profile_scope')
 for name in ('sealed','prepared','reviews','publication-journal','workers','functional','proposals','operator-decisions','requests','registrations'):(STATE/name).mkdir(mode=0o700)
 for name in ('apply','rollback'):(STATE/'workers'/name).mkdir(mode=0o700)
 from component_jobs import JobLedger
 from workflow import Workflow
 ledger=JobLedger(STATE/'jobs.sqlite3',initialize=True);ledger.close();flow=Workflow(STATE/'workflow.sqlite3',time.time,policy['expires_at']);flow.close()
 directory=os.open(STATE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(directory)
 finally:os.close(directory)
def main():
 need(os.geteuid()==os.getegid()==0,'root_component_bootstrap_required');need(len(sys.argv)in (3,4,5,7),'fixed_bootstrap_arguments');expected,action=sys.argv[1:3];p,f=load(expected)
 if action=='guard'and len(sys.argv)==3:guard_only(p)
 elif action=='serve'and len(sys.argv)==3:serve(p,f)
 elif action=='describe'and len(sys.argv)==3:
  from initial_host_contract import describe
  print(json.dumps(describe(f),separators=(',',':')))
 elif action=='register-initial-host-proposal'and len(sys.argv)==7:
  from initial_host_contract import InitialHostRegistration
  try:result=InitialHostRegistration(f).register(*sys.argv[3:])
  except Exception as error:
   reason=str(error)if type(error)is ValueError and re.fullmatch('[a-zA-Z_]{1,100}',str(error))else'initial_registration_unconfirmed_inspect_existing_no_retry'
   print(json.dumps({'state':'not_accepted_or_unconfirmed','reason':reason,'automatic_retry':False,'native_effects':0},separators=(',',':')));raise SystemExit(1)
  print(json.dumps(result,separators=(',',':')))
 elif action=='worker'and len(sys.argv)==4:worker(p,f,sys.argv[3])
 elif action=='validate'and len(sys.argv)==4:validation_worker(p,f,sys.argv[3])
 elif action=='task'and len(sys.argv)==5:
  from task_adapter import TaskAdapter
  print(json.dumps(TaskAdapter(f).command(sys.argv[3],sys.argv[4]),separators=(',',':')))
 elif action=='initialize'and len(sys.argv)==3:initialize(p,f)
 else:raise ValueError('fixed_bootstrap_action_required')
if __name__=='__main__':
 try:os.umask(0o077);main()
 except Exception:
  # Never print raw exceptions, config, RPC requests, credentials or child stderr.
  print('{"ok":false,"error":"component_bootstrap_unconfirmed","automatic_retry":false}');raise SystemExit(1)
