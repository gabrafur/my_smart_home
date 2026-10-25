import contextlib,copy,datetime,importlib.util,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
from test_expired_observation import c
class CheckpointTests(unittest.TestCase):
 def fixture(self):return {'schema_version':1,'source':'coordinator_scope_report','thread_id':c.COORDINATOR_THREAD,'observed_at':'2026-10-25T11:00:00Z','state':'in_progress','active_work':'owner_thread_access','head':'a'*40,'completed':['events_retained_pending_separation'],'pending':['icloud_core_compatibility'],'reserved_components':['thread_access_adapter'],'events_delivery_opportunity':'candidate_not_implemented_by_coordinator','execution_receipt':False,'full_goal_complete':False}
 def now(self):return datetime.datetime(2026,10,25,11,0,1,tzinfo=datetime.timezone.utc).timestamp()
 def test_fresh_scope_not_execution_or_authority(self):
  d=c.project_coordinator_checkpoint(self.fixture(),self.now());self.assertEqual(d['state'],'observed');self.assertEqual(d['reported_active_work'],'owner_thread_access');self.assertFalse(d['execution_receipt']);self.assertFalse(d['administrative_authority_from_report']);self.assertFalse(d['goal_completion_verified'])
 def test_stale_scope_is_unknown_reservation_not_released(self):
  d=c.project_coordinator_checkpoint(self.fixture(),self.now()+600);self.assertEqual(d['state'],'unknown');self.assertEqual(d['collection_error'],'coordinator_report_stale');self.assertEqual(d['reported_reserved_components'],['thread_access_adapter']);self.assertFalse(d['scope_fresh'])
 def test_unapproved_free_text_types_wrong_identity_or_dates_refused(self):
  for change in [{'extra':'PRIVATE_SENTINEL'},{'pending':['PRIVATE_SENTINEL']},{'active_work':[]},{'thread_id':'foreign'},{'schema_version':True},{'observed_at':'2027-01-01T00:00:00Z'},{'observed_at':None}]:
   d=self.fixture();d.update(change);r=c.project_coordinator_checkpoint(d,self.now());self.assertEqual(r['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r))
 def test_reported_completion_not_treated_as_verified(self):
  d=self.fixture();d['full_goal_complete']=True;d['state']='complete';r=c.project_coordinator_checkpoint(d,self.now());self.assertTrue(r['reported_goal_complete']);self.assertFalse(r['goal_completion_verified'])
 def test_fixed_bounded_reader_and_hash_only_sources(self):
  def read(path,owner,mode,limit):
   if path==c.COORDINATOR_REPORT:
    self.assertEqual((owner,mode,limit),(1001,0o600,16384));return json.dumps(self.fixture()).encode()
   self.assertEqual((owner,mode,limit),(0,0o644,1048576));return b'synthetic-public-source'
  with patch.object(c,'read',side_effect=read)as reader,patch.object(c.time,'time',return_value=self.now()):
   r=c.coordinator_checkpoint();self.assertEqual(reader.call_count,3);self.assertNotIn('synthetic-public-source',json.dumps(r));self.assertEqual(len(r['installed_source_fingerprints']),2)
 def test_collection_failure_unknown_no_raw_error(self):
  with patch.object(c,'read',side_effect=OSError('PRIVATE_SENTINEL')):
   d=c.coordinator_checkpoint();self.assertEqual(d['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d));self.assertTrue(all(v is None for v in d['installed_source_fingerprints'].values()))
 def test_existing_owner_read_appends_checkpoint_without_store_or_send(self):
  with patch.object(c,'policy',return_value=({},{})),patch.object(c,'locked',return_value=contextlib.nullcontext()),patch.object(c,'store',side_effect=AssertionError('no_store')),patch.object(c,'coordinator_checkpoint',return_value={'state':'observed'})as report:
   calls=[];d=c.legacy_call('codex_thread_read',{'thread_id':c.COORDINATOR_THREAD},object(),lambda name,args:calls.append(name)or{'status':'active'});self.assertEqual(d['coordination_checkpoint']['state'],'observed');self.assertEqual(calls,['codex_thread_read']);report.assert_called_once()
if __name__=='__main__':unittest.main()
