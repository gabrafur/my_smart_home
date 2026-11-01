"""Bound durable coordinator. Ports come from sealed bootstrap, never requests.
Job startup has an at-most-once launch boundary. Worker launch can be uncertain;
status/reconcile only inspect receipts and never call the effect port again.
"""
import contextlib,math,time
from component_jobs import ident,need,digest
SUPPORTED=frozenset(('observacao_host',))
MUTATING_TOOLS=frozenset(('component_apply_repair','component_revert_repair'))
class RootCoordinator:
 def __init__(self,workflow,jobs,reviews,worker,observe,functional,launcher,principal,expires_at,resources,clock=time.time,validator=None):
  self.flow,self.jobs,self.reviews,self.worker=workflow,jobs,reviews,worker
  self.observe,self.functional,self.launch=observe,functional,launcher
  self.principal,self.expiry,self.resources,self.clock=principal,expires_at,resources,clock
  self.validator=validator
  ident(principal,64)
 def binding(self,op,action):
  ident(op);need(action in ('apply','rollback'),'component_action_refused');row=self.flow.row(op)
  need(row['component']in SUPPORTED,'component_effect_port_not_activated')
  before,after=(row['base'],row['candidate'])if action=='apply'else(row['candidate'],row['base'])
  binding={'operation_id':op,'task_id':row['task'],'component_id':row['component'],'principal_sha256':self.principal,'before_sha256':before,'after_sha256':after,'action':action}
  self.reviews.read(binding,self.principal);return binding
 def submit(self,op,action,expected):
  ident(expected,64);need(self.clock()+90<self.expiry,'operator_lease_completion_margin');binding=self.binding(op,action)
  need(expected==binding['before_sha256'],'loaded_precondition_does_not_match_bound_operation')
  old=self.jobs.get(op,action)
  if old:return self.status(op)|{'duplicate':True,'effect_repeated':False}
  row=self.flow.row(op);need(row['state']==('validated'if action=='apply'else'applied_awaiting_functional_proof')or action=='rollback'and row['state']=='verified','component_workflow_not_ready')
  self.jobs.enqueue(binding);self.jobs.transition(op,action,'queued','launch_intent')
  try:
   # The bound launcher requests only one fixed systemd job. A lost response is
   # uncertainty, not permission for another start. Worker may still claim it.
   accepted=self.launch(op,action)
   need(accepted is True,'job_start_not_confirmed')
  except Exception:
   current=self.jobs.get(op,action)
   if current['state']=='launch_intent':self.jobs.transition(op,action,'launch_intent','uncertain',{'reason':'job_start_unconfirmed','automatic_retry':False})
  return self.status(op)
 def queue_validation(self,op):
  need(self.clock()+90<self.expiry,'operator_lease_completion_margin');p=self.jobs.preparation(op)
  binding={'operation_id':op,'task_id':p['task'],'principal_sha256':p['principal'],'component_id':p['component'],'before_sha256':p['before_sha256'],'after_sha256':p['after_sha256'],'action':'validate'}
  old=self.jobs.get(op,'validate')
  if old:return self.status(op)|{'duplicate':True,'effect_repeated':False}
  self.jobs.enqueue(binding);self.jobs.transition(op,'validate','queued','launch_intent')
  try:need(self.launch(op,'validate')is True,'validation_start_not_confirmed')
  except Exception:
   if self.jobs.get(op,'validate')['state']=='launch_intent':self.jobs.transition(op,'validate','launch_intent','uncertain',{'reason':'job_start_unconfirmed','automatic_retry':False})
  return self.status(op)
 def run_validation(self,op):
  need(self.validator is not None,'protected_validator_port_not_bound');job=self.jobs.get(op,'validate');need(job is not None,'validation_job_not_registered')
  claimable=job['state']=='launch_intent'or job['state']=='uncertain'and job['receipt']=={'reason':'job_start_unconfirmed','automatic_retry':False}
  if not claimable:return self.status(op)|{'duplicate':True,'effect_repeated':False}
  self.jobs.transition(op,'validate',job['state'],'running')
  try:
   need(self.clock()+190<self.expiry,'validation_lease_completion_margin');need(self.resources()is None,'resource_gate_contract_changed')
   result=self.validator(op)
   # Protected validator returns fixed metadata; Root decision/publication remains
   # separate. A subprocess timeout cannot become passed validation.
   need(type(result)is dict and result.get('operation_id')==op and result.get('household_effects')==0 and result.get('executor_terminal')is True,'protected_validation_terminal_receipt_required')
   self.jobs.transition(op,'validate','running','terminal',result)
  except BaseException as error:
   if self.jobs.get(op,'validate')['state']=='running':self.jobs.transition(op,'validate','running','uncertain',{'reason':'validation_outcome_unconfirmed','automatic_retry':False})
   if not isinstance(error,Exception):raise
  return self.status(op)
 def run_once(self,op,action):
  binding=self.binding(op,action);row=self.jobs.get(op,action);need(row is not None and row['binding']==binding,'durable_job_binding_mismatch')
  claimable=row['state']=='launch_intent'or row['state']=='uncertain'and row['receipt']=={'reason':'job_start_unconfirmed','automatic_retry':False}
  if not claimable:return self.status(op)|{'duplicate':True,'effect_repeated':False}
  # A service activated after an uncertain start can claim its own persisted job
  # once; no client can schedule a second process from this state.
  self.jobs.transition(op,action,row['state'],'running')
  try:
   need(self.clock()+90<self.expiry,'operator_lease_completion_margin')
   need(self.resources()is None,'resource_gate_contract_changed')
   def execute(_):return self.worker.run(op,action)
   # The worker itself rechecks registered executors, resources, task and locks.
   # These coordinator flags are internal, not a client proof; no effect port can
   # execute without ProtectedAdmission independently succeeding.
   if action=='apply':result=self.flow.apply(op,self.observe,execute,global_admin_idle=True,resources_available=True)
   else:result=self.flow.rollback(op,self.observe,execute,global_admin_idle=True)
   state='uncertain'if result['state']in ('apply_intent','uncertain','rollback_intent','rollback_uncertain')else'terminal'
   self.jobs.transition(op,action,'running',state,{'workflow_state':result['state'],'workflow_result_hash':result['result_hash'],'automatic_retry':False})
  except BaseException as error:
   current=self.jobs.get(op,action)
   if current['state']=='running':self.jobs.transition(op,action,'running','uncertain',{'reason':'worker_or_admission_outcome_unconfirmed','automatic_retry':False})
   if not isinstance(error,Exception):raise
  return self.status(op)
 def reconcile(self,op):
  ident(op);row=self.flow.row(op)
  action='rollback'if row['state']in ('rollback_intent','rollback_uncertain')else'apply'
  def receipt(_):return self.worker.previous(self.binding(op,action))
  out=self.flow.reconcile(op,receipt)
  job=self.jobs.get(op,action)
  if job is not None and job['state']in ('running','uncertain','launch_intent')and out['state']not in ('prepared','validated','apply_intent','uncertain','rollback_intent','rollback_uncertain'):
   self.jobs.transition(op,action,job['state'],'terminal',{'workflow_state':out['state'],'workflow_result_hash':out['result_hash'],'reconciled_without_launch_or_effect':True,'automatic_retry':False})
  return self.status(op)
 def verify(self,op):return self.flow.verify(op,self.functional)
 def status(self,op):
  result=self.flow.status(op);result['jobs']=[self.jobs.status(op,a)for a in ('validate','apply','rollback')if self.jobs.get(op,a)is not None]
  result['source']='protected_component_workflow_and_job_ledgers';result['age_seconds']=0;result['collection_error']=None;result['coverage']=['durable_operation_lifecycle','protected_worker_receipts_required','functional_proof_separate','not_Eva_execution_proof'];return result
 def dispatch(self,name,args):
  need(type(args)is dict and args.get('host')=='raspberry','invalid_component_request')
  fields={'component_validate_repair':{'host','operation_id'},'component_apply_repair':{'host','operation_id','expected_loaded_sha256'},'component_revert_repair':{'host','operation_id','expected_loaded_sha256'},'component_repair_status':{'host','operation_id'},'component_repair_reconcile':{'host','operation_id'},'component_verify_repair':{'host','operation_id'},'component_scope_release':{'host','operation_id','result_hash'},'component_cancel_repair':{'host','operation_id'}}
  need(name in fields and set(args)==fields[name],'closed_component_request_required');op=args['operation_id'];ident(op)
  if name=='component_validate_repair':return self.queue_validation(op)
  if name in MUTATING_TOOLS:return self.submit(op,'apply'if name=='component_apply_repair'else'rollback',args['expected_loaded_sha256'])
  if name=='component_repair_status':return self.status(op)
  if name=='component_repair_reconcile':return self.reconcile(op)
  if name=='component_verify_repair':return self.verify(op)
  if name=='component_scope_release':return self.flow.release(op,args['result_hash'])
  return self.flow.cancel(op)
