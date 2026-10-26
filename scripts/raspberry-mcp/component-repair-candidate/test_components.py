import copy,hashlib,unittest
from components import Reader,COMPONENTS
NOW=1792926000
class Cases(unittest.TestCase):
 def setUp(self):
  self.body=('public source\n'*500).encode();self.sha=hashlib.sha256(self.body).hexdigest();self.id='a'*32;self.registry={c:{'source_sha256':self.sha,'origin':'reviewed_public_snapshot','artifacts':{self.id:{'kind':'source','sha256':self.sha,'size_bytes':len(self.body)}}}for c in COMPONENTS};self.runtime={};self.r=Reader(self.registry,lambda c,a:self.body,lambda c:self.runtime,lambda:NOW)
 def call(self,**kw):return self.r.call({'host':'raspberry','component_id':'icloud_adapter','view':'source','artifact_id':self.id,**kw})
 def test_pinned_source_is_not_loaded_or_functional_proof(self):
  r=self.call();self.assertEqual(r['loaded']['state'],'unknown');self.assertFalse(r['loaded']['disk_source_is_loaded_proof']);self.assertTrue(r['text'])
 def test_all_four_components_catalogued(self):
  for c in COMPONENTS:self.assertEqual(self.call(component_id=c,view='catalog',artifact_id=None)['artifacts'][0]['artifact_id'],self.id)
 def test_arbitrary_path_host_unknown_component_and_extra_fields_rejected(self):
  for p in [{'path':'/private'},{'host':'other'},{'component_id':'other'},{'artifact_id':'../private'},{'offset':True}]:
   with self.assertRaises(ValueError):self.call(**p)
 def test_pages_are_stable_and_changed_digest_refused(self):
  a=self.call();b=self.call(offset=a['next_offset'],expected_digest=a['digest']);self.assertEqual(a['text']+b['text'],self.body.decode())
  with self.assertRaisesRegex(ValueError,'snapshot_changed'):self.call(offset=4000,expected_digest='0'*64)
 def test_snapshot_tampering_and_view_mismatch_refused(self):
  self.body+=b'unknown change'
  with self.assertRaisesRegex(ValueError,'source_changed'):self.call()
  with self.assertRaisesRegex(ValueError,'view_mismatch'):self.call(view='parameters')
 def test_runtime_requires_protected_attestation_and_fresh_time(self):
  self.runtime={'source':'protected_loaded_component_attestation','component_id':'icloud_adapter','root_verified':True,'state':'observed','collection_error':None,'loaded_identity_kind':'python_code_objects_v1','observed_at':'2026-10-25T11:00:00Z','loaded_sha256':self.sha};self.assertEqual(self.call()['loaded']['state'],'observed')
  for patch in [{'observed_at':None},{'observed_at':'2026-10-25T10:00:00Z'},{'observed_at':'2026-10-25T11:01:00Z'},{'root_verified':False},{'component_id':'other'}]:
   old=self.runtime;self.runtime={**old,**patch};self.assertEqual(self.call()['loaded']['state'],'unknown');self.runtime=old
 def test_different_identity_domains_do_not_compare_hashes(self):
  self.runtime={'source':'protected_loaded_component_attestation','component_id':'icloud_adapter','root_verified':True,'state':'observed','collection_error':None,'loaded_identity_kind':'python_code_objects_v1','observed_at':'2026-10-25T11:00:00Z','loaded_sha256':self.sha}
  r=self.call()['loaded'];self.assertEqual(r['state'],'observed');self.assertIsNone(r['matches_reviewed_source']);self.assertEqual(r['comparison_state'],'not_comparable')
 def test_explicit_runtime_comparison_matches_only_same_identity_domain(self):
  self.registry['icloud_adapter']['runtime_comparison']={'kind':'python_code_objects_v1','sha256':self.sha}
  self.runtime={'source':'protected_loaded_component_attestation','component_id':'icloud_adapter','root_verified':True,'state':'observed','collection_error':None,'loaded_identity_kind':'python_code_objects_v1','observed_at':'2026-10-25T11:00:00Z','loaded_sha256':self.sha}
  self.assertTrue(self.call()['loaded']['matches_reviewed_source'])
  self.runtime['loaded_identity_kind']='nodered_scoped_configuration_v1';self.assertIsNone(self.call()['loaded']['matches_reviewed_source'])
 def test_unknown_or_failed_collection_cannot_reuse_a_loaded_hash(self):
  self.runtime={'source':'protected_loaded_component_attestation','component_id':'icloud_adapter','root_verified':True,'state':'unknown','collection_error':'process_identity_unconfirmed','loaded_identity_kind':'python_code_objects_v1','observed_at':'2026-10-25T11:00:00Z','loaded_sha256':self.sha}
  out=self.call()['loaded'];self.assertEqual(out['state'],'unknown');self.assertIsNone(out['loaded_version']);self.assertEqual(out['collection_error'],'process_identity_unconfirmed')
 def test_collection_failure_does_not_fabricate_loaded_version(self):
  def failed(c):raise OSError()
  self.r.runtime=failed;self.assertEqual(self.call()['loaded']['state'],'unknown')
if __name__=='__main__':unittest.main()
