import datetime,importlib.util,json,tempfile,unittest,subprocess,shutil
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('fixed_root_snapshot',Path(__file__).with_name('root_snapshot.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Projection(unittest.TestCase):
 def test_patch_conflicts_are_classified_before_crossing_root_boundary(self):
  v=m.project('safe_update',{'state':'conflict','patch_state':'conflict','conflicts':['error: patch failed: coordinator.py:3','error: sensor.py: patch does not apply','PRIVATE_PATH_TOKEN']})
  self.assertNotIn('PRIVATE',json.dumps(v));self.assertNotIn('conflicts',v)
  self.assertEqual(v['patch_conflict']['files'],['coordinator.py','sensor.py'])
  self.assertEqual(v['patch_conflict']['classified_details'],2)
 def test_private_paths_and_multiline_payload_are_not_classified(self):
  v=m.patch_conflict({'conflicts':['error: patch failed: /PRIVATE/coordinator.py:3','error: patch failed: secret.py:3','error: patch failed: coordinator.py:3\nPRIVATE_TOKEN']})
  self.assertEqual(v['classified_details'],0);self.assertNotIn('PRIVATE',json.dumps(v))
 def test_conflict_bounds_fail_closed(self):
  for values in (None,[{}],['x'*8193],['x']*21):
   self.assertEqual(m.patch_conflict({'conflicts':values})['state'],'unknown')
 def test_root_projection_reaches_the_actual_javascript_contract(self):
  v=m.project('safe_update',{'state':'conflict','patch_state':'conflict','checked_at':'2026-10-26T17:00:00Z','conflicts':['error: patch failed: coordinator.py:3','error: patch failed: sensor.py:723','PRIVATE_TOKEN']})
  program="const fs=require('node:fs'),m=require('./kia_model.cjs'); const data=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(m.project({now_unix_seconds:1793034000,sources:{safe_update:{observed_at:'2026-10-26T17:00:00Z',collection_error:null,data}}}).sources.find(x=>x.source==='safe_update')));"
  result=subprocess.run([shutil.which('node'),'-e',program],input=json.dumps(v),text=True,capture_output=True,timeout=10,cwd=Path(__file__).parent,check=True)
  row=json.loads(result.stdout);self.assertEqual(row['reason_code'],'local_patch_conflict');self.assertEqual(row['patch_conflict']['state'],'observed');self.assertEqual(row['patch_conflict']['files'],['coordinator.py','sensor.py']);self.assertNotIn('PRIVATE',result.stdout)
 def test_private_fields_and_messages_are_omitted(self):
  v=m.project('safe_update',{'state':'conflict','message':'PRIVATE_MESSAGE','password':'_'.join(('PRIVATE','PASSWORD')),'location':{'lat':12+34567/100000},'installed_version':'3.19.0','latest_version':'v3.20.0','conflicts':['PRIVATE_PATH'],'checked_at':'2026-10-26T03:00:00-03:00'})
  self.assertNotIn('PRIVATE_',json.dumps(v));self.assertEqual(v['checked_at'],'2026-10-26T06:00:00+00:00');self.assertEqual(v['conflicts_count'],1)
 def test_invalid_date_is_collection_failure_not_raw_text(self):
  self.assertRaises(ValueError,m.project,'safe_update',{'checked_at':'PRIVATE_COMMENT'})
 def test_free_reason_and_unapproved_reason_code_not_exported(self):
  v=m.project('safe_update',{'reason':'PRIVATE_MESSAGE','reason_code':'PRIVATE_REASON'});self.assertNotIn('PRIVATE',json.dumps(v));self.assertIsNone(v['reason_code'])
 def test_missing_file_and_collection_failure_differ(self):
  with tempfile.TemporaryDirectory()as d,patch.object(m,'INPUT',Path(d)),patch.object(m,'timezone',return_value={'collection_error':None,'timezone':'UTC'}):
   v=m.snapshot('2026-10-26T17:00:00Z');self.assertIsNone(v['sources']['safe_update']['data']);self.assertIsNone(v['sources']['safe_update']['collection_error'])
   (Path(d)/'safe-update').write_text('PRIVATE_INVALID_JSON');v=m.snapshot('2026-10-26T17:00:00Z');self.assertEqual(v['sources']['safe_update']['collection_error'],'fixed_source_collection_failed');self.assertNotIn('PRIVATE',json.dumps(v))
 def test_symlink_source_is_refused(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);(p/'file').write_text('{}');(p/'link').symlink_to(p/'file');self.assertRaises(OSError,m.read,p/'link')
 def test_oversized_source_is_refused(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d)/'file';p.write_bytes(b'x'*33);self.assertRaises(ValueError,m.read,p,32)
 def test_no_raw_version_or_commit_when_invalid(self):
  v=m.project('safe_update',{'latest_version':'PRIVATE_VERSION','source_commit':'PRIVATE_COMMIT'});self.assertNotIn('PRIVATE',json.dumps(v))
 def test_revocation_stops_before_collection(self):
  with tempfile.TemporaryDirectory()as d,patch.object(m,'OUTPUT',Path(d)/'out'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.sys,'argv',['fixed']),patch.object(m,'snapshot',side_effect=AssertionError('must not collect')):
   (Path(d)/'revoked').write_text('revoked');self.assertRaisesRegex(ValueError,'readonly_scope_revoked',m.main)
if __name__=='__main__':unittest.main()
