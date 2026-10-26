import tempfile,unittest,os
from pathlib import Path
from workflow import Workflow
A='a'*32;B='b'*32;C='c'*32;TASK='1'*32;BASE='2'*64;AFTER='3'*64
class Cases(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.now=100;self.path=Path(self.t.name)/'state.sqlite3';self.w=Workflow(self.path,lambda:self.now,1000);self.calls=0
 def tearDown(self):self.w.close();self.t.cleanup()
 def prepare(self,op=A,component='localizacao_pessoas'):return self.w.prepare(op,component,TASK,BASE,AFTER,{TASK})
 def validate(self,op=A):return self.w.validate(op,lambda r:{'base_sha256':BASE,'candidate_sha256':AFTER,'isolated_tests_passed':True,'no_household_effects':True,'reviewed_scope':True})
 def observe(self,r):return {'loaded_sha256':BASE,'collection_error':None}
 def receipt(self,op=A,action='apply',**values):
  r=self.w.row(op);return {'operation_id':op,'component_id':r['component'],'task_id':r['task'],'action':action,'receipt_verified':True,'executor_terminal':True,'security_cleanup_confirmed':True,'worker_finished_at':self.now,**values}
 def effect(self,r):
  self.calls+=1;check=Workflow(self.path,lambda:self.now,1000)
  try:self.assertEqual(check.row(r['id'])['state'],'apply_intent')
  finally:check.close()
  return self.receipt(r['id'],loaded_sha256=AFTER)
 def execute(self,op,observe,effect,**kwargs):return self.w.apply(op,observe,effect,**{'global_admin_idle':True,'resources_available':True,**kwargs})
 def rollback(self,op,observe,effect,**kwargs):return self.w.rollback(op,observe,effect,**{'global_admin_idle':True,**kwargs})
 def apply(self,op=A):return self.execute(op,self.observe,self.effect)
 def functional(self,r):return {'loaded_sha256':AFTER,'collection_error':None,'same_operation_before_failed':True,'same_operation_after_passed':True,'regressions_checked':True,'no_household_test_effects':True,'operation_id':r['id'],'component_id':r['component'],'task_id':r['task'],'observed_at':self.now,'before_failed_at':self.now-1,'after_success_at':self.now}
 def test_two_independent_preparations_and_same_component_conflict(self):
  self.prepare();self.prepare(B,'external_heartbeat')
  with self.assertRaisesRegex(ValueError,'component_reserved'):self.prepare(C)
 def test_preparation_capacity_and_registered_identity(self):
  self.prepare();self.prepare(B,'external_heartbeat')
  with self.assertRaisesRegex(ValueError,'preparation_capacity'):self.prepare(C,'icloud_adapter')
  with self.assertRaisesRegex(ValueError,'task_not_registered'):self.w.prepare(C,'icloud_adapter','9'*32,BASE,AFTER,{TASK})
 def test_idempotent_preparation_and_conflicting_ID(self):
  self.prepare();self.assertTrue(self.prepare()['duplicate'])
  with self.assertRaisesRegex(ValueError,'operation_id_conflict'):self.prepare(A,'external_heartbeat')
 def test_durable_intent_before_effect_and_no_apply_repeat(self):
  self.prepare();self.validate();self.apply();self.apply();self.assertEqual(self.calls,1);self.assertEqual(self.w.row(A)['state'],'applied_awaiting_functional_proof')
 def test_disjoint_node_flows_can_apply_serially_while_functional_proof_is_pending(self):
  self.prepare();self.prepare(B,'observacao_host');self.validate();self.validate(B);self.apply()
  self.apply(B);self.assertEqual(self.calls,2);self.assertEqual(self.w.status(A)['state'],'applied_awaiting_functional_proof')
 def test_response_loss_reconcile_without_repeating_execution(self):
  self.prepare();self.validate()
  def uncertain(r):self.calls+=1;raise TimeoutError()
  self.execute(A,self.observe,uncertain);self.assertEqual(self.w.status(A)['state'],'uncertain');self.apply();self.assertEqual(self.calls,1)
  self.w.reconcile(A,lambda r:self.receipt(loaded_sha256=AFTER,collection_error=None));self.assertEqual(self.w.status(A)['state'],'applied_awaiting_functional_proof');self.assertEqual(self.calls,1)
 def test_desired_version_without_exact_terminal_executor_does_not_release(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None)
  for extra in [{},{'executor_terminal':True,'operation_id':B},{'executor_terminal':False,'operation_id':A}]:
   self.w.reconcile(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,**extra});self.assertEqual(self.w.status(A)['state'],'uncertain')
 def test_before_version_does_not_prove_no_dispatch(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None);self.w.reconcile(A,self.observe);self.assertEqual(self.w.status(A)['state'],'uncertain')
  with self.assertRaisesRegex(ValueError,'cannot_release'):self.w.release(A,self.w.status(A)['result_hash'])
  self.w.reconcile(A,lambda r:self.receipt(loaded_sha256=BASE,collection_error=None,definitive_no_dispatch=True));self.assertEqual(self.w.status(A)['state'],'confirmed_not_applied');self.apply();self.assertEqual(self.calls,0)
 def test_expiry_and_observation_failure_do_not_release_uncertainty(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None);self.now=2000;self.assertFalse(self.w.status(A)['administrative_admission_active']);self.w.reconcile(A,lambda r:{'collection_error':'unavailable'});self.assertTrue(self.w.status(A)['reservation_retained'])
  with self.assertRaisesRegex(ValueError,'lease_expired'):self.prepare(B,'external_heartbeat')
 def test_unknown_loaded_version_never_executes(self):
  self.prepare();self.validate()
  with self.assertRaisesRegex(ValueError,'loaded_version'):self.execute(A,lambda r:{'collection_error':'not_loaded'},self.effect)
  self.assertEqual(self.calls,0)
 def test_full_admin_busy_and_low_resources_block(self):
  self.prepare();self.validate()
  for kwargs in [{'global_admin_idle':False},{'resources_available':False}]:
   with self.assertRaises(ValueError):self.execute(A,self.observe,self.effect,**kwargs)
  self.assertEqual(self.calls,0)
 def test_container_health_or_notification_disappearance_not_functional_proof(self):
  self.prepare();self.validate();self.apply()
  with self.assertRaisesRegex(ValueError,'functional_proof_incomplete'):self.w.verify(A,lambda r:{'container_healthy':True,'notification_gone':True,'collection_error':None})
  self.w.verify(A,self.functional);result=self.w.status(A)['result_hash'];self.w.release(A,result);self.assertFalse(self.w.status(A)['reservation_retained']);self.assertTrue(self.w.release(A,result)['duplicate']);self.assertGreaterEqual(self.w.db.execute('SELECT count(*)FROM receipts').fetchone()[0],4)
 def test_functional_evidence_identity_and_dates_missing_or_conflicting(self):
  self.prepare();self.validate();self.apply()
  for changes in [{'operation_id':B},{'component_id':'external_heartbeat'},{'observed_at':None},{'observed_at':self.now+1},{'observed_at':self.now-61},{'after_success_at':self.now-10},{'before_failed_at':self.now+1}]:
   with self.assertRaisesRegex(ValueError,'functional_evidence'):self.w.verify(A,lambda r:{**self.functional(r),**changes})
 def test_success_response_without_executor_terminal_is_uncertain(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:{'loaded_sha256':AFTER,'receipt_verified':True});self.assertEqual(self.w.status(A)['state'],'uncertain')
 def test_heartbeat_requires_destination_receipt(self):
  self.prepare(component='external_heartbeat');self.validate();self.apply()
  with self.assertRaisesRegex(ValueError,'destination_not_proven'):self.w.verify(A,self.functional)
  self.w.verify(A,lambda r:{**self.functional(r),'destination_receipt_verified':True});self.assertEqual(self.w.status(A)['state'],'verified')
 def test_cancel_only_before_effect(self):
  self.prepare();self.w.cancel(A);self.w.release(A,self.w.status(A)['result_hash']);self.assertFalse(self.w.status(A)['reservation_retained'])
  self.prepare(B,'external_heartbeat');self.validate(B);self.apply(B)
  with self.assertRaisesRegex(ValueError,'cannot_cancel'):self.w.cancel(B)
 def test_rollback_version_receipt_and_no_automatic_repeat(self):
  self.prepare();self.validate();self.apply();calls=[]
  def undo(r):calls.append(1);return self.receipt(r['id'],action='rollback',loaded_sha256=BASE)
  self.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},undo);self.rollback(A,self.observe,undo);self.assertEqual(len(calls),1);self.assertEqual(self.w.status(A)['state'],'rolled_back')
 def test_uncertain_effect_blocks_new_writes_but_not_independent_preparation(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None);self.prepare(B,'external_heartbeat');self.validate(B)
  with self.assertRaisesRegex(ValueError,'global_effect_in_flight_or_unknown'):self.apply(B)
 def test_rollback_response_loss_reconciles_without_repetition(self):
  self.prepare();self.validate();self.apply();calls=[]
  def lost(r):calls.append(1);raise TimeoutError()
  self.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},lost);self.w.reconcile(A,lambda r:{'loaded_sha256':BASE,'collection_error':None});self.assertEqual(self.w.status(A)['state'],'rollback_uncertain');self.w.reconcile(A,lambda r:self.receipt(action='rollback',loaded_sha256=BASE,collection_error=None));self.assertEqual(self.w.status(A)['state'],'rolled_back');self.rollback(A,self.observe,lost);self.assertEqual(len(calls),1)
 def test_missing_coordination_and_resources_fail_closed(self):
  self.prepare();self.validate()
  with self.assertRaisesRegex(ValueError,'full_admin_operation'):self.w.apply(A,self.observe,self.effect)
  with self.assertRaisesRegex(ValueError,'host_resources'):self.w.apply(A,self.observe,self.effect,global_admin_idle=True)
  for flag in ['unknown',1,None]:
   with self.assertRaisesRegex(ValueError,'full_admin_operation'):self.w.apply(A,self.observe,self.effect,global_admin_idle=flag,resources_available=True)
  self.assertEqual(self.calls,0)
 def test_reconciliation_needs_exact_receipt_not_only_hash_and_terminal_state(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None)
  for receipt in [None,False]:
   self.w.reconcile(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'executor_terminal':True,'operation_id':A,'receipt_verified':receipt})
   self.assertEqual(self.w.status(A)['state'],'uncertain')
  self.w.reconcile(A,lambda r:{'loaded_sha256':BASE,'collection_error':None,'executor_terminal':True,'operation_id':A,'definitive_no_dispatch':True})
  self.assertEqual(self.w.status(A)['state'],'uncertain')
 def test_nonfinite_and_negative_failure_dates_never_verify(self):
  self.prepare();self.validate();self.apply()
  for timestamp in [float('nan'),float('-inf'),float('inf'),-1]:
   with self.assertRaisesRegex(ValueError,'functional_evidence'):self.w.verify(A,lambda r:{**self.functional(r),'before_failed_at':timestamp})
 def test_rollback_without_coordination_observation_never_executes(self):
  self.prepare();self.validate();self.apply()
  with self.assertRaisesRegex(ValueError,'full_admin_operation'):self.w.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},self.effect)
  self.assertEqual(self.calls,1)
 def test_terminal_no_effect_receipt_does_not_become_uncertain_or_repeated(self):
  self.prepare();self.validate();calls=[]
  def rejected(r):calls.append(1);return self.receipt(definitive_no_effect=True)
  self.execute(A,self.observe,rejected);self.assertEqual(self.w.status(A)['state'],'failed_without_effect');self.execute(A,self.observe,rejected);self.assertEqual(len(calls),1)
  self.w.release(A,self.w.status(A)['result_hash']);self.assertFalse(self.w.status(A)['reservation_retained'])
 def test_wrong_task_component_action_or_finished_time_cannot_confirm_execution(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None)
  for changes in [{'task_id':'9'*32},{'component_id':'external_heartbeat'},{'action':'rollback'},{'worker_finished_at':None},{'worker_finished_at':self.now+2}]:
   self.w.reconcile(A,lambda r:self.receipt(loaded_sha256=AFTER,collection_error=None,**changes));self.assertEqual(self.w.status(A)['state'],'uncertain')
 def test_session_cleanup_pending_blocks_verification_release_and_other_effects(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:self.receipt(loaded_sha256=AFTER,security_cleanup_confirmed=False))
  self.assertFalse(self.w.status(A)['result']['security_cleanup_confirmed'])
  with self.assertRaisesRegex(ValueError,'security_cleanup'):self.w.verify(A,self.functional)
  self.prepare(B,'external_heartbeat');self.validate(B)
  with self.assertRaisesRegex(ValueError,'security_cleanup'):self.apply(B)
  self.w.reconcile(A,lambda r:self.receipt(loaded_sha256=AFTER,collection_error=None,security_cleanup_confirmed=True))
  self.w.verify(A,self.functional);self.assertEqual(self.w.status(A)['state'],'verified')
 def test_functional_success_before_actual_apply_completion_is_not_accepted(self):
  self.prepare();self.validate();self.now=110;self.apply();self.now=120
  with self.assertRaisesRegex(ValueError,'functional_evidence_time'):self.w.verify(A,lambda r:{**self.functional(r),'after_success_at':105,'before_failed_at':99})
 def test_refused_rollback_never_repeats_and_does_not_claim_reversion(self):
  self.prepare();self.validate();self.apply();calls=[]
  def refused(r):calls.append(1);return self.receipt(action='rollback',definitive_no_effect=True)
  self.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},refused)
  self.assertEqual(self.w.status(A)['state'],'rollback_rejected_without_effect');self.assertTrue(self.w.status(A)['reservation_retained'])
  self.rollback(A,self.observe,refused);self.assertEqual(len(calls),1);self.w.verify(A,self.functional);self.assertEqual(self.w.status(A)['state'],'verified')
 def test_rollback_cleanup_does_not_erase_pending_apply_session(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:self.receipt(loaded_sha256=AFTER,security_cleanup_confirmed=False))
  self.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},lambda r:self.receipt(action='rollback',loaded_sha256=BASE))
  self.assertEqual(self.w.status(A)['state'],'rolled_back');self.assertFalse(self.w.status(A)['result']['security_cleanup_confirmed'])
  with self.assertRaisesRegex(ValueError,'security_cleanup'):self.w.release(A,self.w.status(A)['result_hash'])
 def test_symlink_and_unsafe_database_rejected(self):
  link=Path(self.t.name)/'link';link.symlink_to(self.path)
  with self.assertRaisesRegex(ValueError,'unsafe_state_database'):Workflow(link,lambda:100,1000)
  self.path.chmod(0o666)
  with self.assertRaisesRegex(ValueError,'unsafe_state_database'):Workflow(self.path,lambda:100,1000)
  self.path.chmod(0o600)

 def test_lost_rejection_receipt_reconciles_reason_without_repeating_effect(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None)
  bad=self.receipt(definitive_no_effect=True,collection_error='revision_conflict',task_id='f'*32)
  self.w.reconcile(A,lambda r:bad);self.assertEqual(self.w.status(A)['state'],'uncertain')
  proof=self.receipt(definitive_no_effect=True,collection_error='revision_conflict')
  self.w.reconcile(A,lambda r:proof);self.assertEqual(self.w.status(A)['state'],'failed_without_effect')
  self.apply();self.assertEqual(self.calls,0);self.w.release(A,self.w.status(A)['result_hash'])
 def test_lost_rollback_rejection_reconciles_original_worker_receipt(self):
  self.prepare();self.validate();self.apply()
  self.rollback(A,lambda r:{'loaded_sha256':AFTER,'collection_error':None,'backup_verified':True},lambda r:None)
  proof=self.receipt(action='rollback',definitive_no_effect=True,collection_error='revision_conflict')
  self.w.reconcile(A,lambda r:proof);self.assertEqual(self.w.status(A)['state'],'rollback_rejected_without_effect')
  self.assertTrue(self.w.status(A)['reservation_retained'])
 def test_collector_error_or_nonterminal_receipt_never_resolves_uncertainty(self):
  self.prepare();self.validate();self.execute(A,self.observe,lambda r:None)
  for proof in [self.receipt(loaded_sha256=AFTER,collection_error='unavailable'),self.receipt(definitive_no_effect=True,executor_terminal=False,collection_error='revision_conflict')]:
   self.w.reconcile(A,lambda r:proof);self.assertEqual(self.w.status(A)['state'],'uncertain')

 def test_natural_load_confirmation_uses_write_time_not_later_receipt_time(self):
  self.prepare();self.validate();self.now=110
  self.execute(A,self.observe,lambda r:self.receipt(loaded_sha256=AFTER,effect_applied_at=101))
  self.assertEqual(self.w.status(A)['result']['applied_at'],101)
  proof={**self.functional(self.w.row(A)),'before_failed_at':100,'after_success_at':105};self.w.verify(A,lambda r:proof);self.assertEqual(self.w.status(A)['state'],'verified')
 def test_inconsistent_effect_time_cannot_confirm_apply(self):
  self.prepare();self.validate();self.now=110
  self.execute(A,self.observe,lambda r:self.receipt(loaded_sha256=AFTER,effect_applied_at=111));self.assertEqual(self.w.status(A)['state'],'uncertain')
if __name__=='__main__':unittest.main()
