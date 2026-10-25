import contextlib,importlib.util,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
from test_expired_observation import c as tasks, task_list
import types
legacy=types.ModuleType('_owner_access_legacy_snapshot')
legacy.__file__=str(Path(__file__).parent.parent/'legacy-control/codex_control.py')
source=Path(legacy.__file__).read_text()
for index,suffix in [(1,'10'),(2,'20'),(3,'30')]:
 source=source.replace('${AUTHORIZED_THREAD_ID_'+str(index)+'}','00000000-0000-7000-8000-'+suffix.zfill(12))
exec(compile(source,legacy.__file__,'exec'),legacy.__dict__)
class OwnerAccessTests(unittest.TestCase):
 def test_owner_read_status_allowed_without_operation_send_scope_preserved(self):
  owner=legacy.OBSERVATION_THREADS[-1]
  for method in ['codex_thread_read','codex_thread_status']:legacy.validate(method,{'host':'raspberry','thread_id':owner})
  with self.assertRaises(ValueError):legacy.validate('codex_thread_send',{'host':'raspberry','thread_id':owner,'operation_id':'a'*32,'intent':'continue'})
  with self.assertRaises(ValueError):legacy.validate('codex_thread_read',{'host':'raspberry','thread_id':owner,'operation_id':'a'*32})
  self.assertEqual(len(legacy.THREADS),2)
 def test_unapproved_thread_rejected(self):
  with self.assertRaises(ValueError):legacy.validate('codex_thread_read',{'host':'raspberry','thread_id':'00000000-0000-0000-0000-000000000000'})
 def rows(self):return [{'thread_id':identifier,'status':'active'if alias=='coordenacao_meta'else'notLoaded','can_accept_direct_input':True,'updated_at':1000,'durable':True,'collection_error':None,'private':'PRIVATE_SENTINEL'}for identifier,alias in task_list.REFERENCES.items()]
 def test_live_owner_busy_and_notloaded_not_terminal_no_private_text(self):
  value=tasks.project_reference_observations(task_list.REFERENCES,{'rows':self.rows()},1002)
  self.assertIsNone(value['collection_error']);self.assertEqual(len(value['threads']),3)
  owner=next(r for r in value['threads']if r['safe_title']=='coordenacao_meta');self.assertFalse(owner['can_receive_input']);self.assertEqual(owner['serial_execution_gate'],'busy')
  self.assertTrue(all(r['notLoaded_is_terminal']is False for r in value['threads']));self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))
 def test_failed_or_conflicting_collection_stays_unknown(self):
  rows=self.rows()
  for reply in [None,{'rows':rows[:-1]},{'rows':rows+[rows[0]]},{'rows':[dict(r,thread_id='foreign')for r in rows]}]:
   value=tasks.project_reference_observations(task_list.REFERENCES,reply,1002);self.assertIsNotNone(value['collection_error']);self.assertTrue(all(not r['can_receive_input']for r in value['threads']))
 def test_dates_and_private_errors_sanitized(self):
  rows=[dict(r,updated_at=2000,collection_error='PRIVATE_SENTINEL')for r in self.rows()]
  value=tasks.project_reference_observations(task_list.REFERENCES,{'rows':rows},1002)
  self.assertTrue(all(r['last_activity_at']is None for r in value['threads']));self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))
 def test_readonly_fallback_calls_only_metadata_no_store_or_resume(self):
  with patch.object(tasks,'coordinator_checkpoint',return_value={'state':'unknown'}),patch.object(tasks,'policy',return_value=({},{}))as policy,patch.object(tasks,'locked',return_value=contextlib.nullcontext())as locked,patch.object(tasks,'rpc',return_value={'rows':self.rows()})as rpc,patch.object(tasks,'store',side_effect=AssertionError('store_forbidden')):
   value=tasks.reference_observations(legacy)
   policy.assert_called_once_with(legacy,observation=True);locked.assert_called_once_with(read_only=True);self.assertEqual(rpc.call_args.args[0]['mode'],'metadata_batch');self.assertEqual(value['assistant_dispatches'],0)
if __name__=='__main__':unittest.main()
