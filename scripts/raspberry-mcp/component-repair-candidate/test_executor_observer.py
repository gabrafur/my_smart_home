import contextlib,json,os,sqlite3,tempfile,unittest
from pathlib import Path
from admission import MaintenanceLease
from executor_observer import ExecutorObserver,ExistingLock,digest
OP='a'*32;TASK='b'*32
@contextlib.contextmanager
def connection(path):
 db=sqlite3.connect(path)
 try:
  with db:yield db
 finally:db.close()
class Cases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);owner=os.getuid();self.owner=owner
  for name,mode in [('operations.lock',0o600),('admin.lock',0o600),('maintenance.lock',0o664)]:
   p=self.root/name;p.touch();p.chmod(mode)
  triggers=[self.root/'daily',self.root/'git']
  for p in triggers:p.mkdir(mode=0o700)
  self.lease=MaintenanceLease(self.root/'maintenance.lock',owner,triggers)
  self.admin=self.root/'admin.json';self.write(self.admin,{'action':'migrate_two_notice_aliases','attempts':1,'state':'preparation_failed_original_resumed'})
  self.contract=self.root/'activation.json';self.spec={'operation_id':'c'*32,'predecessor_operation_id':'d'*32,'prior_revision':'e'*64,'prior_proof':{}}
  contract={'host':'raspberry','environment':'approved_activation','correction':self.spec};self.write(self.contract,contract,0o644);self.revision=digest(contract)
  self.deployment=self.root/'deployment.sqlite3'
  with connection(self.deployment)as db:
   db.executescript('CREATE TABLE operations(id,revision,phase,reason,mode,created,updated,activation,baseline,snapshot,identity);CREATE TABLE audit(seq,id,phase,reason,at,revision);CREATE TABLE corrections(predecessor,successor,prior_revision,revision,prior_row_sha256,prior_audit_sha256,created);')
   old=(self.spec['predecessor_operation_id'],self.spec['prior_revision'],'held','old_failure','candidate','old','old',None,None,None,None)
   new=(self.spec['operation_id'],self.revision,'verified','guard_verified','candidate','new','new',None,None,None,None)
   db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)',old);db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)',new)
   audit=(1,old[0],'held','old_failure','old',old[1]);db.execute('INSERT INTO audit VALUES(?,?,?,?,?,?)',audit)
   db.row_factory=sqlite3.Row;prior=dict(db.execute('SELECT * FROM operations WHERE id=?',(old[0],)).fetchone())
   db.execute('INSERT INTO corrections VALUES(?,?,?,?,?,?,?)',(old[0],new[0],old[1],self.revision,digest(prior),digest([audit]),'new'))
  self.durable=self.root/'durable.sqlite3'
  with connection(self.durable)as db:db.execute('CREATE TABLE jobs(request,status)');db.execute('INSERT INTO jobs VALUES(?,?)',(json.dumps({'operation':'validate_mcp_python_sources'}),'succeeded'))
  self.durable.chmod(0o660)
  self.components=self.root/'components.sqlite3'
  with connection(self.components)as db:
   db.execute('CREATE TABLE operations(id,component,task,state,base,candidate,result)');db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',(OP,'observacao_host',TASK,'apply_intent','1'*64,'2'*64,None))
  for p in(self.components,self.deployment):p.chmod(0o600)
  self.binding={'operation_id':OP,'component_id':'observacao_host','task_id':TASK,'action':'apply','before_sha256':'1'*64,'after_sha256':'2'*64}
  self.observer=ExecutorObserver(ExistingLock(self.root/'operations.lock',owner,0o600),ExistingLock(self.root/'admin.lock',owner,0o600),self.lease,self.admin,self.deployment,self.contract,self.durable,owner,self.components,owner,lambda:1000)
 def tearDown(self):self.tmp.cleanup()
 def write(self,path,value,mode=0o600):path.write_text(json.dumps(value));path.chmod(mode)
 def mutate(self,path,sql,args=()):
  with connection(path)as db:db.execute(sql,args)
 def observe(self,binding=None):
  with self.observer.locked(),self.lease:return self.observer(binding or self.binding)
 def test_valid_immutable_correction_does_not_rewrite_or_perpetually_block_old_failure(self):
  before=self.deployment.read_bytes();r=self.observe();self.assertTrue(r['global_admin_idle']);self.assertEqual(r['evidence']['existing']['deployment']['historical_rows_resolved_by_verified_link'],1);self.assertEqual(before,self.deployment.read_bytes());self.assertEqual(r['root_verified'],self.owner==0)
  with connection(self.deployment)as db:self.assertEqual(db.execute('SELECT phase FROM operations WHERE id=?',(self.spec['predecessor_operation_id'],)).fetchone()[0],'held')
 def test_missing_or_tampered_correction_is_not_silently_ignored(self):
  self.mutate(self.deployment,"UPDATE audit SET reason='changed'")
  with self.assertRaisesRegex(ValueError,'historical_deployment_correction'):self.observe()
 def test_nonterminal_successor_or_wrong_revision_keeps_historical_reservation(self):
  self.mutate(self.deployment,"UPDATE operations SET phase='held' WHERE id=?",(self.spec['operation_id'],))
  with self.assertRaisesRegex(ValueError,'historical_deployment_correction'):self.observe()
 def test_extra_unrelated_held_deployment_blocks(self):
  self.mutate(self.deployment,'INSERT INTO operations(id,phase)VALUES(?,?)',('f'*32,'held'))
  with self.assertRaisesRegex(ValueError,'deployment_effect_busy'):self.observe()
 def test_queued_running_unknown_and_unreviewed_durable_operations_fail_closed(self):
  for operation,status in [('validate_mcp_python_sources','queued'),('validate_mcp_python_sources','running'),('validate_mcp_python_sources','unknown'),('unreviewed','succeeded'),('deploy_icloud_manual_auth','timed_out')]:
   self.mutate(self.durable,'UPDATE jobs SET request=?,status=?',(json.dumps({'operation':operation}),status))
   with self.assertRaisesRegex(ValueError,'durable_effect'):self.observe()
 def test_legacy_unknown_start_or_rollback_is_not_terminal(self):
  for state in('start_outcome_unknown','stop_intent','rollback_blocked'):
   self.write(self.admin,{'action':'migrate_two_notice_aliases','attempts':1,'state':state})
   with self.assertRaisesRegex(ValueError,'legacy_admin_effect'):self.observe()
 def test_component_unknown_or_cleanup_pending_blocks_other_effects(self):
  self.mutate(self.components,'INSERT INTO operations VALUES(?,?,?,?,?,?,?)',('f'*32,'localizacao_pessoas',TASK,'uncertain','3'*64,'4'*64,None))
  with self.assertRaisesRegex(ValueError,'other_component_effect'):self.observe()
  self.mutate(self.components,'UPDATE operations SET state=?,result=? WHERE id!=?',('verified',json.dumps({'security_cleanup_confirmed':False}),OP))
  with self.assertRaisesRegex(ValueError,'security_cleanup'):self.observe()
 def test_disjoint_verified_or_prepared_scopes_can_remain_reserved(self):
  self.mutate(self.components,'INSERT INTO operations VALUES(?,?,?,?,?,?,?)',('f'*32,'localizacao_pessoas',TASK,'prepared','3'*64,'4'*64,None));self.assertTrue(self.observe()['global_admin_idle'])
  self.mutate(self.components,'UPDATE operations SET state=?,result=? WHERE id!=?',('applied_awaiting_functional_proof',json.dumps({'security_cleanup_confirmed':True}),OP));self.assertTrue(self.observe()['global_admin_idle'])
 def test_own_task_action_and_version_must_match_committed_intent(self):
  for change in({'task_id':'f'*32},{'action':'rollback'},{'after_sha256':'f'*64}):
   with self.assertRaisesRegex(ValueError,'component_'):self.observe({**self.binding,**change})
 def test_read_without_actual_exclusion_and_missing_journal_never_proves_idle(self):
  with self.assertRaisesRegex(ValueError,'lock_not_held'):self.observer(self.binding)
  self.components.unlink()
  with self.assertRaises(FileNotFoundError):self.observe()
 def test_replaced_lock_and_competing_process_are_detected(self):
  second=ExistingLock(self.root/'operations.lock',self.owner,0o600)
  with self.observer.locked(),self.lease:
   with self.assertRaisesRegex(ValueError,'registered_executor_busy'):
    with second:pass
   (self.root/'operations.lock').rename(self.root/'old.lock');(self.root/'operations.lock').touch();(self.root/'operations.lock').chmod(0o600)
   with self.assertRaisesRegex(ValueError,'identity_changed'):self.observer(self.binding)
 def test_same_component_reservation_and_missing_terminal_proof_block(self):
  self.mutate(self.components,'INSERT INTO operations VALUES(?,?,?,?,?,?,?)',('f'*32,'observacao_host',TASK,'prepared','3'*64,'4'*64,None))
  with self.assertRaisesRegex(ValueError,'other_component_effect'):self.observe()
  self.mutate(self.components,'UPDATE operations SET component=?,state=? WHERE id!=?',('localizacao_pessoas','verified',OP))
  with self.assertRaisesRegex(ValueError,'terminal_proof_missing'):self.observe()
if __name__=='__main__':unittest.main()
