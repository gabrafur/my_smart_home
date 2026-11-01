"""Portable proof-selection contracts; no native Root paths or execution."""
import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import preparer as p
class SelectionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.op='a'*32;self.attempt='b'*32
  self.folder=self.root/'sealed'/self.op;self.folder.mkdir(parents=True)
  self.trial=self.folder/'validation-attempts'/self.attempt;self.trial.mkdir(parents=True)
  self.write(self.folder/'validation-phase-result.json',{'state':'historical_failure'})
  self.profile={'validation_compatibility':{'operation_id':self.op,'previous_validation_phase_sha256':p.sha((self.folder/'validation-phase-result.json').read_bytes())}}
  digest=p.sha(p.raw(self.profile));self.write(self.trial/'validator-result.json',{'checks':'synthetic'})
  self.write(self.trial/'validator-intent.json',{'profile_sha256':digest})
  self.write(self.trial/'validator-native-receipt.json',{'unit_terminal':True,'returncode':0})
  self.write(self.trial/'validation-phase-result.json',{'operation_id':self.op,'state':'validation_passed_awaiting_root_review','validation_profile_sha256':digest,'protected_receipt_sha256':p.sha((self.trial/'validator-result.json').read_bytes())})
  self.selection={'kind':'root_selected_actual_validation','operation_id':self.op,'attempt_id':self.attempt,'profile_sha256':digest,'previous_phase_sha256':self.profile['validation_compatibility']['previous_validation_phase_sha256'],'selected_at':1}
  for field,name in [('proof_sha256','validator-result.json'),('native_receipt_sha256','validator-native-receipt.json'),('intent_sha256','validator-intent.json'),('phase_sha256','validation-phase-result.json')]:self.selection[field]=p.sha((self.trial/name).read_bytes())
  self.write(self.folder/'validation-selection.json',self.selection)
  # File ownership is verified by protected-file tests. This suite keeps real
  # bytes/hashes while substituting only the native ownership boundary.
  self.directory=patch.object(p,'protected_dir',side_effect=Path);self.reader=patch.object(p,'read',side_effect=lambda path,*a,**kw:Path(path).read_bytes());self.directory.start();self.reader.start()
 def tearDown(self):self.reader.stop();self.directory.stop();self.tmp.cleanup()
 def write(self,path,value):path.write_bytes(p.raw(value))
 def resolve(self):return p.accepted_validation_folder(self.profile,self.root,self.op)
 def test_selected_success_preserves_old_failure(self):
  old=(self.folder/'validation-phase-result.json').read_bytes();self.assertEqual(self.resolve(),self.trial);self.assertEqual((self.folder/'validation-phase-result.json').read_bytes(),old)
 def test_current_operation_without_selector_uses_own_folder(self):
  (self.folder/'validation-selection.json').unlink();self.profile={};self.assertEqual(self.resolve(),self.folder)
 def test_historical_profile_requires_explicit_selection(self):
  (self.folder/'validation-selection.json').unlink()
  with self.assertRaisesRegex(ValueError,'root_selected_validation_required'):self.resolve()
 def test_modified_proof_is_rejected(self):
  self.write(self.trial/'validator-result.json',{'changed':True})
  with self.assertRaisesRegex(ValueError,'artifact_changed'):self.resolve()
 def test_modified_old_failure_is_rejected(self):
  self.write(self.folder/'validation-phase-result.json',{'state':'changed'})
  with self.assertRaisesRegex(ValueError,'history_changed'):self.resolve()
 def test_wrong_operation_is_rejected(self):
  self.selection['operation_id']='c'*32;self.write(self.folder/'validation-selection.json',self.selection)
  with self.assertRaisesRegex(ValueError,'selection_shape'):self.resolve()
 def test_failed_native_result_is_rejected_even_with_updated_hash(self):
  self.write(self.trial/'validator-native-receipt.json',{'unit_terminal':True,'returncode':1});self.selection['native_receipt_sha256']=p.sha((self.trial/'validator-native-receipt.json').read_bytes());self.write(self.folder/'validation-selection.json',self.selection)
  with self.assertRaisesRegex(ValueError,'not_actual_success'):self.resolve()
if __name__=='__main__':unittest.main()
