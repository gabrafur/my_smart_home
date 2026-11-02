import json,tempfile,unittest
from unittest.mock import patch
import registry
class RefusalMetadata(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.r=registry.Registry(self.tmp.name,'fixture_principal',approved=True,sender=lambda *a:None,clock=lambda:1800000000.);self.addCleanup(self.r.db.close)
 def test_failure_metadata_is_closed_and_preserves_original_exception(self):
  raw={'delivery':{'url':'https://private.invalid/PRIVATE_URL','secret':'PRIVATE_SECRET'},'arguments':{'project':'/mnt/data/docker','topics':['ha_notification','task_terminal']}}
  with patch.object(self.r,'_subscribe',side_effect=registry.Refused('subscription_limit')):
   with self.assertRaisesRegex(registry.Refused,'subscription_limit'):self.r.subscribe(raw)
  v=json.loads(self.r.db.execute("SELECT value FROM meta WHERE key='subscription_refusal_metadata'").fetchone()[0]);self.assertEqual(v['reason'],'subscription_limit');self.assertEqual(v['last_completed_stage'],'received');self.assertEqual(v['requested_topics'],['ha_notification','task_terminal']);self.assertFalse(v['callback_matches_active']);self.assertNotIn('PRIVATE',json.dumps(v));self.assertEqual(self.r.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0],0)
 def test_diagnostic_failure_does_not_replace_refusal(self):
  with patch.object(self.r,'subscription_diagnostics',side_effect=RuntimeError('private')):self.r.note_refusal_diagnostic('private',{},'private')
  self.assertIsNone(self.r.db.execute("SELECT value FROM meta WHERE key='subscription_refusal_metadata'").fetchone())
if __name__=='__main__':unittest.main()
