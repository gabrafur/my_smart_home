import contextlib,importlib.util,json,sqlite3,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
S=Path(__file__).parent;sys.path.insert(0,str(S))
import repair_control as c
from repair_store import Store,TASK,THREAD
NOW=1794785200
GRANT={'schema':'fixed_health_repair_standing_v1','lease_kind':'persistent_revocable','owner_confirmation_sha256':'a'*64,'project':'/mnt/data/docker','maximum_submissions_per_24h':2,'maximum_receipts':4096,'revoked':False,'interface_confirmations_required':True,'legacy_administrative_grant':False}
def policy():return {'enabled':True,'expires_at':None,'maximum_submissions':2,'standing_repair':dict(GRANT)}
class PolicyTests(unittest.TestCase):
 def test_closed_grant(self):
  self.assertTrue(c.standing(policy()))
  for key,value in [('maximum_submissions_per_24h',3),('legacy_administrative_grant',True),('interface_confirmations_required',False),('owner_confirmation_sha256','0'*64)]:
   p=policy();p['standing_repair'][key]=value
   with self.assertRaises(ValueError):c.standing(p)
 def test_v2_does_not_reopen_legacy_administrative_grant(self):
  with tempfile.TemporaryDirectory()as td:
   calls=[]
   tasks=types.SimpleNamespace(STATE=Path(td),policy=lambda *a,**k:self.fail('legacy grant used'),task_policy=lambda old,**kwargs:(calls.append(kwargs) or {'enabled':True,'admin_delegation':{'enabled':False}},{'_v2':True,'peer_pid':10,'socket_identity':[1,2]}))
   p,peer=c.selected_admission(policy(),tasks,object());self.assertFalse(p['admin_delegation']['enabled']);self.assertEqual(calls,[{'observation':False}])
 def test_revocation_blocks_new_effect_but_not_observation(self):
  with tempfile.TemporaryDirectory()as td:
   tasks=types.SimpleNamespace(STATE=Path(td),task_policy=lambda old,**kwargs:({'enabled':False},{'_v2':True}))
   p=policy();p['standing_repair']['revoked']=True
   with self.assertRaisesRegex(ValueError,'revoked'):c.selected_admission(p,tasks,None)
   self.assertEqual(c.selected_admission(p,tasks,None,observation=True)[1],{'_v2':True})
 def test_peer_failure_not_expired(self):
  tasks=types.SimpleNamespace(task_policy=lambda *a,**k:({'enabled':True},{'_v2':True,'_v2_peer_unconfirmed':True}))
  with self.assertRaisesRegex(ValueError,'repair_peer_unconfirmed'):c.selected_admission(policy(),tasks,None)
 def test_capabilities_persistent_after_legacy_expiry(self):
  with tempfile.TemporaryDirectory()as td:
   tasks=types.SimpleNamespace(STATE=Path(td),locked=contextlib.nullcontext,task_policy=lambda old,**kw:({'enabled':True},{'_v2':True}))
   with patch.object(c,'quota_observation',return_value={'state':'observed','unknown_timestamp_reserved_count':0}),patch.object(c,'configuration',return_value=policy()),patch.object(c,'STATE',Path(td)),patch.object(c.os,'geteuid',return_value=1001),patch.object(c.time,'time',return_value=NOW):
    r=c.handle('codex_repair_capabilities',{'host':'raspberry'},None,tasks)
   self.assertTrue(r['enabled']);self.assertIsNone(r['expires_at']);self.assertEqual(r['submission_window'],'rolling_24h')
class StoreTests(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:',isolation_level=None);self.db.execute('CREATE TABLE jobs(id TEXT PRIMARY KEY,created REAL)')
 def tearDown(self):self.db.close()
 def test_rolling_count_reservations_and_more_than_eight_historical_runs(self):
  now=[NOW-10*86400];s=Store(self.db,clock=lambda:now[0],standing=True)
  for n in range(10):
   s.reserve(f'{n:032x}');h=s.terminal(f'{n:032x}',{'operation_state':'completed'});s.reconcile(f'{n:032x}',h);now[0]+=86400
  self.assertEqual(s.rolling_count(NOW),0);s.reserve('f'*32);self.assertEqual(s.rolling_count(NOW),1)
  self.assertFalse(s.reserve('0'*32));self.assertEqual(self.db.execute('SELECT count(*)FROM repair_receipts').fetchone()[0],11)
 def test_exact_historical_dispatch_time_only(self):
  s=Store(self.db);s.reserve('a'*32);self.db.execute('INSERT INTO jobs VALUES(?,?)',('a'*32,NOW-10));s=Store(self.db,standing=True)
  self.assertEqual(s.rolling_count(NOW),1)
 def test_missing_historical_time_does_not_invent_age(self):
  s=Store(self.db);s.reserve('a'*32);s=Store(self.db,standing=True)
  with self.assertRaisesRegex(ValueError,'historical_repair_timestamp_unconfirmed'):s.rolling_count(NOW)
 def test_uncertain_reservation_keeps_dedupe_across_reopen(self):
  s=Store(self.db,clock=lambda:NOW,standing=True);s.reserve('a'*32);s=Store(self.db,standing=True)
  self.assertFalse(s.reserve('a'*32))
  with self.assertRaises(ValueError):s.reserve('b'*32)
 def test_future_timestamp_refuses(self):
  s=Store(self.db,clock=lambda:NOW+1,standing=True);s.reserve('a'*32)
  with self.assertRaises(ValueError):s.rolling_count(NOW)
if __name__=='__main__':unittest.main()
