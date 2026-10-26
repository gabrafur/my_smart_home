import contextlib,json,os,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
from admission import TaskBudgetPort,MaintenanceLease,ProtectedReview,ProtectedAdmission
OP='a'*32;TASK='b'*32;SEND='c'*32;PRINCIPAL='d'*64;THREAD='00000000-0000-0000-0000-000000000001';TURN='00000000-0000-0000-0000-000000000002'
@contextlib.contextmanager
def connection(path):
 db=sqlite3.connect(path)
 try:
  with db:yield db
 finally:db.close()
class Module:
 def __init__(self,owner):self.p={'enabled':True,'max_sends_per_24h':48,'minimum_spacing_seconds':60,'expires_at':2000,'admin_delegation':{'enabled':True,'task_key_prefix':'eva-admin-','executor_uid':owner,'expires_at':2000}};self.calls=0
 @contextlib.contextmanager
 def locked(self,read_only=False):
  assert read_only is True;self.calls+=1;yield
 def policy(self,old):return self.p,{'expires_at':2000}
class Cases(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.owner=os.getuid();self.now=1000;self.module=Module(self.owner);self.taskdb=self.root/'tasks.sqlite3';self.legacydb=self.root/'legacy.sqlite3'
  with connection(self.taskdb)as db:
   db.executescript('CREATE TABLE tasks(id,task_key,thread,state,created,reconciled);CREATE TABLE sends(id,task,state,turn,created,reconciled);')
   db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?)',(TASK,'eva-admin-synthetic',THREAD,'created',990,1));db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?)',(SEND,TASK,'accepted',TURN,999,0))
  with connection(self.legacydb)as db:db.execute('CREATE TABLE jobs(id,state,created,attempts)')
  for p in (self.taskdb,self.legacydb):p.chmod(0o600)
  self.port=TaskBudgetPort(self.module,None,self.taskdb,self.legacydb,self.owner,lambda:self.now)
  self.lock=self.root/'maintenance.lock';self.lock.touch();self.lock.chmod(0o664);self.triggers=[self.root/'daily',self.root/'git']
  for p in self.triggers:p.mkdir(mode=0o700)
  self.lease=MaintenanceLease(self.lock,self.owner,self.triggers)
  self.reviews=self.root/'reviews';self.reviews.mkdir(mode=0o700)
  self.binding={'operation_id':OP,'task_id':TASK,'principal_sha256':PRINCIPAL,'component_id':'observacao_host','before_sha256':'1'*64,'after_sha256':'2'*64,'action':'apply'}
  self.review={'binding':self.binding,'send_id':SEND,'identity_kind':'nodered_scoped_configuration_v1','isolated_tests_passed':True,'reviewed_scope':True,'expires_at':2000};self.write_review()
  self.review_port=ProtectedReview(self.reviews,self.owner)
 def write_review(self):
  p=self.reviews/(OP+'-apply.json');p.write_text(json.dumps(self.review));p.chmod(0o600)
 def tearDown(self):self.temp.cleanup()
 def observe(self):
  with self.port.locked():return self.port.observe(self.binding,SEND)
 def mutate(self,path,sql,args=()):
  with connection(path)as db:db.execute(sql,args)
 def external(self,binding):return {'global_admin_idle':True,'root_verified':True,'collection_error':None,'observed_at':self.now,'coverage':['legacy_admin_executor','durable_jobs','component_jobs']}
 def guard(self,external=None,resources=lambda:None):return ProtectedAdmission(self.port,self.lease,self.review_port,PRINCIPAL,external or self.external,resources,lambda:self.now)
 def test_existing_recorded_send_is_counted_without_any_registry_write(self):
  before=[p.read_bytes()for p in(self.taskdb,self.legacydb)];files=set(self.root.iterdir());value=self.observe();self.assertEqual(files,set(self.root.iterdir()));self.assertEqual(value['shared_sends_last_24h'],1);self.assertEqual(value['new_sends_reserved'],0);self.assertEqual(before,[p.read_bytes()for p in(self.taskdb,self.legacydb)])
 def test_registry_lock_is_required(self):
  with self.assertRaisesRegex(ValueError,'task_guard_not_held'):self.port.observe(self.binding,SEND)
 def test_missing_or_uncertain_parent_send_cannot_admit_effect(self):
  for state in ('send_intent','send_unknown','outcome_unknown','failed','not_dispatched'):
   self.mutate(self.taskdb,'UPDATE sends SET state=?',(state,))
   with self.assertRaisesRegex(ValueError,'recorded_task_send'):self.observe()
 def test_completed_parent_requires_exact_acknowledged_result(self):
  self.mutate(self.taskdb,"UPDATE sends SET state='completed'")
  with self.assertRaisesRegex(ValueError,'parent_result'):self.observe()
  self.mutate(self.taskdb,'UPDATE sends SET reconciled=1');self.assertTrue(self.observe()['registered_task'])
 def test_parent_without_turn_or_with_wrong_task_is_refused(self):
  self.mutate(self.taskdb,'UPDATE sends SET turn=NULL')
  with self.assertRaisesRegex(ValueError,'recorded_task_send'):self.observe()
  self.mutate(self.taskdb,'UPDATE sends SET turn=?,task=?',(TURN,'f'*32))
  with self.assertRaisesRegex(ValueError,'recorded_task_send'):self.observe()
 def test_ordinary_task_cannot_inherit_administrative_authority(self):
  self.mutate(self.taskdb,"UPDATE tasks SET task_key='ordinary'")
  with self.assertRaisesRegex(ValueError,'task_identity'):self.observe()
 def test_other_uncertain_send_or_unacknowledged_result_holds_gate(self):
  for state,ack in [('send_unknown',0),('completed',0),('unrecognized_state',1)]:
   self.mutate(self.taskdb,'DELETE FROM sends WHERE id!=?',(SEND,));self.mutate(self.taskdb,'INSERT INTO sends VALUES(?,?,?,?,?,?)',('e'*32,TASK,state,TURN,998,ack))
   with self.assertRaisesRegex(ValueError,'other_send'):self.observe()
 def test_other_created_task_reservation_and_legacy_uncertainty_block(self):
  self.mutate(self.taskdb,'INSERT INTO tasks VALUES(?,?,?,?,?,?)',('e'*32,'eva-admin-other',THREAD,'created',998,0))
  with self.assertRaisesRegex(ValueError,'other_task'):self.observe()
  self.mutate(self.taskdb,'DELETE FROM tasks WHERE id!=?',(TASK,));self.mutate(self.legacydb,'INSERT INTO jobs VALUES(?,?,?,?)',('e'*32,'outcome_unknown',998,1))
  with self.assertRaisesRegex(ValueError,'legacy_operation'):self.observe()
 def test_shared_budget_includes_legacy_and_own_already_counted_send(self):
  for i in range(47):self.mutate(self.legacydb,'INSERT INTO jobs VALUES(?,?,?,?)',(str(i),'completed',998,1))
  self.assertEqual(self.observe()['shared_sends_last_24h'],48)
  self.mutate(self.legacydb,'INSERT INTO jobs VALUES(?,?,?,?)',('overflow','completed',998,1))
  with self.assertRaisesRegex(ValueError,'shared_task_budget'):self.observe()
 def test_old_failed_legacy_rows_remain_preserved_without_becoming_current_failure(self):
  self.now=100000;self.mutate(self.taskdb,'UPDATE tasks SET created=99990');self.mutate(self.taskdb,'UPDATE sends SET created=99999');self.mutate(self.legacydb,'INSERT INTO jobs VALUES(?,?,?,?)',('old','failed',1,1));self.assertEqual(self.observe()['shared_sends_last_24h'],1)
  with connection(self.legacydb)as db:self.assertEqual(db.execute('SELECT state FROM jobs').fetchone()[0],'failed')
 def test_missing_corrupt_future_and_unsafe_registry_fail_closed(self):
  self.mutate(self.taskdb,'UPDATE sends SET created=1002')
  with self.assertRaisesRegex(ValueError,'timestamp'):self.observe()
  self.mutate(self.taskdb,'UPDATE sends SET created=999');self.taskdb.chmod(0o666)
  with self.assertRaisesRegex(ValueError,'unsafe_bound_file'):self.observe()
  self.taskdb.chmod(0o600);self.taskdb.write_bytes(b'not sqlite')
  with self.assertRaises(sqlite3.DatabaseError):self.observe()
 def test_task_revocation_and_policy_change_are_not_bypassed(self):
  flag=self.taskdb.parent/'revoked';flag.touch()
  with self.assertRaisesRegex(ValueError,'revoked'):self.observe()
  flag.unlink();self.module.p['max_sends_per_24h']=49
  with self.assertRaisesRegex(ValueError,'policy'):self.observe()
 def test_actual_flock_blocks_a_second_process_then_releases_after_exception(self):
  code='import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)'
  with self.assertRaisesRegex(RuntimeError,'synthetic'):
   with self.lease:
    self.assertNotEqual(subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(self.lock)],capture_output=True).returncode,0);raise RuntimeError('synthetic')
  self.assertEqual(subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(self.lock)],capture_output=True).returncode,0)
 def test_scheduler_processing_blocks_without_removing_any_trigger(self):
  trigger=self.triggers[0]/'request.processing';trigger.touch()
  with self.assertRaisesRegex(ValueError,'native_maintenance_processing'):
   with self.lease:pass
  self.assertTrue(trigger.exists());self.assertIsNone(self.lease.fd)
 def test_replaced_lock_inode_is_detected_while_held(self):
  with self.lease:
   self.lock.rename(self.root/'old.lock');self.lock.touch();self.lock.chmod(0o664)
   with self.assertRaisesRegex(ValueError,'identity_changed'):self.lease.check()
 def test_protected_review_requires_exact_principal_task_and_action(self):
  for change in ({'task_id':'e'*32},{'principal_sha256':'e'*64},{'action':'rollback'}):
   with self.assertRaises((ValueError,FileNotFoundError)):self.review_port.read({**self.binding,**change},PRINCIPAL)
  p=self.reviews/(OP+'-apply.json');p.chmod(0o644)
  with self.assertRaisesRegex(ValueError,'unsafe_bound_file'):self.review_port.read(self.binding,PRINCIPAL)
 def test_guard_derives_flags_from_locked_protected_sources(self):
  guard=self.guard()
  with self.port.locked(),self.lease:
   result=guard.check(self.binding);self.assertTrue(result['maintenance_lock_held']);self.assertEqual(result['existing_send_id'],SEND);self.assertEqual(result['new_sends_reserved'],0)
 def test_unknown_external_job_state_low_resources_or_expiry_prevent_grant(self):
  with self.port.locked(),self.lease:
   for change in ({'global_admin_idle':False},{'observed_at':994},{'collection_error':'unavailable'},{'root_verified':False},{'coverage':[]}):
    with self.assertRaisesRegex(ValueError,'external_admin_state'):self.guard(external=lambda b:{**self.external(b),**change}).check(self.binding)
   def low():raise ValueError('task_memory_pressure')
   with self.assertRaisesRegex(ValueError,'memory_pressure'):self.guard(resources=low).check(self.binding)
   self.review['expires_at']=1080;self.write_review()
   with self.assertRaisesRegex(ValueError,'completion_margin'):self.guard().check(self.binding)
 def test_old_or_missing_parent_and_missing_database_remain_unknown(self):
  self.now=100000
  with self.assertRaisesRegex(ValueError,'recorded_task_send'):self.observe()
  self.now=1000;self.taskdb.unlink()
  with self.assertRaises(FileNotFoundError):self.observe()
 def test_second_guard_refuses_busy_or_missing_lock_without_creating_file(self):
  second=MaintenanceLease(self.lock,self.owner,self.triggers)
  with self.lease:
   with self.assertRaisesRegex(ValueError,'maintenance_lock_busy'):
    with second:pass
  self.lock.unlink()
  with self.assertRaises(FileNotFoundError):
   with second:pass
  self.assertFalse(self.lock.exists())
 def test_grant_timestamp_uses_shared_millisecond_precision_without_future_tolerance(self):
  self.now=1000+123987/1000000
  with self.port.locked(),self.lease:
   value=self.guard().check(self.binding)
  self.assertEqual(value['observed_at'],1000.123);self.assertLessEqual(value['observed_at'],self.now)
if __name__=='__main__':unittest.main()
