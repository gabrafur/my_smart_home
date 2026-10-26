"""Candidate heartbeat effect engine. No installed CLI or MCP registration.
Root bootstrap supplies protected source/store/admission/native-observer ports.
No callback, path, command, privilege or observed-proof boolean is an MCP input.
The engine never invokes the sender, restarts a service or deletes history.
"""
import ast,hashlib,json,math,re,time
EDITABLE=frozenset(('heartbeat.py','history.py','webhook.py'))
SOURCE_FILES=frozenset((*EDITABLE,'loaded_identity.py','heartbeat-entrypoint.py'))
SAFE_FAILURES=frozenset(('heartbeat_artifact_read_only_or_unknown','heartbeat_source_version_conflict','compiled_identity_binding_changed','before_native_version_unconfirmed','edit_outside_function_body_scope','heartbeat_admission_identity_unconfirmed','heartbeat_admission_scope_unconfirmed','heartbeat_admission_time_unconfirmed','source_compare_replace_conflict','after_source_set_unconfirmed','source_write_receipt_unconfirmed'))
BINDING=frozenset(('operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256','action'))
class BeforeReplaceRefused(ValueError):pass

def need(v,r):
 if not v:raise ValueError(r)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def hexdigest(value,n=64):return isinstance(value,str)and re.fullmatch('[a-f0-9]{'+str(n)+'}',value)is not None
def finite(value):return type(value)in(int,float)and math.isfinite(value)
def source_set(sources):return sha(json.dumps(sorted((k,sha(v))for k,v in sources.items()),separators=(',',':')).encode())
class FunctionBodies(ast.NodeTransformer):
 def visit_FunctionDef(self,node):node.body=[ast.Pass()];return node
 def visit_AsyncFunctionDef(self,node):node.body=[ast.Pass()];return node
def function_body_delta(before,after):
 # Module imports/data, class bases/decorators, signatures/defaults and identity
 # instrumentation remain outside this edit scope. This is NOT security review.
 a=FunctionBodies().visit(ast.parse(before.decode('utf8')));b=FunctionBodies().visit(ast.parse(after.decode('utf8')))
 need(ast.dump(a,include_attributes=False)==ast.dump(b,include_attributes=False),'edit_outside_function_body_scope')
def binding_from(prepared):
 need(isinstance(prepared,dict)and set(prepared)==BINDING|{'artifact_id','before_source_set_sha256','before_source_sha256','after_source_sha256','candidate_source'},'prepared_heartbeat_record_shape')
 b={k:prepared[k]for k in BINDING}
 need(all(hexdigest(b[k],32)for k in ('operation_id','task_id'))and hexdigest(b['principal_sha256'])and b['component_id']=='external_heartbeat'and b['action']in ('apply','rollback')and hexdigest(b['before_sha256'])and hexdigest(b['after_sha256'])and b['before_sha256']!=b['after_sha256'],'heartbeat_binding_refused')
 need(hexdigest(prepared['artifact_id'],32)and all(hexdigest(prepared[k])for k in ('before_source_set_sha256','before_source_sha256','after_source_sha256')),'heartbeat_source_binding_refused')
 return b
class HeartbeatWorker:
 def __init__(self,sources,store,compiler,artifact_names,admission,native_observer,clock=time.time,monotonic=time.monotonic,pause=time.sleep,timeout=75):
  need(finite(timeout)and 0<timeout<=75,'heartbeat_observation_budget_refused')
  self.sources,self.store,self.compiler,self.names=sources,store,compiler,artifact_names;self.admit,self.observe=admission,native_observer;self.clock,self.mono,self.pause,self.timeout=clock,monotonic,pause,timeout
 def check(self,binding):
  grant=self.admit(binding);need(isinstance(grant,dict)and all(grant.get(k)==v for k,v in binding.items())and grant.get('identity_kind')=='python_code_objects_v1','heartbeat_admission_identity_unconfirmed')
  need(all(grant.get(k)is True for k in ('registered_task','reviewed_candidate','principal_matches','shared_budget_reserved','global_admin_idle','resources_available','maintenance_lock_held')),'heartbeat_admission_scope_unconfirmed')
  need(finite(grant.get('observed_at'))and 0<=self.clock()-grant['observed_at']<=5 and finite(grant.get('expires_at'))and self.clock()+90<grant['expires_at'],'heartbeat_admission_time_unconfirmed')
 def identity(self,source):return self.compiler.compile({n.removesuffix('.py'):source[n]for n in SOURCE_FILES if n!='heartbeat-entrypoint.py'})['expected_code_sha256']
 def trusted_native(self,proof,expected,write=None):
  if not isinstance(proof,dict)or proof.get('component_id')!='external_heartbeat'or proof.get('root_verified')is not True or proof.get('collection_error')is not None or proof.get('native_invocation_verified')is not True or proof.get('critical_bindings_valid')is not True or proof.get('loaded_sha256')!=expected:return False
  now=self.mono();at=proof.get('observed_monotonic');started=proof.get('invocation_started_monotonic');boot=proof.get('boot_id_sha256')
  if not finite(at)or not finite(started)or not 0<=now-at<=120 or not 0<=started<=at or not hexdigest(boot):return False
  return write is None or boot==write['boot_id_sha256']and started>=write['effect_monotonic']
 def outcome(self,binding,state,reason=None,write=None,native=None):
  try:cleanup=self.sources.cleanup_confirmed(binding['operation_id'],binding['action'])is True
  except Exception:cleanup=False
  result={**binding,'state':state,'collection_error':reason,'worker_finished_at':self.clock(),'executor_terminal':state in ('applied','rejected_without_effect'),'receipt_verified':True,'security_cleanup_confirmed':cleanup,'automatic_retry':False,'functional_recovery_proven':False}
  if state=='rejected_without_effect':result['definitive_no_effect']=True
  if write is not None:result.update(source_write_confirmed=True,effect_applied_at=write['effect_applied_at'],effect_monotonic=write['effect_monotonic'],boot_id_sha256=write['boot_id_sha256'])
  if state=='applied':result.update(loaded_sha256=binding['after_sha256'],natural_native_load_verified=True,native_receipt_digest=sha(json.dumps(native,sort_keys=True,separators=(',',':')).encode()))
  return result
 def wait_native(self,binding,write,deadline):
  while True:
   proof=self.observe()
   if self.trusted_native(proof,binding['after_sha256'],write):return self.outcome(binding,'applied',write=write,native=proof)
   if self.mono()>=deadline:return self.outcome(binding,'source_written_runtime_unconfirmed','native_load_not_yet_proven',write)
   self.pause(min(2,max(0,deadline-self.mono())))
 def run(self,prepared):
  b=binding_from(prepared);old=self.store.existing(b)
  if old is not None:return {**old,'duplicate':True,'effect_repeated':False}
  registered=False;attempted=False;write=None
  try:
   self.check(b);name=self.names.get(prepared['artifact_id']);need(name in EDITABLE,'heartbeat_artifact_read_only_or_unknown')
   source=self.sources.snapshot();need(set(source)==SOURCE_FILES and all(isinstance(v,bytes)and 0<len(v)<=65536 for v in source.values()),'heartbeat_source_set_unconfirmed')
   candidate=prepared['candidate_source'];need(isinstance(candidate,str)and 0<len(candidate.encode())<=65536,'candidate_source_limit');candidate=candidate.encode()
   need(source_set(source)==prepared['before_source_set_sha256']and sha(source[name])==prepared['before_source_sha256']and sha(candidate)==prepared['after_source_sha256']and source[name]!=candidate,'heartbeat_source_version_conflict')
   function_body_delta(source[name],candidate);after={**source,name:candidate}
   need(self.identity(source)==b['before_sha256']and self.identity(after)==b['after_sha256'],'compiled_identity_binding_changed')
   before=self.observe();need(self.trusted_native(before,b['before_sha256']),'before_native_version_unconfirmed')
   self.store.begin(b,{'artifact_id':prepared['artifact_id'],'name':name,'before_sources':{k:v.decode()for k,v in source.items()},'after_source_set_sha256':source_set(after),'candidate_source_sha256':sha(candidate),'write_intent_wall':self.clock(),'write_intent_monotonic':self.mono(),'boot_id_sha256':before['boot_id_sha256']});registered=True
   self.check(b);attempted=True
   write=self.sources.replace(name,candidate,source,b['operation_id'],b['action'],lambda:self.check(b))
   need(isinstance(write,dict)and set(write)=={'effect_applied_at','effect_monotonic'}and all(finite(v)for v in write.values()),'source_write_receipt_unconfirmed')
   write={**write,'boot_id_sha256':before['boot_id_sha256']};need(source_set(self.sources.snapshot())==source_set(after),'after_source_set_unconfirmed')
   self.store.record(b,self.outcome(b,'source_written_runtime_unconfirmed','native_load_not_yet_proven',write))
   result=self.wait_native(b,write,self.mono()+self.timeout)
  except Exception as error:
   if isinstance(error,BeforeReplaceRefused):attempted=False
   reason=str(error)if type(error)is ValueError and str(error)in SAFE_FAILURES else'source_or_native_outcome_unconfirmed'if attempted else'pre_write_validation_or_admission_refused'
   result=self.outcome(b,'uncertain'if attempted else'rejected_without_effect',reason,write)
  if not registered:return self.store.reject(b,result)
  return self.store.record(b,result)
 def reconcile(self,binding):
  need(set(binding)==BINDING,'heartbeat_reconciliation_binding_refused');old=self.store.existing(binding);need(old is not None,'heartbeat_operation_not_found')
  if old.get('state')not in ('source_written_runtime_unconfirmed','uncertain'):return {**old,'effect_repeated':False}
  try:
   backup=self.store.backup(binding);need(source_set(self.sources.snapshot())==backup['after_source_set_sha256'],'source_set_changed_since_write')
   need(self.sources.cleanup_confirmed(binding['operation_id'],binding['action'])is True,'source_security_cleanup_unconfirmed')
   write=old if old.get('source_write_confirmed')is True else {'effect_applied_at':backup['write_intent_wall'],'effect_monotonic':backup['write_intent_monotonic'],'boot_id_sha256':backup['boot_id_sha256']}
   proof=self.observe()
   if self.trusted_native(proof,binding['after_sha256'],write):
    result=self.outcome(binding,'applied',write=write,native=proof)
    if old.get('source_write_confirmed')is not True:result['effect_time_semantics']='protected_intent_lower_bound;native_code_observed_after_intent'
    result['reconciled_without_source_write']=True;return self.store.record(binding,result)
  except Exception:pass
  return {**old,'effect_repeated':False,'automatic_retry':False}
