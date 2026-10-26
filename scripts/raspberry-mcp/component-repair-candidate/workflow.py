"""Candidate coordinator. No daemon, root, network, shell or deployment access.
Production integration is deliberately absent until the complete sealed package is reviewed.
"""
import contextlib,hashlib,json,re,sqlite3,os,stat,math
COMPONENTS=frozenset(('localizacao_pessoas','observacao_host','external_heartbeat','icloud_adapter'))
RUNTIME={'localizacao_pessoas':'nodered','observacao_host':'nodered','external_heartbeat':'external_heartbeat','icloud_adapter':'homeassistant'}
TERMINAL=frozenset(('verified','failed_without_effect','confirmed_not_applied','rolled_back'))
def need(v,r):
 if not v:raise ValueError(r)
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def identifier(v):need(isinstance(v,str)and re.fullmatch('[a-f0-9]{32}',v),'invalid_operation_id')
def sha(v):need(isinstance(v,str)and re.fullmatch('[a-f0-9]{64}',v),'invalid_sha256')
class Workflow:
 def __init__(self,path,clock,expires_at):
  self.clock,self.expiry=clock,expires_at
  from pathlib import Path
  path=Path(path)
  for parent in path.parents:need(not parent.is_symlink(),'symlink_state_parent')
  try:
   fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
  except FileExistsError:pass
  info=path.lstat();need(stat.S_ISREG(info.st_mode)and info.st_uid==os.getuid()and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1 and info.st_size<=1048576,'unsafe_state_database')
  self.db=sqlite3.connect(path,isolation_level=None,timeout=2);self.db.row_factory=sqlite3.Row
  self.db.executescript('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA max_page_count=256;CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, request_hash TEXT, component TEXT, task TEXT, state TEXT, base TEXT, candidate TEXT, created REAL, updated REAL, result TEXT);CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,id TEXT,state TEXT,at REAL);CREATE TABLE IF NOT EXISTS receipts(seq INTEGER PRIMARY KEY,id TEXT,state TEXT,result TEXT,result_hash TEXT,at REAL);')
 @contextlib.contextmanager
 def tx(self):
  self.db.execute('BEGIN IMMEDIATE')
  try:yield;self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
 def get(self,op):
  identifier(op);r=self.db.execute('SELECT * FROM operations WHERE id=?',(op,)).fetchone();return dict(r)if r else None
 def row(self,op):
  r=self.get(op);need(r is not None,'operation_not_found');return r
 def put(self,op,state,result=None):
  need(self.db.execute('SELECT count(*) FROM audit').fetchone()[0]<1024,'audit_capacity')
  if result is not None:
   value=json.dumps(result,sort_keys=True,separators=(',',':'));need(len(value.encode())<=16384,'receipt_size_limit');self.db.execute('INSERT INTO receipts(id,state,result,result_hash,at)VALUES(?,?,?,?,?)',(op,state,value,digest(result),self.clock()))
  self.db.execute('UPDATE operations SET state=?,updated=?,result=? WHERE id=?',(state,self.clock(),json.dumps(result)if result is not None else None,op));self.db.execute('INSERT INTO audit(id,state,at)VALUES(?,?,?)',(op,state,self.clock()))
 def admission(self):need(self.clock()<self.expiry,'administrative_lease_expired')
 def prepare(self,op,component,task,base,candidate,registered_tasks):
  identifier(op);identifier(task);sha(base);sha(candidate);need(component in COMPONENTS,'component_not_allowed');need(task in registered_tasks,'task_not_registered');need(base!=candidate,'empty_change')
  h=digest([component,task,base,candidate])
  with self.tx():
   old=self.get(op)
   if old:need(old['request_hash']==h,'operation_id_conflict');return self.status(op)|{'duplicate':True}
   self.admission();need(self.db.execute('SELECT count(*) FROM operations').fetchone()[0]<64,'operation_capacity')
   active=self.db.execute("SELECT * FROM operations WHERE state!='released'").fetchall()
   need(all(r['component']!=component for r in active),'component_reserved')
   need(sum(r['state']in ('prepared','validated')for r in active)<2,'preparation_capacity')
   self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)',(op,h,component,task,'prepared',base,candidate,self.clock(),self.clock(),None));self.db.execute('INSERT INTO audit(id,state,at)VALUES(?,?,?)',(op,'prepared',self.clock()));return self.status(op)
 def validate(self,op,verifier):
  with self.tx():
   r=self.row(op)
   if r['state']!='prepared':return self.status(op)|{'duplicate':True}
   self.admission();proof=verifier(r.copy());need(isinstance(proof,dict)and set(proof)=={'base_sha256','candidate_sha256','isolated_tests_passed','no_household_effects','reviewed_scope'},'invalid_validation_proof')
   need(proof['base_sha256']==r['base']and proof['candidate_sha256']==r['candidate']and all(proof[k]is True for k in ('isolated_tests_passed','no_household_effects','reviewed_scope')),'validation_not_accepted')
   self.put(op,'validated',proof);return self.status(op)
 def apply(self,op,observe,execute,global_admin_idle=False,resources_available=False):
  with self.tx():
   r=self.row(op)
   if r['state']!='validated':return self.status(op)|{'duplicate':True,'effect_repeated':False}
   self.admission();need(global_admin_idle is True,'full_admin_operation_active_or_unknown');need(resources_available is True,'host_resources_unavailable')
   others=self.db.execute("SELECT component,state FROM operations WHERE id!=? AND state IN ('apply_intent','uncertain','applied_awaiting_functional_proof','rollback_intent','rollback_uncertain')",(op,)).fetchall()
   need(all(x['state']not in ('apply_intent','uncertain','rollback_intent','rollback_uncertain')for x in others),'global_effect_in_flight_or_unknown')
   need(all(RUNTIME[x['component']]!=RUNTIME[r['component']]for x in others),'runtime_reserved')
   live=observe(r.copy());need(isinstance(live,dict)and live.get('collection_error')is None and live.get('loaded_sha256')==r['base'],'loaded_version_changed_or_unknown')
   self.put(op,'apply_intent',{'automatic_retry':False})
  # Durable intent commits before crossing the effect boundary.
  try:result=execute(r.copy())
  except Exception:result=None
  with self.tx():
   if self.row(op)['state']not in ('apply_intent','uncertain'):return self.status(op)
   if not isinstance(result,dict)or result.get('loaded_sha256')!=r['candidate']or result.get('receipt_verified')is not True or result.get('executor_terminal')is not True or result.get('operation_id')!=op:self.put(op,'uncertain',{'automatic_retry':False,'collection_error':'apply_outcome_unconfirmed'})
   else:self.put(op,'applied_awaiting_functional_proof',{'loaded_sha256':r['candidate'],'functional_proof':False})
   return self.status(op)
 def reconcile(self,op,observe):
  with self.tx():
   r=self.row(op)
   if r['state']not in ('apply_intent','uncertain','rollback_intent','rollback_uncertain'):return self.status(op)
   proof=observe(r.copy())
   if not isinstance(proof,dict)or proof.get('collection_error')is not None:return self.status(op)|{'collection_error':'reconciliation_unavailable'}
   if r['state']in ('rollback_intent','rollback_uncertain'):
    if proof.get('loaded_sha256')==r['base']and proof.get('rollback_receipt_verified')is True and proof.get('executor_terminal')is True and proof.get('operation_id')==op:self.put(op,'rolled_back',{'loaded_sha256':r['base'],'reconciled_without_execution':True,'functional_recovery_proven':False})
    return self.status(op)
   if proof.get('loaded_sha256')==r['candidate']and proof.get('receipt_verified')is True and proof.get('executor_terminal')is True and proof.get('operation_id')==op:self.put(op,'applied_awaiting_functional_proof',{'loaded_sha256':r['candidate'],'reconciled_without_execution':True,'functional_proof':False})
   elif proof.get('loaded_sha256')==r['base']and proof.get('definitive_no_dispatch')is True and proof.get('receipt_verified')is True and proof.get('executor_terminal')is True and proof.get('operation_id')==op:self.put(op,'confirmed_not_applied',{'definitive_no_dispatch':True,'automatic_retry':False})
   return self.status(op)
 def verify(self,op,functional_observer):
  with self.tx():
   r=self.row(op);need(r['state']=='applied_awaiting_functional_proof','functional_verification_not_ready');p=functional_observer(r.copy())
   need(isinstance(p,dict)and p.get('collection_error')is None and p.get('loaded_sha256')==r['candidate']and all(p.get(k)is True for k in ('same_operation_before_failed','same_operation_after_passed','regressions_checked','no_household_test_effects')),'functional_proof_incomplete')
   need(p.get('operation_id')==op and p.get('component_id')==r['component'],'functional_evidence_identity_mismatch')
   times=[p.get(k)for k in ('observed_at','before_failed_at','after_success_at')];need(all(type(x)in(int,float)and math.isfinite(x)and x>=0 for x in times)and 0<=self.clock()-times[0]<=60 and times[1]<times[2]and r['created']<=times[2]<=times[0],'functional_evidence_time_unconfirmed')
   if r['component']=='external_heartbeat':need(p.get('destination_receipt_verified')is True,'destination_not_proven')
   self.put(op,'verified',{'loaded_sha256':r['candidate'],'functional_proof':True,'destination_receipt_verified':p.get('destination_receipt_verified'),'proof_digest':digest(p)});return self.status(op)
 def cancel(self,op):
  with self.tx():
   r=self.row(op);need(r['state']in ('prepared','validated'),'uncertain_or_applied_operation_cannot_cancel');self.put(op,'failed_without_effect',{'canceled_before_effect':True,'automatic_retry':False});return self.status(op)
 def rollback(self,op,observe,execute,global_admin_idle=False):
  with self.tx():
   r=self.row(op)
   if r['state']not in ('applied_awaiting_functional_proof','verified'):return self.status(op)|{'duplicate':True,'effect_repeated':False}
   self.admission();need(global_admin_idle is True,'full_admin_operation_active_or_unknown');others=self.db.execute("SELECT state FROM operations WHERE id!=? AND state IN ('apply_intent','uncertain','rollback_intent','rollback_uncertain')",(op,)).fetchall();need(not others,'global_effect_in_flight_or_unknown');proof=observe(r.copy());need(isinstance(proof,dict)and proof.get('collection_error')is None and proof.get('loaded_sha256')==r['candidate']and proof.get('backup_verified')is True,'rollback_precondition_unconfirmed');self.put(op,'rollback_intent',{'base_sha256':r['base'],'automatic_retry':False})
  try:out=execute(r.copy())
  except Exception:out=None
  with self.tx():
   if isinstance(out,dict)and out.get('loaded_sha256')==r['base']and out.get('receipt_verified')is True and out.get('executor_terminal')is True and out.get('operation_id')==op:self.put(op,'rolled_back',{'loaded_sha256':r['base'],'functional_recovery_proven':False})
   else:self.put(op,'rollback_uncertain',{'automatic_retry':False})
   return self.status(op)
 def release(self,op,result_hash):
  sha(result_hash)
  with self.tx():
   r=self.row(op)
   if r['state']=='released':need(digest(json.loads(r['result']))==result_hash,'result_hash_conflict');return self.status(op)|{'duplicate':True}
   need(r['state']in TERMINAL,'uncertain_or_active_reservation_cannot_release');need(r['result']is not None and digest(json.loads(r['result']))==result_hash,'result_hash_conflict');self.put(op,'released',json.loads(r['result']));return self.status(op)
 def status(self,op):
  r=self.row(op);return {'operation_id':op,'component_id':r['component'],'task_id':r['task'],'state':r['state'],'observed_at':self.clock(),'updated_at':r['updated'],'administrative_admission_active':self.clock()<self.expiry,'reservation_retained':r['state']!='released','result':json.loads(r['result'])if r['result']is not None else None,'result_hash':digest(json.loads(r['result']))if r['result']is not None else None,'automatic_retry':False,'notLoaded_is_completion':False}
 def close(self):self.db.close()
