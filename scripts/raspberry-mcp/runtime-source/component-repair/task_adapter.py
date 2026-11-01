"""Closed internal CLI for an existing MCP-created scoped task, any model.
Only operation ID and fixed purpose come from argv. Task/send/goal binding lives
in an immutable Root request and is independently checked against real ledgers.
No prompt boolean, command, path, callback, principal or model grants authority.
"""
import hashlib,json,math,time
from pathlib import Path
from component_jobs import need,ident
from worker_parent import read_json
STATE=Path('/var/lib/raspberry-component-repair')
PURPOSES=frozenset(('prepare','validate','seal','apply','rollback','status','reconcile','verify','cancel','release'))
class TaskAdapter:
 def __init__(self,factory):self.factory=factory;self.policy=factory.policy
 def request(self,op):
  ident(op);r=read_json(STATE/'requests'/(op+'.json'),0)
  fields={'schema_version','operation_id','task_id','send_id','component_id','proposal_id','root_decision_id','expected_loaded_sha256','expires_at','approval_reference_sha256'}
  need(type(r)is dict and set(r)==fields and type(r['schema_version'])is int and r['schema_version']==1 and r['operation_id']==op and r['component_id']=='observacao_host','closed_task_request_shape')
  for k in ('operation_id','task_id','send_id','proposal_id','root_decision_id'):ident(r[k])
  ident(r['expected_loaded_sha256'],64);ident(r['approval_reference_sha256'],64)
  profile=json.loads(self.factory.verified[str(STATE/'profiles/observacao_host.json')])
  need(r['approval_reference_sha256']==profile['approval_reference_sha256'],'standing_goal_reference_changed')
  need(type(r['expires_at'])in(int,float)and math.isfinite(r['expires_at'])and r['expires_at']<=min(self.policy['expires_at'],profile['owner_authorization_expires_at']),'task_request_expiry_changed')
  if '/usr/local/lib/raspberry-component-repair/initial-host-proposal.json'in self.policy.get('dependencies',{}):
   from initial_host_contract import assert_registered_request
   assert_registered_request(self.factory,r)
  return r
 def authorize(self,r):
  coord,flow,jobs,_,_=self.factory.make()
  try:
   ctx=self.factory.context;binding={'operation_id':r['operation_id'],'task_id':r['task_id'],'component_id':r['component_id']}
   with ctx['executor'].locked(),ctx['budget'].locked(),ctx['maintenance']:
    task=ctx['budget'].observe(binding,r['send_id']);ctx['executor'].existing_snapshot();ctx['reciprocal'].check('NodeRED_reader_binding',r['operation_id'])
    need(time.time()+190<min(r['expires_at'],self.policy['expires_at'],task['expires_at']),'task_request_completion_margin');ctx['resources']()
  finally:flow.close();jobs.close()
 def status(self,op):
  coord,flow,jobs,_,_=self.factory.make(read_only=True)
  try:
   phases=[jobs.phase(op,p)for p in ('prepare','seal','verify')if jobs.phase(op,p)is not None]
   try:result=coord.status(op)
   except ValueError as e:
    if str(e)!='operation_not_found':raise
    result={'operation_id':op,'state':'not_prepared','source':'protected_task_phase_ledger','collection_error':None,'observed_at':time.time(),'age_seconds':0,'coverage':['registered_task_phase_only_not_effect_or_functional_proof']}
   return {**result,'task_phases':phases,'automatic_retry':False}
  finally:flow.close();jobs.close()
 def command(self,op,purpose):
  need(purpose in PURPOSES,'closed_task_purpose');r=self.request(op)
  if purpose=='status':return self.status(op)
  self.authorize(r)
  if purpose in ('prepare','seal','verify'):
   coord,flow,jobs,_,_=self.factory.make()
   try:
    path=STATE/'requests'/(op+'.json');h=hashlib.sha256(path.read_bytes()).hexdigest()
    if jobs.begin_phase(op,purpose,h):
     try:need(self.factory.launcher(op,purpose)is True,'task_phase_start_unconfirmed')
     except Exception:jobs.phase_transition(op,purpose,'launch_intent','uncertain',{'reason':'task_phase_start_unconfirmed','automatic_retry':False})
   finally:flow.close();jobs.close()
   return self.status(op)
  coord,flow,jobs,_,_=self.factory.make()
  try:
   if purpose=='validate':return coord.queue_validation(op)
   if purpose=='apply':return coord.submit(op,'apply',r['expected_loaded_sha256'])
   if purpose=='rollback':return coord.submit(op,'rollback',flow.row(op)['candidate'])
   if purpose=='reconcile':return coord.reconcile(op)
   if purpose=='verify':return coord.verify(op)
   if purpose=='cancel':return flow.cancel(op)
   if purpose=='release':return flow.release(op,flow.status(op)['result_hash'])
   raise ValueError('closed_task_purpose')
  finally:flow.close();jobs.close()
 def run_phase(self,op,purpose):
  need(purpose in ('prepare','seal','verify'),'closed_task_phase');r=self.request(op);self.authorize(r);coord,flow,jobs,_,_=self.factory.make()
  try:
   row=jobs.phase(op,purpose);h=hashlib.sha256((STATE/'requests'/(op+'.json')).read_bytes()).hexdigest();need(row is not None and row['request_sha256']==h,'task_phase_binding_changed')
   eligible=row['state']=='launch_intent'or row['state']=='uncertain'and row['receipt']=={'reason':'task_phase_start_unconfirmed','automatic_retry':False}
   if not eligible:return self.status(op)
   jobs.phase_transition(op,purpose,row['state'],'running')
   try:
    if purpose=='prepare':
     binding={'operation_id':op,'task_id':r['task_id'],'principal_sha256':self.policy['principal_sha256'],'component_id':r['component_id'],'action':'observe'}
     result=self.factory.prepare_operation(binding,r['send_id'],r['expires_at'],r['expected_loaded_sha256'],r['proposal_id'])
    elif purpose=='seal':result=self.factory.seal_and_publish(op,r['root_decision_id'])
    else:result=coord.verify(op)
    jobs.phase_transition(op,purpose,'running','terminal',result)
   except BaseException as error:
    jobs.phase_transition(op,purpose,'running','uncertain',{'reason':'task_phase_outcome_unconfirmed','automatic_retry':False})
    if not isinstance(error,Exception):raise
  finally:flow.close();jobs.close()
  return self.status(op)
