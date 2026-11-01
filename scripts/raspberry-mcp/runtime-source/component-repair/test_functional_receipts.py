"""Prepared synthetic integration checks; parent executes serially.
No native network/API, credential, Root install or service operations.
"""
import contextlib,hashlib,importlib.util,json,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import Mock,patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import functional as f
import source_writer as s
def raw(v):return(json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
class FunctionalTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.folder=Path(self.tmp.name);self.op='a'*32;self.task='b'*32;self.candidate='c'*64;self.base='d'*64
  self.before={'source':'isolated_exact_loaded_candidate_reset_probe','passed':False,'status_callbacks':1,'external_effects':0,'production_context_writes':0,'observed_at':10}
  self.validation={'functional_regression':{'baseline':self.before},'after_sha256':self.candidate,'checks':{k:'passed'for k in('source_consistency','pure_function_regression','dry_run_regression','unchanged_scope')}}
  self.code='return null;';self.after={'function_sha256':hashlib.sha256(self.code.encode()).hexdigest(),'observed_at':20}
  self.files={'validator-result.json':self.validation,'preparation.json':{'binding':{'operation_id':self.op,'task_id':self.task,'principal_sha256':'e'*64,'component_id':'observacao_host','action':'observe'}},'after.json':[{'id':'host_obs_test_build','func':self.code}]}
  self.writer=Mock();self.writer.bundle.return_value=(self.folder,None,None,None);self.writer.status.return_value={'state':'terminal','source_consistency_confirmed':True}
  self.admission=Mock();self.admission.locked.side_effect=lambda binding:contextlib.nullcontext(lambda:None)
  self.port=f.HostResetFunctional({},self.writer,Mock(),self.admission,self.folder,clock=lambda:30)
  # Proof-selection validation has its own fixture suite. These tests exercise
  # the functional consumer using an already-selected synthetic proof folder.
  self.port._validated=Mock(return_value=self.folder)
  self.port._actual=Mock(return_value={'loaded_sha256':self.candidate});self.port._isolated_after=Mock(return_value=self.after)
  self.reader=patch.object(f,'read',side_effect=lambda path,*a,**kw:raw(self.files[Path(path).name]));self.reader.start()
  self.row={'id':self.op,'task':self.task,'component':'observacao_host','base':self.base,'candidate':self.candidate}
 def tearDown(self):self.reader.stop();self.tmp.cleanup()
 def test_accepted_receipt_has_specific_coverage_not_full_native_health(self):
  p=self.port(self.row);self.assertTrue(p['same_operation_before_failed']);self.assertTrue(p['same_operation_after_passed']);self.assertFalse(p['native_full_flow_replay']);self.assertEqual(p['physical_health'],'unknown');self.assertEqual(self.port._actual.call_count,2)
 def test_no_baseline_failure_cannot_be_labeled_a_fix(self):
  self.validation.pop('functional_regression')
  with self.assertRaisesRegex(ValueError,'before_failure'):self.port(self.row)
  self.port._isolated_after.assert_not_called()
 def test_source_uncertainty_prevents_probe(self):
  self.writer.status.return_value={'state':'uncertain','source_consistency_confirmed':False}
  with self.assertRaisesRegex(ValueError,'canonical_source'):self.port(self.row)
  self.port._actual.assert_not_called()
 def test_changed_canonical_source_after_probe_refuses_acceptance(self):
  self.writer.status.side_effect=[{'state':'terminal','source_consistency_confirmed':True},{'state':'uncertain','source_consistency_confirmed':False}]
  with self.assertRaisesRegex(ValueError,'canonical_source_changed'):self.port(self.row)
 def test_wrong_function_hash_cannot_satisfy_candidate_identity(self):
  self.after['function_sha256']='f'*64
  with self.assertRaisesRegex(ValueError,'actual_function_mismatch'):self.port(self.row)
 def test_time_reversal_refuses_functional_receipt(self):
  self.after['observed_at']=5
  with self.assertRaisesRegex(ValueError,'source_or_time'):self.port(self.row)
 def test_other_components_have_no_implicit_functional_port(self):
  self.row['component']='icloud_adapter'
  with self.assertRaisesRegex(ValueError,'component_not_implemented'):self.port(self.row)
 def test_existing_probe_intent_is_not_retried(self):
  (self.folder/'functional-after-intent.json').write_text('{}')
  with self.assertRaisesRegex(ValueError,'inspect_no_retry'):
   f.HostResetFunctional({},self.writer,Mock(),self.admission,self.folder)._isolated_after(self.op,self.folder,lambda:None)
if __name__=='__main__':unittest.main()
