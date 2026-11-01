"""Preparation only. Parent executes serially, no native services or credentials."""
import ast,contextlib,copy,hashlib,json,os,sqlite3,sys,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).absolute().parent;sys.path.insert(0,str(HERE))
from component_jobs import JobLedger,digest
from root_coordinator import RootCoordinator
from workflow import Workflow
from reciprocal_gate import ReciprocalGuard
from canonical_worker import CanonicalWorker
OP='a'*32;TASK='b'*32;PRINCIPAL='c'*64;BASE='d'*64;CANDIDATE='e'*64
class Cases(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.now=1000;self.clock=lambda:self.now
  self.jobs=JobLedger(self.root/'jobs.sqlite3',owner=os.getuid(),clock=self.clock,initialize=True)
  self.flow=Workflow(self.root/'workflow.sqlite3',self.clock,10000);self.flow.prepare(OP,'observacao_host',TASK,BASE,CANDIDATE,{TASK});self.flow.validate(OP,lambda r:{'base_sha256':BASE,'candidate_sha256':CANDIDATE,'isolated_tests_passed':True,'no_household_effects':True,'reviewed_scope':True})
  self.review={'schema_version':1,'operation_id':OP,'task_id':TASK,'principal_sha256':PRINCIPAL,'component_id':'observacao_host','send_id':'f'*32,'before_sha256':BASE,'after_sha256':CANDIDATE,'before_file_sha256':'0'*64,'after_file_sha256':'1'*64,'source_set_sha256':'2'*64,'validation_profile_sha256':'3'*64,'validation_sha256':'4'*64,'approved_at':900,'expires_at':10000}
  self.jobs.register_review(self.review,'5'*64);self.launched=[];self.effects=0;self.loaded=BASE;self.receipt=None
  self.binding={'operation_id':OP,'task_id':TASK,'principal_sha256':PRINCIPAL,'component_id':'observacao_host','before_sha256':BASE,'after_sha256':CANDIDATE,'action':'apply'}
  self.worker=types.SimpleNamespace(run=self.effect,previous=lambda b:self.receipt)
  self.coord=RootCoordinator(self.flow,self.jobs,types.SimpleNamespace(read=lambda b,p:self.review),self.worker,lambda r:{'loaded_sha256':self.loaded,'collection_error':None,'backup_verified':True},lambda r:{},self.launch,PRINCIPAL,10000,lambda:None,self.clock)
 def tearDown(self):self.flow.close();self.jobs.close();self.temp.cleanup()
 def launch(self,op,action):self.launched.append((op,action));return True
 def effect(self,op,action):
  self.effects+=1;self.loaded=CANDIDATE if action=='apply'else BASE
  self.receipt={**self.binding,'action':action,'state':'applied','loaded_sha256':self.loaded,'executor_terminal':True,'receipt_verified':True,'security_cleanup_confirmed':True,'worker_finished_at':self.now,'automatic_retry':False};return self.receipt
 def test_every_prepared_Python_module_has_valid_syntax(self):
  for path in HERE.glob('*.py'):ast.parse(path.read_bytes(),filename=str(path))
 def test_submit_is_durable_and_worker_effect_once(self):
  result=self.coord.submit(OP,'apply',BASE);self.assertEqual(self.effects,0);self.assertEqual(result['jobs'][0]['state'],'launch_intent')
  result=self.coord.run_once(OP,'apply');self.assertEqual(result['state'],'applied_awaiting_functional_proof');self.assertEqual(self.effects,1)
  self.assertTrue(self.coord.run_once(OP,'apply')['duplicate']);self.assertTrue(self.coord.submit(OP,'apply',BASE)['duplicate']);self.assertEqual(len(self.launched),1);self.assertEqual(self.effects,1)
 def test_lost_launch_response_never_restarts_but_original_service_can_claim_once(self):
  def lost(*args):self.launched.append(args);raise RuntimeError('synthetic-lost-response')
  self.coord.launch=lost;self.coord.submit(OP,'apply',BASE);self.assertEqual(self.jobs.get(OP,'apply')['state'],'uncertain')
  self.coord.submit(OP,'apply',BASE);self.assertEqual(len(self.launched),1);self.coord.run_once(OP,'apply');self.assertEqual(self.effects,1)
 def test_worker_crash_or_uncertainty_is_never_claimed_again(self):
  self.coord.submit(OP,'apply',BASE)
  self.jobs.transition(OP,'apply','launch_intent','running');self.jobs.transition(OP,'apply','running','uncertain',{'reason':'worker_or_admission_outcome_unconfirmed','automatic_retry':False})
  self.assertTrue(self.coord.run_once(OP,'apply')['duplicate']);self.assertEqual(self.effects,0)
 def test_job_binding_conflict_and_readonly_ledger(self):
  self.jobs.enqueue(self.binding)
  bad={**self.binding,'after_sha256':'9'*64}
  with self.assertRaisesRegex(ValueError,'id_conflict'):self.jobs.enqueue(bad)
  view=JobLedger(self.root/'jobs.sqlite3',owner=os.getuid(),clock=self.clock,read_only=True)
  try:
   self.assertEqual(len(view.pending_jobs()),1)
   with self.assertRaisesRegex(ValueError,'readonly_component_ledger'):view.enqueue({**self.binding,'action':'rollback'})
  finally:view.close()
 def test_cleanup_uncertain_survives_later_good_observation(self):
  bad={'source':'protected_NodeRED_read_session','component_id':'observacao_host','operation_id':OP,'nonce':'1'*32,'state':'unknown','collection_error':'read_session_revocation_unconfirmed','observed_at':1000,'loaded_sha256':None,'identity_kind':'nodered_scoped_configuration_v1','session_revoked':False,'functional_health':'unknown','automatic_retry':False}
  self.jobs.record_observation(self.binding,bad)
  good={**bad,'nonce':'2'*32,'state':'observed','collection_error':None,'loaded_sha256':BASE,'session_revoked':True};self.jobs.record_observation(self.binding,good)
  self.assertTrue(self.jobs.observation_cleanup_pending())
  with self.assertRaisesRegex(ValueError,'cleanup_pending'):self.jobs.enqueue(self.binding)
 def test_fresh_read_must_match_operation_nonce_and_age(self):
  proof={'source':'protected_NodeRED_read_session','component_id':'observacao_host','operation_id':OP,'nonce':'3'*32,'state':'observed','collection_error':None,'observed_at':1000,'loaded_sha256':BASE,'identity_kind':'nodered_scoped_configuration_v1','session_revoked':True,'functional_health':'unknown','automatic_retry':False}
  self.jobs.record_observation(self.binding,proof);self.assertEqual(self.jobs.latest_observation(self.binding)['loaded_sha256'],BASE);self.now+=61
  with self.assertRaisesRegex(ValueError,'stale'):self.jobs.latest_observation(self.binding)
 def test_reciprocal_gate_blocks_launch_unknown_and_held_component(self):
  gate=ReciprocalGuard(self.root/'workflow.sqlite3',types.SimpleNamespace(check=lambda:True),owner=os.getuid(),clock=self.clock)
  with self.assertRaisesRegex(ValueError,'scope_reserved'):gate.check('NodeRED_reader_binding')
  self.jobs.enqueue(self.binding)
  with self.assertRaisesRegex(ValueError,'launch_or_effect_unknown'):gate.check('legacy_codex_send')
  self.assertTrue(gate.check('NodeRED_reader_binding',OP)['admission_allowed'])
 def test_unsupported_component_never_starts_or_mutates(self):
  op='8'*32;self.flow.prepare(op,'icloud_adapter',TASK,BASE,CANDIDATE,{TASK})
  with self.assertRaisesRegex(ValueError,'not_activated'):self.coord.submit(op,'apply',BASE)
  self.assertEqual(self.effects,0);self.assertFalse(self.launched)
 def test_validation_or_client_booleans_do_not_grant_effect(self):
  with self.assertRaisesRegex(ValueError,'closed_component_request'):self.coord.dispatch('component_apply_repair',{'host':'raspberry','operation_id':OP,'expected_loaded_sha256':BASE,'global_admin_idle':True})
  self.assertEqual(self.effects,0)
 def test_status_and_reconcile_never_launch_or_repeat(self):
  self.coord.submit(OP,'apply',BASE);self.coord.run_once(OP,'apply');count=self.effects
  for _ in range(3):self.coord.status(OP);self.coord.reconcile(OP)
  self.assertEqual(self.effects,count);self.assertEqual(len(self.launched),1)
 def test_validation_queue_is_separate_and_never_runs_native_worker(self):
  b={k:v for k,v in self.binding.items()if k!='action'};self.jobs.register_preparation(b,'9'*64,10000)
  self.coord.validator=lambda op:{'operation_id':op,'state':'validation_passed_awaiting_root_review','protected_receipt_sha256':'7'*64,'household_effects':0,'executor_terminal':True}
  self.coord.queue_validation(OP);self.assertEqual(self.jobs.get(OP,'validate')['state'],'launch_intent')
  self.coord.run_validation(OP);self.assertEqual(self.jobs.get(OP,'validate')['state'],'terminal');self.assertEqual(self.effects,0);self.assertEqual(self.flow.row(OP)['state'],'validated')
  self.coord.run_validation(OP);self.assertEqual(len(self.launched),1)
 def test_task_cli_manifest_rejects_prompt_privilege_boolean(self):
  from task_adapter import TaskAdapter,STATE
  from unittest.mock import patch
  r={'schema_version':1,'operation_id':OP,'task_id':TASK,'send_id':'f'*32,'component_id':'observacao_host','proposal_id':'6'*32,'root_decision_id':'7'*32,'expected_loaded_sha256':BASE,'expires_at':10000,'approval_reference_sha256':'8'*64}
  profile={'approval_reference_sha256':'8'*64,'owner_authorization_expires_at':10000}
  factory=types.SimpleNamespace(policy={'expires_at':10000},verified={str(STATE/'profiles/observacao_host.json'):json.dumps(profile).encode()})
  adapter=TaskAdapter(factory)
  with patch('task_adapter.read_json',return_value=r):self.assertEqual(adapter.request(OP)['task_id'],TASK)
  with patch('task_adapter.read_json',return_value={**r,'root_authorized':True}):
   with self.assertRaisesRegex(ValueError,'closed_task_request_shape'):adapter.request(OP)
  with self.assertRaisesRegex(ValueError,'invalid_bound_identity'):adapter.request('../arbitrary-path')
 def test_task_phase_request_CAS_never_repeats_launch(self):
  self.assertTrue(self.jobs.begin_phase(OP,'prepare','6'*64));self.assertFalse(self.jobs.begin_phase(OP,'prepare','6'*64))
  with self.assertRaisesRegex(ValueError,'request_changed'):self.jobs.begin_phase(OP,'prepare','7'*64)
  self.jobs.phase_transition(OP,'prepare','launch_intent','running');self.jobs.phase_transition(OP,'prepare','running','uncertain',{'reason':'task_phase_outcome_unconfirmed','automatic_retry':False})
  self.assertFalse(self.jobs.begin_phase(OP,'prepare','6'*64));self.assertEqual(self.jobs.phase(OP,'prepare')['state'],'uncertain')
 def test_source_native_mismatch_retains_uncertainty(self):
  parent=types.SimpleNamespace(before_effect=None)
  source={'source_consistency_confirmed':True,'source_before_sha256':BASE,'source_after_sha256':CANDIDATE,'actual_source_sha256':CANDIDATE,'state':'terminal','canonical_source_effect':True,'own_rollback_confirmed':False,'automatic_retry':False}
  wrapper=CanonicalWorker(parent,types.SimpleNamespace(status=lambda *a:source))
  native={**self.binding,'state':'rejected_without_effect','definitive_no_effect':True,'executor_terminal':True,'receipt_verified':True,'security_cleanup_confirmed':True}
  self.assertEqual(wrapper.compose(self.binding,native)['state'],'uncertain')
  source.update(actual_source_sha256=BASE,own_rollback_confirmed=True)
  self.assertTrue(wrapper.compose(self.binding,native)['canonical_source_own_rollback_confirmed'])
if __name__=='__main__':unittest.main()
