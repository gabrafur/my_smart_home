"""Real private IPC/subprocess/HTTP/filesystem, synthetic data and admission only."""
import contextlib,copy,fcntl,hashlib,http.server,json,math,os,shutil,socket,subprocess,sys,threading,tempfile,time,unittest
from unittest.mock import patch
from pathlib import Path
from admission import MaintenanceLease
from worker_parent import BoundNodeRedParent
OP='a'*32;TASK='b'*32;PRINCIPAL='c'*64;TAB='host_observer_tab'
def identity(nodes):
 nodes=copy.deepcopy(nodes)
 for node in nodes:
  node.setdefault('wires',[])
  while node['wires']and not node['wires'][-1]:node['wires'].pop()
 return hashlib.sha256((json.dumps(sorted(nodes,key=lambda n:n['id']),sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
class Cases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.owner=os.getuid();self.calls=[];self.guards=0;self.credentials=0;self.deny=0;self.mode='success';self.lock_violations=[]
  # A synthetic fixture uses the Node executable selected by its test runner.
  # Keep the candidate's fixed production command unchanged and assert it here.
  self.node_binary=os.environ.get('COMPONENT_REPAIR_TEST_NODE')or shutil.which('node')
  self.assertTrue(self.node_binary and Path(self.node_binary).is_file(),'fixture Node runtime unavailable')
  self.node_launches=[];original_popen=subprocess.Popen
  def fixture_popen(args,*positional,**kwargs):
   if args[0]=='/usr/bin/node':
    self.node_launches.append(tuple(args));args=[self.node_binary,*args[1:]]
   return original_popen(args,*positional,**kwargs)
  mock=patch('worker_parent.subprocess.Popen',side_effect=fixture_popen);mock.start();self.addCleanup(mock.stop)
  self.lock=self.root/'maintenance.lock';self.lock.touch();self.lock.chmod(0o664);triggers=[self.root/'daily',self.root/'git']
  for p in triggers:p.mkdir(mode=0o700)
  self.lease=MaintenanceLease(self.lock,self.owner,triggers)
  self.prepared_dir=self.root/'prepared';self.prepared_dir.mkdir(mode=0o700);self.state=self.root/'state';self.state.mkdir(mode=0o700)
  for action in('apply','rollback'):(self.state/action).mkdir(mode=0o700)
  self.effects=self.root/'effects';self.effects.mkdir(mode=0o700);source=Path(__file__).parent
  runtime=source/('effects'if(source/'effects').exists()else'worker-draft')
  for name,src in [('nodered_job.cjs',runtime/'nodered_job.cjs'),('nodered_effect.cjs',runtime/'nodered_effect.cjs'),('attestation_model.cjs',source/'attestation_model.cjs')]:
   dest=(self.root/name)if name=='attestation_model.cjs'else self.effects/name;dest.write_bytes(src.read_bytes());dest.chmod(0o644)
  self.source_hashes={name:hashlib.sha256((self.root/name if name=='attestation_model.cjs'else self.effects/name).read_bytes()).hexdigest()for name in('nodered_job.cjs','nodered_effect.cjs','attestation_model.cjs')}
  self.flows=[{'id':TAB,'type':'tab','label':'synthetic'},{'id':'function_one','type':'function','z':TAB,'func':'return msg;','initialize':'','finalize':'','wires':[[]]}];self.before=copy.deepcopy(self.flows);nodes=copy.deepcopy(self.flows);nodes[1]['func']='msg.repaired=true;return msg;'
  self.prepared={'operation_id':OP,'task_id':TASK,'principal_sha256':PRINCIPAL,'component_id':'observacao_host','before_sha256':identity(self.flows),'after_sha256':identity(nodes),'candidate_nodes':nodes};self.write_prepared(self.prepared,'apply');self.rev='0'*64
  case=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def reply(self,value,status=200):
    self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers()
    try:self.wfile.write(json.dumps(value).encode())
    except(BrokenPipeError,ConnectionResetError):pass
   def do_GET(self):case.calls.append(('GET',self.path));self.reply({'rev':case.rev,'flows':case.flows})
   def do_POST(self):
    raw=self.rfile.read(int(self.headers.get('Content-Length','0')));row=json.loads(raw);case.calls.append(('POST',self.path))
    if self.path=='/auth/token':self.reply({'access_token':'PRIVACY_TEST_FIXTURE'});return
    if self.path=='/auth/revoke':self.reply({},500 if case.mode=='revoke-failure'else 200);return
    if self.path=='/flows':
     with case.lock.open('rb')as stream:
      try:fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB);case.lock_violations.append('not held during POST')
      except BlockingIOError:pass
     if case.mode=='conflict':self.reply({},409);return
     case.flows=row['flows'];case.rev='1'*64
     if case.mode=='lost-response':self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
     if case.mode=='late':time.sleep(1)
     self.reply({'rev':case.rev});return
    self.reply({},404)
  self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True;self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01),daemon=True);self.thread.start()
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2);self.tmp.cleanup()
 def write_prepared(self,value,action):
  p=self.prepared_dir/(OP+'-'+action+'.json');p.write_text(json.dumps(value));p.chmod(0o600)
 def auth(self):self.credentials+=1;return {'host':'127.0.0.1','port':self.server.server_address[1],'username':'synthetic','password':'PRIVACY_TEST_FIXTURE'}
 @contextlib.contextmanager
 def admission(self):
  with self.lease:
   def check(binding):
    self.guards+=1;self.lease.check()
    if self.guards==self.deny:raise ValueError('synthetic_guard_rejection')
    return {**binding,'identity_kind':'nodered_scoped_configuration_v1','registered_task':True,'reviewed_candidate':True,'principal_matches':True,'shared_budget_reserved':True,'global_admin_idle':True,'resources_available':True,'maintenance_lock_held':True,'observed_at':math.floor(time.time()*1000)/1000,'expires_at':time.time()+3600}
   yield check
 def parent(self,timeout=75):return BoundNodeRedParent(self.effects/'nodered_job.cjs',self.source_hashes,self.prepared_dir,self.state,self.admission,self.auth,self.owner,timeout)
 def posts(self):return sum(m=='POST'and p=='/flows'for m,p in self.calls)
 def test_private_ipc_grants_twice_under_actual_lease_and_keeps_one_terminal_receipt(self):
  parent=self.parent();result=parent.run(OP,'apply');self.assertEqual(result['state'],'applied',result);self.assertTrue(result['receipt_verified']);self.assertTrue(result['security_cleanup_confirmed']);self.assertEqual(self.guards,3);self.assertEqual(self.posts(),1);self.assertFalse(self.lock_violations)
  duplicate=parent.run(OP,'apply');self.assertTrue(duplicate['duplicate']);self.assertEqual(self.posts(),1);self.assertEqual(self.credentials,1);self.assertNotIn('PRIVACY_TEST_FIXTURE',json.dumps(result))
  self.assertEqual(len(self.node_launches),1);self.assertEqual(self.node_launches[0][:4],('/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=32'))
 def test_fixture_supports_Node_outside_the_fixed_system_location(self):
  alias=self.root/'toolchain-node';alias.symlink_to(self.node_binary);self.node_binary=str(alias)
  result=self.parent().run(OP,'apply');self.assertEqual(result['state'],'applied',result);self.assertEqual(self.posts(),1)
  self.assertEqual(self.node_launches[0][0],'/usr/bin/node','production binding remains fixed')
 def test_prelaunch_denial_is_durable_no_effect_without_reading_credentials(self):
  self.deny=1;parent=self.parent();r=parent.run(OP,'apply');self.assertEqual(r['state'],'rejected_without_effect');self.assertTrue(r['definitive_no_effect']);self.assertEqual(self.credentials,0);self.assertEqual(self.calls,[]);parent.run(OP,'apply');self.assertEqual(self.guards,1)
 def test_second_child_guard_denial_revokes_session_without_deploy(self):
  self.deny=3;r=self.parent().run(OP,'apply');self.assertEqual(r['state'],'rejected_without_effect',r);self.assertTrue(r['security_cleanup_confirmed']);self.assertEqual(self.posts(),0);self.assertIn(('POST','/auth/revoke'),self.calls)
 def test_lost_http_reply_remains_uncertain_and_never_replays(self):
  self.mode='lost-response';parent=self.parent();r=parent.run(OP,'apply');self.assertEqual(r['state'],'uncertain',r);parent.run(OP,'apply');self.assertEqual(self.posts(),1)
 def test_deadline_kills_child_before_releasing_lease_and_preserves_intent(self):
  self.mode='late';parent=self.parent(.4);r=parent.run(OP,'apply');self.assertEqual(r['state'],'uncertain',r);self.assertEqual(self.posts(),1);self.assertTrue((self.state/'apply'/OP/'intent.json').exists());parent.run(OP,'apply');self.assertEqual(self.posts(),1);self.assertFalse(self.lock_violations)
 def test_changed_sealed_worker_is_refused_before_child_or_credentials(self):
  parent=self.parent();(self.effects/'nodered_job.cjs').write_text('// changed')
  with self.assertRaisesRegex(ValueError,'sealed_worker_source_changed'):parent.run(OP,'apply')
  self.assertEqual(self.credentials,0);self.assertEqual(self.calls,[])
 def test_rollback_uses_same_operation_id_and_separate_purpose(self):
  parent=self.parent();self.assertEqual(parent.run(OP,'apply')['state'],'applied');p={**self.prepared,'before_sha256':self.prepared['after_sha256'],'after_sha256':self.prepared['before_sha256'],'candidate_nodes':self.before};self.write_prepared(p,'rollback');r=parent.run(OP,'rollback');self.assertEqual(r['state'],'applied',r);self.assertEqual(r['action'],'rollback');self.assertEqual(self.flows[1]['func'],'return msg;');self.assertEqual(self.posts(),2);parent.run(OP,'rollback');self.assertEqual(self.posts(),2)
 def test_unknown_cleanup_and_explicit_conflict_remain_distinct(self):
  self.mode='revoke-failure';r=self.parent().run(OP,'apply');self.assertEqual(r['state'],'applied',r);self.assertFalse(r['security_cleanup_confirmed'])
 def test_child_is_killed_if_the_process_holding_the_lease_dies(self):
  config={'module_root':str(Path(__file__).parent),'entry':str(self.effects/'nodered_job.cjs'),'hashes':self.source_hashes,'prepared':str(self.prepared_dir),'state':str(self.state),'lock':str(self.lock),'triggers':[str(self.root/'daily'),str(self.root/'git')],'port':self.server.server_address[1],'pid_file':str(self.root/'worker.pid'),'node_binary':self.node_binary}
  code="""import contextlib,json,math,os,sys,time
from pathlib import Path
c=json.loads(sys.argv[1]);sys.path.insert(0,c['module_root'])
import worker_parent
from admission import MaintenanceLease
lease=MaintenanceLease(c['lock'],os.getuid(),c['triggers'])
@contextlib.contextmanager
def admission():
 with lease:
  def check(binding):return {**binding,'identity_kind':'nodered_scoped_configuration_v1','registered_task':True,'reviewed_candidate':True,'principal_matches':True,'shared_budget_reserved':True,'global_admin_idle':True,'resources_available':True,'maintenance_lock_held':True,'observed_at':math.floor(time.time()*1000)/1000,'expires_at':time.time()+3600}
  yield check
original=worker_parent.subprocess.Popen
def launched(*args,**kwargs):
 if args[0][0]=='/usr/bin/node':args=([c['node_binary'],*args[0][1:]],*args[1:])
 p=original(*args,**kwargs);Path(c['pid_file']).write_text(str(p.pid));return p
worker_parent.subprocess.Popen=launched
job=worker_parent.BoundNodeRedParent(c['entry'],c['hashes'],c['prepared'],c['state'],admission,lambda:{'host':'127.0.0.1','port':c['port'],'username':'synthetic','password':'PRIVACY_TEST_FIXTURE'},os.getuid())
job.run('a'*32,'apply')
"""
  process=subprocess.Popen([sys.executable,'-I','-S','-B','-c',code,json.dumps(config)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   target=Path(config['pid_file']);end=time.monotonic()+3
   while not target.exists()and process.poll()is None and time.monotonic()<end:time.sleep(.01)
   self.assertTrue(target.exists(),'fixture parent never launched child');pid=int(target.read_text());process.kill();process.wait(timeout=2)
   end=time.monotonic()+2;terminal=False
   while time.monotonic()<end:
    try:state=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[0]
    except (FileNotFoundError,ProcessLookupError):terminal=True;break
    if state in('Z','X'):terminal=True;break
    time.sleep(.01)
   self.assertTrue(terminal,'worker outlived parent holding lease')
  finally:
   if process.poll()is None:process.kill();process.wait(timeout=2)
 def test_terminal_receipt_cannot_export_unreviewed_fields(self):
  parent=self.parent();self.assertEqual(parent.run(OP,'apply')['state'],'applied');path=self.state/'apply'/OP/'receipt.json';r=json.loads(path.read_text());r['private_error']='PRIVACY_TEST_FIXTURE';path.write_text(json.dumps(r));path.chmod(0o600)
  with self.assertRaisesRegex(ValueError,'content_refused'):parent.run(OP,'apply')
  self.assertEqual(self.posts(),1)
if __name__=='__main__':unittest.main()
