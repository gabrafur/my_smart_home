import ast,hashlib,importlib.util,types,unittest
from pathlib import Path
from unittest.mock import Mock
p=Path(__file__).parent;s=importlib.util.spec_from_file_location('candidate_recovery',p/'recovery.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Cases(unittest.TestCase):
 def test_wrapper_still_pins_exact_candidate_executor(self):self.assertEqual(m.EXPECTED,hashlib.sha256((p/'executor.py').read_bytes()).hexdigest())
 def test_original_consumed_migration_row_is_unchanged(self):
  old=ast.parse((p/'before-recovery.py').read_text());node=next(n for n in old.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='ORIGINAL_ROW'for t in n.targets));self.assertEqual(m.ORIGINAL_ROW,ast.literal_eval(node.value))
 def test_new_readonly_request_never_calls_legacy_validation_or_handle(self):
  request={'tool':'icloud_readiness','host':'raspberry','component_id':'icloud_adapter'};mod=types.SimpleNamespace(READINESS_REQUEST=request,readiness=Mock(return_value={'state':'unknown'}),validate=Mock(side_effect=AssertionError('legacy request must not run')),handle=Mock(side_effect=AssertionError('legacy effect must not run')));backend=object();self.assertEqual(m.dispatch(request,mod,backend,None),{'state':'unknown'});mod.readiness.assert_called_once_with(request,backend);mod.handle.assert_not_called()
if __name__=='__main__':unittest.main()
