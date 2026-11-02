"""Synthetic temporary journals only. Parent runs serially; never installed."""
import importlib.util,json,os,pathlib,tempfile,types,unittest

ROOT=pathlib.Path(__file__).resolve().parents[4]
def load(name,relative):
 path=ROOT/relative;spec=importlib.util.spec_from_file_location(name,path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
S=load('workspace_candidate_store','scripts/raspberry-mcp/runtime-source/task-control/task_store.py')
O=load('workspace_candidate_observer','scripts/raspberry-mcp/runtime-source/task-terminal-observer/observer.py')
L=load('workspace_candidate_list','scripts/raspberry-mcp/runtime-source/task-control/task_list.py')
A=load('workspace_candidate_adapter','scripts/raspberry-mcp/runtime-source/task-terminal-observer/native_adapter.py')
THREAD='00000000-0000-0000-0000-000000000001';REF=THREAD.replace('-','')
TURN='00000000-0000-0000-0000-000000000002';OP='3'*32

class WorkspaceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.directory=pathlib.Path(self.tmp.name)
  self.path=self.directory/'jobs.sqlite3';self.lock=self.directory/'coordinator.lock'
  self.lock.touch(mode=0o600);self.store=S.Store(self.path,clock=lambda:1000);self.path.chmod(0o600)
  self.calls=[];self.q={'operation_id':OP,'task_id':REF,'text':'Synthetic communication only'}
  self.plan={'operation_state':'ready','thread_id':THREAD,'delivery_mode':'active_steer',
   'expected_turn_id':TURN,'profile_preserved':True,'authority_changed':False}
 def tearDown(self):self.store.close();self.tmp.cleanup()
 def context(self):return S.workspace_context(THREAD,self.plan)
 def invoke(self,q):
  self.calls.append(q)
  if q['mode']=='workspace_message_preflight':return self.plan
  if q['mode']=='workspace_message':return {**self.context(),'operation_state':'accepted','turn_id':TURN,'input_accepted':True,
    'reply_boundary':{'state':'post_delivery_item','item_id':'before'},'acknowledgement_evidence':None}
  if q['mode']=='workspace_message_observe':return {**self.context(),'operation_state':'completed','turn_id':TURN,
    'input_accepted':True,'answer_withheld':True,'completion_scope':'receiver_turn_and_bounded_agent_reply',
    'reply_boundary':{'state':'post_delivery_item','item_id':'before'},'acknowledgement_evidence':None,
    'assistant_acknowledged':None,
    'started_at':990,'completed_at':995}
  raise AssertionError(q['mode'])
 def send(self,**kwargs):return self.store.send(self.q,self.invoke,lambda c,t:None,lambda:None,allow_workspace=True,**kwargs)
 def test_no_task_creation_or_schema_migration_and_global_counter(self):
  before=self.store.db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
  row=self.send();self.assertEqual(row['task'],'workspace:'+THREAD);self.assertEqual(row['state'],'accepted')
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM tasks').fetchone()[0],0)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM sends').fetchone()[0],1)
  self.assertEqual(before,self.store.db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall())
  self.assertNotIn(self.q['text'],str(self.store.db.execute('SELECT * FROM sends').fetchall()))
  with self.assertRaisesRegex(ValueError,'prior_task_requires_reconciliation'):self.store.idle()
 def test_duplicate_unknown_never_replays_or_reconciles(self):
  def uncertain(q):
   if q['mode']=='workspace_message_preflight':return self.plan
   self.calls.append(q);raise TimeoutError('lost receipt')
  row=self.store.send(self.q,uncertain,lambda c,t:None,lambda:None,allow_workspace=True)
  self.assertEqual(row['state'],'send_unknown');self.assertIsNone(row['turn'])
  count=len(self.calls);self.assertTrue(self.send()['duplicate']);self.assertEqual(count,len(self.calls))
  with self.assertRaisesRegex(ValueError,'not_terminal'):self.store.reconcile(OP,S.fingerprint(json.loads(row['result'])))
 def test_preflight_refusal_reconciles_without_task_row(self):
  def refused(q):raise ValueError('workspace_thread_not_loaded')
  row=self.store.send(self.q,refused,lambda c,t:None,lambda:None,allow_workspace=True)
  self.assertEqual(row['state'],'not_dispatched');value=json.loads(row['result']);self.assertFalse(value['send_called'])
  self.assertEqual(self.store.reconcile(OP,S.fingerprint(value))['reconciled'],True)
  self.assertTrue(self.send()['duplicate']);self.assertEqual(self.calls,[])
 def test_normal_task_priority_no_workspace_fallback(self):
  self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(REF,'existing-task','0'*64,THREAD,'cancelled_before_first_send',900,900,1))
  with self.assertRaisesRegex(ValueError,'task_not_admitted'):self.send()
  self.assertEqual(self.calls,[])
 def test_shared_busy_and_quota_count_include_namespace_rows(self):
  self.send()
  with self.assertRaisesRegex(ValueError,'prior_task_requires_reconciliation'):
   self.store.send({**self.q,'operation_id':'4'*32},self.invoke,lambda c,t:None,lambda:None,allow_workspace=True)
  completed=self.store.observe(OP,self.invoke);self.store.reconcile(OP,S.fingerprint(json.loads(completed['result'])))
  seen=[]
  self.store.send({**self.q,'operation_id':'5'*32},self.invoke,lambda c,t:seen.append((c,t)),lambda:None,allow_workspace=True)
  self.assertEqual(seen,[(1,1000.0)])
 def test_terminal_metadata_is_not_message_ack(self):
  self.send();row=self.store.observe(OP,self.invoke);value=json.loads(row['result'])
  self.assertEqual(row['state'],'completed');self.assertIsNone(value['assistant_acknowledged'])
  self.assertTrue(value['answer_withheld']);self.assertNotIn('answer',value)
  self.store.reconcile(OP,S.fingerprint(value));self.store.idle()
 def test_observer_left_join_retains_namespace_and_exact_receipt_hash(self):
  self.send();pending,terminals=O._rows(self.path,self.lock,os.getuid(),0,clock=lambda:1000)
  self.assertEqual(pending[0]['thread'],THREAD);self.assertTrue(O._valid_identity(pending[0],pending=True))
  class Observe:
   enforced_timeout_seconds=.1
   def __call__(inner,q):return self.invoke({**q,'mode':'workspace_message_observe'})
  report=O.collect(lambda:O._rows(self.path,self.lock,os.getuid(),0,clock=lambda:1000),lambda:True,Observe(),now=lambda:1000,monotonic=lambda:0,scope_started_at=0)
  self.assertEqual(report['state'],'observed');self.assertEqual(report['events'][0]['terminal_state'],'completed')
  self.assertNotIn('workspace:',json.dumps(report));self.assertNotIn('task_id',report['events'][0]);self.assertEqual(report['events'][0]['operation_id'],OP)
  row=self.store.observe(OP,self.invoke);self.assertEqual(report['events'][0]['revision'],S.fingerprint(json.loads(row['result'])))
  pending,terminals=O._rows(self.path,self.lock,os.getuid(),0,clock=lambda:1000)
  self.assertEqual(pending,[]);self.assertEqual(terminals[0]['task'],'workspace:'+THREAD)
 def test_receiver_turn_completion_is_not_adapter_execution(self):
  self.send();row=self.store.observe(OP,self.invoke)
  raw={'thread_id':THREAD,'safe_title':'test-reference','origin':'workspace_reference','task_id':REF,'task_key':None,'creation_operation_id':None,'adapter_creation_state':None,'created_at':None,'registry_updated_at':None,'operations':[row]}
  projected=L.project(raw,{'status':'idle','collection_error':None,'can_accept_direct_input':True},1000)
  self.assertFalse(projected['adapter_execution_proven']);self.assertIsNone(projected['last_executed_operation_id'])
  self.assertIsNone(projected['workspace_communication']['assistant_acknowledged']);self.assertTrue(projected['workspace_communication']['receiver_turn_completed']);self.assertFalse(projected['workspace_communication']['receiver_goal_completion_verified'])
 def test_list_admission_preserves_workspace_receipt_acknowledgement(self):
  self.send();row=self.store.observe(OP,self.invoke)
  raw={'thread_id':THREAD,'safe_title':'test-reference','origin':'workspace_reference','task_id':REF,'task_key':None,'creation_operation_id':None,'adapter_creation_state':None,'created_at':None,'registry_updated_at':None,'workspace_message_reference':True,'workspace_communication_task_id':REF,'operations':[row]}
  old=L.registry;L.registry=lambda tasks,now:([raw],[],False)
  metadata={'thread_id':THREAD,'status':'idle','collection_error':None,'can_accept_direct_input':True,'cwd_is_project':True,'ephemeral':False,'model_provider':'openai'}
  try:report=L.collect({'host':'raspberry','page_size':1,'cursor':None},None,lambda q:{'rows':[metadata]},now=1000,workspace_communication_closed=False,communication_policy={'enabled':True,'expires_at':2000,'state':'fresh_preflight_required'})
  finally:L.registry=old
  communication=report['threads'][0]['workspace_communication']
  self.assertEqual(communication['operation_id'],OP);self.assertIsNone(communication['assistant_acknowledged']);self.assertTrue(communication['receiver_turn_completed']);self.assertEqual(communication['admission'],'fresh_preflight_required')
 def test_native_observer_uses_closed_workspace_metadata_route(self):
  self.send();rows=lambda:O._rows(self.path,self.lock,os.getuid(),0,clock=lambda:1000)
  seen=[]
  def runner(args,**kwargs):
   q=json.loads(kwargs['input']);seen.append(q)
   return types.SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'result':self.invoke(q)}).encode())
  adapter=A.Adapter(rows,run=runner);old=A.checked_bundle
  A.checked_bundle=lambda:(b'old',b'new',{})
  try:
   adapter.saved=(A.sha(b'old'),A.sha(b'new'),{});adapter.check_peer=lambda p:None
   reply=adapter({'mode':'observe','thread_id':THREAD,'turn_id':TURN,'operation_id':OP})
  finally:A.checked_bundle=old
  self.assertEqual(seen[0]['mode'],'workspace_message_observe');self.assertIsNone(reply['assistant_acknowledged'])
  self.assertEqual(seen[0]['reply_boundary'],{'state':'post_delivery_item','item_id':'before'})
 def test_default_policy_does_not_admit_unknown_reference(self):
  with self.assertRaisesRegex(ValueError,'task_not_admitted'):
   self.store.send(self.q,self.invoke,lambda c,t:None,lambda:None)
  self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
