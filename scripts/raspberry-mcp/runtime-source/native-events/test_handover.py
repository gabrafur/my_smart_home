"""Root-armed same-recipient rollover, with synthetic state and no network."""
import hashlib,json,tempfile,unittest
from unittest.mock import patch
import registry

class HandoverTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1800000000.
  self.r=registry.Registry(self.tmp.name,'fixture_principal',approved=True,sender=lambda *a:None,clock=lambda:self.now);self.addCleanup(self.r.db.close)
  self.secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
  self.url='https://callback.example.org/webhook/mcp-events/'+'a'*32
  self.args={'project':registry.PROJECT,'topics':['ha_notification']}
  self.newargs={'project':registry.PROJECT,'topics':['ha_notification','task_terminal']}
  self.sid,_=self.r.identity(registry.NAME,self.args,{'mode':'webhook','url':self.url})
  self.r.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',(self.sid,'fixture_principal',registry.canonical(self.args),self.url,self.secret,None,0,self.now+2000,self.now,self.now-50,1))
  self.params={'name':registry.NAME,'arguments':self.newargs,'delivery':{'mode':'webhook','url':self.url[:-32]+'b'*32,'secret':self.secret}}
 def arm(self,**changes):
  sha=lambda v:hashlib.sha256(v.encode()).hexdigest()
  g={'schema_version':1,'state':'armed','operation_id':'e'*32,'principal':'fixture_principal','predecessor':self.sid,
     'old_url_sha256':sha(self.url),'old_args_sha256':sha(registry.canonical(self.args)),'target_args_sha256':sha(registry.canonical(self.newargs)),
     'old_started':self.now-50,'old_expires':self.now+2000,'armed_at':self.now-1,'expires_at':self.now+299,'maximum_attempts':1,**changes}
  self.r.db.execute("INSERT OR REPLACE INTO meta VALUES('subscription_handover',?)",(registry.canonical(g),));return g
 def grant(self):return json.loads(self.r.db.execute("SELECT value FROM meta WHERE key='subscription_handover'").fetchone()[0])
 def test_absent_grant_keeps_active_original(self):
  with patch.object(registry,'verify_callback') as cb:
   with self.assertRaisesRegex(registry.Refused,'subscription_limit'):self.r.subscribe(self.params)
   cb.assert_not_called()
  self.assertEqual(self.r.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0],1)
 def test_success_preserves_start_expiry_budget_and_lineage(self):
  self.arm();self.r.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(self.sid,'f'*64,self.now-700))
  with patch.object(registry,'verify_callback') as cb:out=self.r.subscribe(self.params);cb.assert_called_once()
  rows=self.r.db.execute('SELECT * FROM subscriptions ORDER BY active').fetchall();self.assertEqual(len(rows),2);self.assertEqual(rows[0]['id'],self.sid);self.assertEqual(rows[0]['active'],0)
  self.assertEqual(rows[1]['started'],self.now-50);self.assertEqual(rows[1]['expires'],self.now+2000)
  self.assertEqual(tuple(self.r.db.execute('SELECT successor,predecessor FROM subscription_lineage').fetchone()),(out['id'],self.sid));self.assertEqual(self.grant()['state'],'completed')
  self.assertEqual(self.r.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
 def test_uncertain_members_stay_covered_and_pending_members_survive_rotating_callback(self):
  self.arm()
  a=self.r.enqueue('ha_notification','ha_persistent_notification','added','a'*64,'b'*64,self.now)['id']
  b=self.r.enqueue('ha_notification','ha_persistent_notification','added','c'*64,'d'*64,self.now)['id']
  self.r.db.execute('INSERT INTO delivery_members VALUES(?,?,?)',(self.sid,a,'f'*64))
  self.r.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(self.sid,'f'*64,self.now-700))
  with patch.object(registry,'verify_callback'):new=self.r.subscribe(self.params)
  sub,rows,_=self.r.summary_plan(self.now)
  self.assertEqual(sub['id'],new['id']);self.assertEqual([x['id'] for x in rows],[b]);self.assertEqual(self.r.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
  with patch.object(registry,'verify_callback') as verify:
   again=self.r.subscribe(self.params);verify.assert_not_called()
  self.assertEqual(again['id'],new['id']);self.assertEqual(self.r.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],1)
 def test_unsubscribe_first_with_valid_marker_preserves_history(self):
  self.arm();self.r.unsubscribe({'name':registry.NAME,'arguments':self.args,'delivery':{'url':self.url}})
  with patch.object(registry,'verify_callback'):out=self.r.subscribe(self.params)
  self.assertEqual(self.r.db.execute('SELECT started FROM subscriptions WHERE id=?',(out['id'],)).fetchone()[0],self.now-50);self.assertEqual(self.grant()['state'],'completed')
 def test_changed_callback_after_cancel_without_grant_never_resets_window(self):
  self.r.unsubscribe({'name':registry.NAME,'arguments':self.args,'delivery':{'url':self.url}})
  with patch.object(registry,'verify_callback') as cb:
   with self.assertRaisesRegex(registry.Refused,'subscription_transition_unconfirmed'):self.r.subscribe(self.params)
   cb.assert_not_called()
  self.assertEqual(self.r.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0],1)
 def test_foreign_origin_namespace_query_port_or_suffix_blocked(self):
  for url in ('https://other.example.org/webhook/mcp-events/'+'b'*32,'https://callback.example.org/other/'+'b'*32,'https://callback.example.org/webhook/mcp-events/'+'b'*32+'?q=1','https://callback.example.org:444/webhook/mcp-events/'+'b'*32,'https://callback.example.org/webhook/mcp-events/not-an-id'):
   self.arm();params={**self.params,'delivery':{**self.params['delivery'],'url':url}}
   with self.subTest(url_shape=url.split('/')[2]),patch.object(registry,'verify_callback') as cb:
    with self.assertRaises(registry.Refused):self.r.subscribe(params)
    cb.assert_not_called();self.assertEqual(self.grant()['state'],'armed')
 def test_expiry_scope_owner_parent_and_attempt_limit_fail_closed(self):
  for change in ({'expires_at':self.now},{'expires_at':self.now+301},{'armed_at':self.now+1},{'principal':'other'},{'predecessor':'d'*64},{'old_url_sha256':'d'*64},{'old_args_sha256':'d'*64},{'target_args_sha256':'d'*64},{'old_started':self.now-40},{'old_expires':self.now+1900},{'maximum_attempts':True},{'maximum_attempts':2},{'schema_version':True},{'armed_at':float('nan')}):
   self.arm(**change)
   with self.subTest(change=list(change)),patch.object(registry,'verify_callback') as cb:
    with self.assertRaises(registry.Refused):self.r.subscribe(self.params)
    cb.assert_not_called()
 def test_failed_or_uncertain_verification_consumes_one_attempt_without_changing_old(self):
  self.arm()
  with patch.object(registry,'verify_callback',side_effect=TimeoutError('synthetic')) as cb:
   with self.assertRaises(TimeoutError):self.r.subscribe(self.params)
   with self.assertRaisesRegex(registry.Refused,'subscription_handover_consumed'):self.r.subscribe(self.params)
   cb.assert_called_once()
  self.assertEqual(self.grant()['state'],'verification_unconfirmed');self.assertEqual(self.r.db.execute('SELECT active FROM subscriptions WHERE id=?',(self.sid,)).fetchone()[0],1)
 def test_concurrent_parent_drift_after_verification_blocks_commit_and_replay(self):
  self.arm()
  def verify(*args):self.r.db.execute('UPDATE subscriptions SET expires=expires+1 WHERE id=?',(self.sid,))
  with patch.object(registry,'verify_callback',side_effect=verify) as cb:
   with self.assertRaisesRegex(registry.Refused,'subscription_migration_changed'):self.r.subscribe(self.params)
   with self.assertRaises(registry.Refused):self.r.subscribe(self.params)
   cb.assert_called_once()
  self.assertEqual(self.grant()['state'],'verification_intent');self.assertEqual(self.r.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],0)
 def test_missing_marker_on_inactive_predecessor_blocks_network(self):
  self.arm();self.r.db.execute('UPDATE subscriptions SET active=0 WHERE id=?',(self.sid,))
  with patch.object(registry,'verify_callback') as cb:
   with self.assertRaises(registry.Refused):self.r.subscribe(self.params)
   cb.assert_not_called()
 def test_duplicate_or_oversize_grant_never_starts_verification(self):
  self.arm();raw=registry.canonical(self.grant())
  for value in (raw[:-1]+',"state":"armed"}',raw+' '*4097):
   self.r.db.execute("UPDATE meta SET value=? WHERE key='subscription_handover'",(value,))
   with patch.object(registry,'verify_callback') as cb:
    with self.assertRaises(registry.Refused):self.r.subscribe(self.params)
    cb.assert_not_called()
 def test_concurrent_grant_change_before_verification_blocks_network(self):
  self.arm();begin=self.r.begin_handover
  def changed(*args):
   g=self.grant();g['state']='revoked';self.r.db.execute("UPDATE meta SET value=? WHERE key='subscription_handover'",(registry.canonical(g),));return begin(*args)
  with patch.object(self.r,'begin_handover',side_effect=changed),patch.object(registry,'verify_callback') as cb:
   with self.assertRaisesRegex(registry.Refused,'subscription_handover_consumed'):self.r.subscribe(self.params)
   cb.assert_not_called()
 def test_same_callback_migration_still_works_without_exception(self):
  params={**self.params,'delivery':{**self.params['delivery'],'url':self.url}}
  with patch.object(registry,'verify_callback'):self.r.subscribe(params)
  self.assertEqual(self.r.db.execute("SELECT count(*) FROM meta WHERE key='subscription_handover'").fetchone()[0],0)

if __name__=='__main__':unittest.main()
