"""Pure synthetic telemetry; no journal, Root or collector invocation."""
import importlib.util
from pathlib import Path
import unittest
H=Path(__file__).resolve().parent.parent/'runtime-source/procmon-observability'
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
W=load('canonical_wrapper_reason',H/'observed_collector.py')
A=load('canonical_audit_reason',H/'audit_runtime.py')
class Reasons(unittest.TestCase):
 def test_new_fixed_failure_codes_are_not_invalid_telemetry(self):
  rows=[]
  for reason in ('collector_mutex_not_held','interrupted_rename_unavailable'):
   observer=W.Observer();observer.stage='preserve_interrupted'
   row=observer.result(ValueError(reason));self.assertEqual(row['reason'],reason)
   rows.append(row)
  result=A.summarize(rows,60)
  self.assertEqual(result['invalid_telemetry_rows'],0);self.assertEqual(result['failed_rows'],2)
  self.assertEqual(result['failure_reasons'],{'collector_mutex_not_held':1,'interrupted_rename_unavailable':1})
 def test_new_codes_keep_same_phase_and_bounded_frame(self):
  import json
  for reason in ('collector_mutex_not_held','interrupted_rename_unavailable'):
   observer=W.Observer();observer.stage='preserve_interrupted'
   row=observer.result(ValueError(reason))
   self.assertEqual(row['phase'],'preserve_interrupted');self.assertIn(row['phase'],A.PHASES)
   self.assertLessEqual(len(json.dumps(row,separators=(',',':')).encode())+1,768)
if __name__=='__main__':unittest.main()
