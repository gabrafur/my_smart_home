"""Protected bounded component jobs and review identities. No launch or effects.
The sealed bootstrap supplies all paths/principal and initializes once at install.
No reserve expires automatically and an uncertain launch is never resubmitted.
"""
import contextlib,hashlib,json,math,os,re,sqlite3,stat,time
from pathlib import Path
ACTIONS=frozenset(('validate','apply','rollback'))
COMPONENTS=frozenset(('localizacao_pessoas','observacao_host','external_heartbeat','icloud_adapter'))
STATES=frozenset(('queued','launch_intent','running','terminal','uncertain','launch_rejected_without_effect'))
FAMILY=frozenset(('applied_awaiting_functional_proof','verified','failed_without_effect','confirmed_not_applied','rolled_back','rollback_rejected_without_effect','released'))
def need(v,r):
 if not v:raise ValueError(r)
def ident(v,n=32):need(type(v)is str and re.fullmatch('[a-f0-9]{'+str(n)+'}',v)is not None,'invalid_bound_identity')
def finite(v):return type(v)in(int,float)and math.isfinite(v)
def encoded(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(v):return hashlib.sha256(encoded(v).encode()).hexdigest()
def protected(path,owner,mode):
 path=Path(path)
 for p in (path.parent,*path.parent.parents):
  s=p.lstat();need(stat.S_ISDIR(s.st_mode)and not stat.S_ISLNK(s.st_mode),'unsafe_component_parent')
  if owner==0:need(s.st_uid==0 and not s.st_mode&0o022,'unsafe_root_component_parent')
 s=path.lstat();need(stat.S_ISREG(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=1048576,'unsafe_component_ledger')
 return (s.st_dev,s.st_ino)
class JobLedger:
 def __init__(self,path,owner=0,clock=time.time,initialize=False,read_only=False):
  self.path,self.owner,self.clock=Path(path),owner,clock
  self.read_only=read_only;need(not initialize or not read_only,'readonly_ledger_initialization_refused')
  if initialize:
   fd=os.open(self.path,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
  self.identity=protected(self.path,owner,0o600)
  self.db=sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,isolation_level=None,timeout=2)if read_only else sqlite3.connect(self.path,isolation_level=None,timeout=2);self.db.row_factory=sqlite3.Row
  if read_only:self.db.execute('PRAGMA query_only=ON')
  if initialize:
   self.db.executescript('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA max_page_count=256;CREATE TABLE meta(version INTEGER NOT NULL);INSERT INTO meta VALUES(1);CREATE TABLE preparations(id TEXT PRIMARY KEY,task TEXT,principal TEXT,component TEXT,before_sha256 TEXT,after_sha256 TEXT,preparation_sha256 TEXT,created REAL,expires REAL);CREATE TABLE reviews(id TEXT PRIMARY KEY,task TEXT,send TEXT,principal TEXT,component TEXT,review_sha256 TEXT,validation_sha256 TEXT,source_set_sha256 TEXT,created REAL,expires REAL);CREATE TABLE jobs(operation TEXT,action TEXT,binding TEXT,binding_sha256 TEXT,state TEXT,created REAL,updated REAL,receipt TEXT,PRIMARY KEY(operation,action));CREATE TABLE audit(seq INTEGER PRIMARY KEY,operation TEXT,action TEXT,state TEXT,at REAL);CREATE TABLE observations(nonce TEXT PRIMARY KEY,operation TEXT,binding_sha256 TEXT,body TEXT,at REAL,cleanup INTEGER);CREATE TABLE phases(operation TEXT,purpose TEXT,request_sha256 TEXT,state TEXT,created REAL,updated REAL,receipt TEXT,PRIMARY KEY(operation,purpose));')
  need(self.db.execute('SELECT version FROM meta').fetchall()[0][0]==1,'unknown_component_ledger_version')
  if not read_only:self.db.execute('PRAGMA synchronous=FULL');self.db.execute('PRAGMA max_page_count=256')
 def check(self):need(protected(self.path,self.owner,0o600)==self.identity,'component_ledger_replaced')
 @contextlib.contextmanager
 def tx(self):
  need(not self.read_only,'readonly_component_ledger');self.check();self.db.execute('BEGIN IMMEDIATE')
  try:yield;self.check();self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
 def audit(self,op,action,state):
  need(self.db.execute('SELECT count(*)FROM audit').fetchone()[0]<1024,'component_job_audit_capacity')
  self.db.execute('INSERT INTO audit(operation,action,state,at)VALUES(?,?,?,?)',(op,action,state,self.clock()))
 def register_preparation(self,binding,preparation_sha256,expires_at):
  """Protected writer only after baseline/source snapshot, never an RPC proof."""
  need(type(binding)is dict and set(binding)=={'operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256'},'protected_preparation_shape')
  for k in ('operation_id','task_id'):ident(binding[k])
  for k in ('principal_sha256','before_sha256','after_sha256'):ident(binding[k],64)
  ident(preparation_sha256,64);need(binding['component_id']in COMPONENTS and finite(expires_at)and self.clock()+90<expires_at<=self.clock()+86400,'protected_preparation_window')
  row=(binding['operation_id'],binding['task_id'],binding['principal_sha256'],binding['component_id'],binding['before_sha256'],binding['after_sha256'],preparation_sha256,self.clock(),expires_at)
  with self.tx():
   old=self.db.execute('SELECT *FROM preparations WHERE id=?',(row[0],)).fetchone()
   if old:need(tuple(old)[:7]==row[:7]and old['expires']==expires_at,'protected_preparation_id_conflict');return
   need(self.db.execute('SELECT count(*)FROM preparations').fetchone()[0]<64,'protected_preparation_capacity')
   self.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?,?,?,?)',row)
 def preparation(self,op):
  ident(op);self.check();r=self.db.execute('SELECT *FROM preparations WHERE id=?',(op,)).fetchone();need(r is not None,'protected_preparation_not_registered');return dict(r)
 def register_review(self,review,review_sha256):
  """Internal protected writer only, after actual validation; never an RPC action.
  Writer supplies its sealed review.json metadata. Bootstrap verifies writer bytes.
  Registration gives no task, budget or effect; admission rechecks all of them.
  """
  fields={'schema_version','operation_id','task_id','principal_sha256','component_id','send_id','before_sha256','after_sha256','before_file_sha256','after_file_sha256','source_set_sha256','validation_profile_sha256','validation_sha256','approved_at','expires_at'}
  need(type(review)is dict and set(review)==fields and review['schema_version']==1,'protected_writer_review_shape')
  for k in ('operation_id','task_id','send_id'):ident(review[k])
  for k in fields:
   if k.endswith('sha256'):ident(review[k],64)
  ident(review_sha256,64);need(review['component_id']in COMPONENTS and finite(review['approved_at'])and finite(review['expires_at'])and 0<=review['approved_at']<=self.clock()<review['expires_at']and review['expires_at']-review['approved_at']<=86400,'protected_writer_review_window')
  row=(review['operation_id'],review['task_id'],review['send_id'],review['principal_sha256'],review['component_id'],review_sha256,review['validation_sha256'],review['source_set_sha256'],review['approved_at'],review['expires_at'])
  with self.tx():
   old=self.db.execute('SELECT *FROM reviews WHERE id=?',(row[0],)).fetchone()
   if old:need(tuple(old)==row,'protected_review_id_conflict');return {'duplicate':True,'effect_started':False}
   need(self.db.execute('SELECT count(*)FROM reviews').fetchone()[0]<64,'protected_review_capacity')
   self.db.execute('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?)',row);return {'duplicate':False,'effect_started':False}
 def approved_reviews(self):
  self.check();return {r['id']:r['review_sha256']for r in self.db.execute('SELECT id,review_sha256 FROM reviews')}
 def review(self,op):
  ident(op);self.check();r=self.db.execute('SELECT *FROM reviews WHERE id=?',(op,)).fetchone();need(r is not None,'protected_review_not_registered');return dict(r)
 def get(self,op,action):
  ident(op);need(action in ACTIONS,'component_job_action_refused');self.check();r=self.db.execute('SELECT *FROM jobs WHERE operation=?AND action=?',(op,action)).fetchone()
  if r is None:return None
  d=dict(r);need(d['state']in STATES,'component_job_state_invalid');d['binding']=json.loads(d['binding']);d['receipt']=json.loads(d['receipt'])if d['receipt']else None;return d
 def enqueue(self,binding):
  fields={'operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256','action'}
  need(type(binding)is dict and set(binding)==fields,'closed_job_binding_required')
  for k in ('operation_id','task_id'):ident(binding[k])
  for k in ('principal_sha256','before_sha256','after_sha256'):ident(binding[k],64)
  need(binding['action']in ACTIONS and binding['component_id']in COMPONENTS,'job_component_or_action_refused')
  need(not self.observation_cleanup_pending(),'observation_security_cleanup_pending')
  review=self.preparation(binding['operation_id'])if binding['action']=='validate'else self.review(binding['operation_id']);need(review['task']==binding['task_id']and review['principal']==binding['principal_sha256']and review['component']==binding['component_id']and self.clock()+90<review['expires'],'job_review_identity_or_expiry')
  op,action=binding['operation_id'],binding['action'];h=digest(binding)
  with self.tx():
   old=self.get(op,action)
   if old:need(old['binding_sha256']==h,'component_job_id_conflict');return self.status(op,action)|{'duplicate':True,'effect_repeated':False}
   need(self.db.execute('SELECT count(*)FROM jobs').fetchone()[0]<192,'component_job_capacity')
   now=self.clock();self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)',(op,action,encoded(binding),h,'queued',now,now,None));self.audit(op,action,'queued');return self.status(op,action)
 def transition(self,op,action,expected,state,receipt=None):
  need(state in STATES and expected in STATES,'component_job_transition_refused')
  with self.tx():
   row=self.get(op,action);need(row is not None and row['state']==expected,'component_job_CAS_conflict')
   if receipt is not None:need(type(receipt)is dict and len(encoded(receipt).encode())<=16384,'component_job_receipt_limit')
   self.db.execute('UPDATE jobs SET state=?,updated=?,receipt=?WHERE operation=?AND action=?',(state,self.clock(),encoded(receipt)if receipt is not None else row['receipt'] and encoded(row['receipt']),op,action));self.audit(op,action,state)
   return self.status(op,action)
 def pending_jobs(self):
  self.check();rows=self.db.execute("SELECT operation,action,state FROM jobs WHERE state IN ('queued','launch_intent','running','uncertain') LIMIT 193").fetchall();phases=self.db.execute("SELECT operation,purpose AS action,state FROM phases WHERE state IN ('launch_intent','running','uncertain') LIMIT 129").fetchall();need(len(rows)<=192 and len(phases)<=128,'component_job_capacity_invalid');return [dict(r)for r in [*rows,*phases]]
 def phase(self,op,purpose):
  ident(op);need(purpose in ('prepare','seal','verify'),'closed_task_phase');self.check();r=self.db.execute('SELECT *FROM phases WHERE operation=?AND purpose=?',(op,purpose)).fetchone()
  if r is None:return None
  d=dict(r);d['receipt']=json.loads(d['receipt'])if d['receipt']else None;return d
 def begin_phase(self,op,purpose,request_sha256):
  ident(request_sha256,64)
  with self.tx():
   old=self.phase(op,purpose)
   if old:need(old['request_sha256']==request_sha256,'task_phase_request_changed');return False
   need(self.db.execute('SELECT count(*)FROM phases').fetchone()[0]<128,'task_phase_capacity');now=self.clock();self.db.execute('INSERT INTO phases VALUES(?,?,?,?,?,?,?)',(op,purpose,request_sha256,'launch_intent',now,now,None));self.audit(op,purpose,'launch_intent');return True
 def phase_transition(self,op,purpose,expected,state,receipt=None):
  need(state in ('running','terminal','uncertain'),'closed_task_phase_state')
  with self.tx():
   row=self.phase(op,purpose);need(row is not None and row['state']==expected,'task_phase_CAS_conflict')
   if receipt is not None:need(type(receipt)is dict and len(encoded(receipt).encode())<=16384,'task_phase_receipt_limit')
   self.db.execute('UPDATE phases SET state=?,updated=?,receipt=?WHERE operation=?AND purpose=?',(state,self.clock(),encoded(receipt)if receipt else None,op,purpose));self.audit(op,purpose,state)
 def status(self,op,action):
  row=self.get(op,action);need(row is not None,'component_job_not_found')
  return {'operation_id':op,'action':action,'state':row['state'],'source':'protected_component_job_ledger','observed_at':self.clock(),'age_seconds':0,'collection_error':None,'created_at':row['created'],'updated_at':row['updated'],'receipt':row['receipt'],'automatic_retry':False,'coverage':['durable_admission_and_worker_tracking','not_worker_effect_or_functional_proof_by_itself']}
 def record_observation(self,binding,proof):
  fields={'source','component_id','operation_id','nonce','state','collection_error','observed_at','loaded_sha256','identity_kind','session_revoked','functional_health','automatic_retry'}
  need(type(proof)is dict and set(proof)==fields and proof['source']=='protected_NodeRED_read_session'and proof['component_id']==binding['component_id']=='observacao_host'and proof['operation_id']==binding['operation_id']and proof['identity_kind']=='nodered_scoped_configuration_v1'and type(proof['session_revoked'])is bool and proof['functional_health']=='unknown'and proof['automatic_retry']is False,'protected_observation_shape')
  ident(proof['nonce']);need(finite(proof['observed_at'])and 0<=self.clock()-proof['observed_at']<=60,'protected_observation_stale')
  need(proof['state']in ('observed','unknown')and proof['collection_error']in (None,'readonly_runtime_collection_failed','loaded_scope_not_reviewed','read_session_revocation_unconfirmed'),'protected_observation_reason')
  if proof['state']=='observed':ident(proof['loaded_sha256'],64);need(proof['collection_error']is None and proof['session_revoked']is True,'protected_observation_not_clean')
  else:need(proof['loaded_sha256']is None and proof['collection_error']is not None,'protected_observation_unknown_shape')
  with self.tx():
   old=self.db.execute('SELECT body,binding_sha256 FROM observations WHERE nonce=?',(proof['nonce'],)).fetchone()
   if old:need(old['body']==encoded(proof)and old['binding_sha256']==digest(binding),'observation_nonce_conflict');return
   need(self.db.execute('SELECT count(*)FROM observations').fetchone()[0]<256,'protected_observation_capacity')
   self.db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?)',(proof['nonce'],proof['operation_id'],digest(binding),encoded(proof),proof['observed_at'],int(proof['session_revoked'])))
 def observation_cleanup_pending(self):
  self.check();return self.db.execute('SELECT count(*)FROM observations WHERE cleanup=0').fetchone()[0]>0
 def latest_observation(self,binding):
  self.check();row=self.db.execute('SELECT body FROM observations WHERE operation=?AND binding_sha256=? ORDER BY at DESC LIMIT 1',(binding['operation_id'],digest(binding))).fetchone()
  need(row is not None,'protected_observation_missing');proof=json.loads(row['body'])
  need(0<=self.clock()-proof['observed_at']<=60,'protected_observation_stale');return proof
 def close(self):self.db.close()
