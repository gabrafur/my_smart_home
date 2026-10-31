"""Two existing Codex threads only. Durable no-replay admission; no shell API."""
import datetime,fcntl,hashlib,json,os,re,socket,sqlite3,stat,struct,subprocess,time
from pathlib import Path
THREADS=('${AUTHORIZED_THREAD_ID_1}','${AUTHORIZED_THREAD_ID_2}')
OBSERVATION_THREADS=(*THREADS,'${AUTHORIZED_THREAD_ID_3}')
TOOLS=('codex_thread_read','codex_thread_status','codex_thread_send')
ROOT=Path('/usr/local/lib/raspberry-mcp');POLICY=ROOT/'codex-control-approval.json';STATE=Path('/var/lib/raspberry-mcp-operations/codex-control');SOCKET='/run/raspberry-mcp/codex-control.sock'
def need(ok,why):
 if not ok:raise ValueError(why)
def read(path,owner,mode):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==owner and stat.S_IMODE(s.st_mode)==mode and s.st_nlink==1 and s.st_size<=1048576,'unsafe_control_file');return os.read(fd,1048577)
 finally:os.close(fd)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def plan():
 p=json.loads(read(POLICY,0,0o644));need(p.get('enabled') is True,'codex_control_disabled')
 need(p['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip() and p['approved_at']<=time.time()<p['expires_at'] and p['expires_at']-p['approved_at']==86400 and 0<=time.monotonic()-p['approved_monotonic']<86400,'control_lease_expired')
 need(p['threads']==list(THREADS) and p['project']=='/mnt/data/docker' and p['max_sends']==6,'control_scope_changed')
 for name,digest in p['source_hashes'].items():
  need(name in ('codex_control.py','codex_control_rpc.cjs') and sha(read(ROOT/name,0,0o644))==digest,'control_code_changed')
 need(set(p['source_hashes'])=={'codex_control.py','codex_control_rpc.cjs'},'control_scope_changed');return p

def peer(p):
 s=os.stat(SOCKET,follow_symlinks=False);need(stat.S_ISSOCK(s.st_mode) and s.st_uid==1001 and stat.S_IMODE(s.st_mode)==0o600 and [s.st_dev,s.st_ino]==p['socket_identity'],'control_socket_changed')
 with socket.socket(socket.AF_UNIX) as c:
  c.settimeout(2);c.connect(SOCKET);pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(pid==p['peer_pid'] and uid==1001,'control_peer_changed')

def rpc(q,p):
 peer(p)
 try:
  r=subprocess.run(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=24',str(ROOT/'codex_control_rpc.cjs')],input=json.dumps(q).encode(),capture_output=True,timeout=15,env={'PATH':'/usr/bin:/bin','WS_NO_BUFFER_UTIL':'1','WS_NO_UTF_8_VALIDATE':'1'})
  need(len(r.stdout)<=16384,'control_response_limit');v=json.loads(r.stdout);need(v.get('ok') is True,v.get('error') if re.fullmatch('[a-z_]{1,60}',str(v.get('error',''))) else 'control_unconfirmed');return v['result']
 except (subprocess.TimeoutExpired,OSError,json.JSONDecodeError):raise ValueError('control_outcome_unconfirmed') from None

def validate(name,args):
 need(name in TOOLS and isinstance(args,dict),'invalid_parameters');keys={'host','thread_id'}
 if name=='codex_thread_send':keys|={'operation_id','intent'}
 else:
  if 'operation_id' in args:keys.add('operation_id')
 allowed=THREADS if name=='codex_thread_send' or 'operation_id' in args else OBSERVATION_THREADS
 need(set(args)==keys and args.get('host')=='raspberry' and args.get('thread_id') in allowed,'thread_out_of_scope')
 if 'operation_id' in args:need(isinstance(args['operation_id'],str) and re.fullmatch('[a-f0-9]{32}',args['operation_id']),'invalid_operation_id')
 if name=='codex_thread_send':need(args['intent'] in ('continue','checkpoint'),'intent_out_of_scope')

class Store:
 def __init__(self,path=STATE):
  s=path.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==1001 and stat.S_IMODE(s.st_mode)==0o700,'unsafe_control_state')
  dbpath=path/'jobs.sqlite3'
  if os.path.lexists(dbpath):read(dbpath,1001,0o600)
  self.db=sqlite3.connect(dbpath,timeout=2,isolation_level=None);os.chmod(dbpath,0o600);self.db.row_factory=sqlite3.Row;self.db.execute('PRAGMA synchronous=FULL')
  self.db.executescript('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,thread TEXT,intent TEXT,state TEXT,created REAL,updated REAL,attempts INTEGER,turn TEXT,result TEXT); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,id TEXT,state TEXT,at REAL);')
 def close(self):self.db.close()
 def get(self,op):
  r=self.db.execute('SELECT * FROM jobs WHERE id=?',(op,)).fetchone();return dict(r) if r else None
 def audit(self,op,state):
  need(self.db.execute('SELECT count(*) FROM audit').fetchone()[0]<256,'control_audit_capacity');self.db.execute('INSERT INTO audit(id,state,at) VALUES(?,?,?)',(op,state,time.time()))
 def output(self,row):
  return {'operation_id':row['id'],'thread_id':row['thread'],'intent':row['intent'],'state':row['state'],'attempts':row['attempts'],'turn_id':row['turn'],'updated_at':datetime.datetime.fromtimestamp(row['updated'],datetime.timezone.utc).isoformat(),'reconciliation_required':row['state'] in ('dispatch_intent','outcome_unknown'),'result':json.loads(row['result']) if row['result'] else None,'automatic_retry':False}
 def send(self,args,p,invoke=rpc):
  op=args['operation_id'];old=self.get(op)
  if old:
   need(old['thread']==args['thread_id'] and old['intent']==args['intent'],'operation_id_conflict');return self.output(old)|{'duplicate':True}
  need(not self.db.execute("SELECT 1 FROM jobs WHERE state IN ('dispatch_intent','outcome_unknown','accepted','inProgress') LIMIT 1").fetchone(),'prior_control_operation_requires_reconciliation')
  need(self.db.execute('SELECT count(*) FROM jobs').fetchone()[0]<64,'control_history_capacity')
  need(self.db.execute('SELECT count(*) FROM jobs WHERE attempts>0 AND created>?',(time.time()-86400,)).fetchone()[0]<6,'control_send_budget_exhausted')
  invoke({'mode':'preflight','thread_id':args['thread_id']},p)
  self.db.execute('BEGIN IMMEDIATE')
  try:
   now=time.time();self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)',(op,args['thread_id'],args['intent'],'dispatch_intent',now,now,1,None,None));self.audit(op,'dispatch_intent');self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
  try:
   r=invoke({'mode':'send','thread_id':args['thread_id'],'operation_id':op,'intent':args['intent']},p)
   need(r.get('operation_state')=='accepted' and re.fullmatch('[a-f0-9-]{36}',r.get('turn_id','')),'control_acceptance_unconfirmed')
   state='accepted';turn=r['turn_id'];result={'server_accepted':True}
  except Exception:state='outcome_unknown';turn=None;result={'outcome':'unconfirmed_no_retry'}
  self.db.execute('UPDATE jobs SET state=?,turn=?,updated=?,result=? WHERE id=?',(state,turn,time.time(),json.dumps(result),op));self.audit(op,state);return self.output(self.get(op))
 def observe(self,args,p,invoke=rpc):
  row=self.get(args['operation_id']);need(row is not None and row['thread']==args['thread_id'],'control_operation_not_found')
  if row['turn'] and row['state'] in ('accepted','inProgress'):
   r=invoke({'mode':'observe','thread_id':row['thread'],'operation_id':row['id'],'turn_id':row['turn']},p);state=r.get('operation_state');need(state in ('completed','failed','interrupted','inProgress','outcome_unknown'),'control_turn_unconfirmed')
   self.db.execute('UPDATE jobs SET state=?,updated=?,result=? WHERE id=?',(state,time.time(),json.dumps(r),row['id']))
   if state!=row['state']:self.audit(row['id'],state)
  return self.output(self.get(row['id']))

def capabilities():
 try:p=plan();return {'enabled':True,'send_enabled':p.get('allow_send',True) is True,'threads':list(THREADS),'project_scope':'existing_tasks_not_filesystem_confinement','max_sends':6,'expires_at':p['expires_at'],'fixed_intents':['continue','checkpoint'],'automatic_retry':False}
 except Exception:return {'enabled':False,'automatic_retry':False}

def handle(name,args):
 need(os.geteuid()==1001,'control_identity_refused');validate(name,args);p=plan()
 if name=='codex_thread_send':need(p.get('allow_send',True) is True,'legacy_send_not_authorized')
 if name!='codex_thread_send' and 'operation_id' not in args:return {'source':'existing_codex_daemon_official_rpc','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**rpc({'mode':'metadata','thread_id':args['thread_id']},p),'scope':'authorized_existing_reference_metadata;not_project_filesystem_confinement;no_raw_history','automatic_retry':False}
 store=Store()
 try:return store.send(args,p) if name=='codex_thread_send' else store.observe(args,p)
 finally:store.close()
