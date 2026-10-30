import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

BASE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('reader',Path(__file__).with_name('notification_reader.py'))
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
NOW=1792770000
def iso(n):return datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
def notice(i):return {'id':f'{i:064x}','revision':'b'*64,'observed_at':iso(NOW),'created_or_updated_at':iso(NOW-1),'category':'backup','summary':'Backup','category_basis':'identifier_prefix','content_withheld':True,'injected_secret':'must_not_escape'}

class TestReader(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'snapshot.json'
  reader.ASSOCIATED=Path(self.temp.name)/'associated.json'
  self.data={'schema_version':1,'observed_at':iso(NOW),'collection_error':None,'connection_state':'subscribed','last_transport_confirmation_at':iso(NOW),'notifications':[notice(i) for i in range(20)]}
 def tearDown(self):self.temp.cleanup()
 def write(self):self.path.write_text(json.dumps(self.data));self.path.chmod(0o640)
 def get(self,**args):return reader.evidence({'host':'raspberry',**args},self.path,lambda:NOW+1)
 def test_pages_and_redaction(self):
  self.write();r=self.get();self.assertEqual(r['state'],'observed');self.assertEqual(len(r['notifications']),16);self.assertNotIn('must_not_escape',json.dumps(r));self.assertEqual(len(self.get(offset=16,expected_digest=r['digest'])['notifications']),4)
 def test_missing_is_collection_unknown_not_house_failure(self):
  r=self.get();self.assertEqual(r['state'],'unknown');self.assertEqual(r['collection_error'],'not_collected')
 def test_stale_cache_not_current_service_failure(self):
  self.data['observed_at']=iso(NOW-100);self.write();self.assertEqual(self.get()['state'],'stale')
 def test_collection_error_and_future_are_distinct(self):
  self.data['collection_error']='auth_failed';self.write();self.assertEqual(self.get()['state'],'collection_failed')
  self.data['observed_at']=iso(NOW+100);self.write();self.assertEqual(self.get()['collection_error'],'clock_reconciliation_required')
 def test_private_text_in_supported_field_refused(self):
  self.data['notifications'][0]['summary']='secret';self.write();r=self.get();self.assertEqual(r['notifications'],[]);self.assertEqual(r['collection_error'],'invalid_snapshot')
 def test_symlink_and_unsafe_mode_refused(self):
  self.write();self.path.chmod(0o666);self.assertEqual(self.get()['collection_error'],'invalid_snapshot')
  self.path.unlink();self.path.symlink_to('/etc/passwd');self.assertEqual(self.get()['notifications'],[])
 def test_scope_and_pagination_guard(self):
  with self.assertRaises(ValueError):self.get(offset=16)
  with self.assertRaises(ValueError):reader.evidence({'host':'other'},self.path)
 def test_exact_storage_producer_without_inventing_body_or_severity(self):
  row=notice(1);row['id']=reader.STORAGE_NOTICE_ID
  row.update(category='unclassified',summary='Notificação persistente; conteúdo não exportado',category_basis='unknown')
  self.data['notifications']=[row];self.write();result=self.get()['notifications'][0]
  self.assertEqual(result['id'],row['id']);self.assertEqual(result['revision'],row['revision'])
  self.assertEqual(result['category'],'unclassified');self.assertTrue(result['identifier_diagnostic_only'])
  self.assertIn('armazenamento',result['title']);self.assertIn('dry-run',result['correction_guidance'])
  self.assertEqual(result['content_collection_error'],'notice_body_not_retained_as_reviewed_tokens')
  self.assertFalse(result['recovery_proven']);self.assertNotIn('must_not_escape',json.dumps(result))
  self.assertNotIn('identifier_diagnostic_only',reader.notice(notice(2)))
 def test_execute_only_parent_supports_read_without_listing_permission(self):
  parent=Path(self.temp.name)/'traverse_only';parent.mkdir();self.path=parent/'snapshot.json';self.write();parent.chmod(0o100)
  try:
   self.assertEqual(self.get()['state'],'observed')
   parent.chmod(0o000)
   self.assertEqual(self.get()['collection_error'],'collection_read_denied')
  finally:parent.chmod(0o700)

if __name__=='__main__':unittest.main()
