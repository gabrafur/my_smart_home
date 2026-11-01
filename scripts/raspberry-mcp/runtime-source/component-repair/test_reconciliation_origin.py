"""Synthetic forensic provenance cannot masquerade as a recovered native receipt."""
import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from workflow import Workflow

class OriginTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.flow=Workflow(Path(self.tmp.name)/'workflow.sqlite3',lambda:200,1000);self.addCleanup(self.flow.close)
  self.op='a'*32;self.task='b'*32
  self.flow.prepare(self.op,'observacao_host',self.task,'c'*64,'d'*64,{self.task})
  self.flow.put(self.op,'uncertain',{'reason':'historical_unknown'})
  self.proof={'receipt_verified':True,'executor_terminal':True,'operation_id':self.op,'component_id':'observacao_host','task_id':self.task,'action':'apply','receipt_origin':'protected_preregistration_forensic_reconciliation_v1','original_worker_receipt_present':False,'historical_stdout_recovered':False,'definitive_no_effect':True,'effect_attempted':False,'security_cleanup_confirmed':True,'forensic_evidence_sha256':'e'*64,'worker_finished_at':200}
 def reconcile(self,**changes):return self.flow.reconcile(self.op,lambda _:dict(self.proof,**changes))
 def test_provenance_and_historical_failure_are_preserved(self):
  out=self.reconcile();self.assertEqual(out['state'],'failed_without_effect')
  result=json.loads(self.flow.row(self.op)['result']);self.assertEqual(result['receipt_origin'],self.proof['receipt_origin']);self.assertFalse(result['original_worker_receipt_present']);self.assertFalse(result['historical_stdout_recovered'])
  self.assertEqual(self.flow.db.execute("SELECT count(*) FROM receipts WHERE state='uncertain'").fetchone()[0],1)
 def test_unrecognized_origin_or_missing_evidence_remains_uncertain(self):
  for change in ({'receipt_origin':'unreviewed'},{'forensic_evidence_sha256':None}):
   with self.subTest(change=change):self.assertEqual(self.reconcile(**change)['state'],'uncertain')
 def test_fabricated_native_or_effect_claim_remains_uncertain(self):
  for key in ('original_worker_receipt_present','historical_stdout_recovered','effect_attempted'):
   with self.subTest(key=key):self.assertEqual(self.reconcile(**{key:True})['state'],'uncertain')
 def test_terminal_reconciliation_does_not_repeat_observation(self):
  self.reconcile();out=self.flow.reconcile(self.op,lambda _:self.fail('repeated observation'));self.assertEqual(out['state'],'failed_without_effect')

if __name__=='__main__':unittest.main()
