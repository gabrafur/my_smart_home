import copy,json,unittest
import package_model as m
class Cases(unittest.TestCase):
 def setUp(self):
  self.before={n:None for n in m.TARGETS};self.before['admin-policy.json']=m.raw({'enabled':True,'expires_at':m.EXPIRY,'not_before':1,'boot_id':'fixture','sealed':{'executor.py':'a'*64},'dependencies':{},'baselines':{'old':'preserved'}});self.before['repair-policy.json']=m.raw({'enabled':True,'expires_at':m.EXPIRY,'maximum_submissions':2,'source_hashes':{'repair-broker.py':'b'*64},'dependencies':{},'tasks':['old'],'thread':'fixed'});self.after={n:b'candidate'for n in m.TARGETS};self.after['icloud-readiness.json']=m.raw({'schema_version':1,'enabled':True,'expires_at':m.EXPIRY,'minimum_poll_seconds':60});self.after['icloud-readiness.conf']=m.UNIT_CONF.encode();self.frozen={p:b'fixed'for p in m.UNCHANGED}
 def test_policy_construction_changes_only_declared_scope_and_integrity_pins(self):
  result=m.proposed(self.before,self.after,self.frozen);admin=json.loads(result['admin-policy.json']);repair=json.loads(result['repair-policy.json']);self.assertEqual(admin['baselines'],{'old':'preserved'});self.assertEqual(admin['expires_at'],m.EXPIRY);self.assertEqual(repair['maximum_submissions'],2);self.assertEqual(repair['thread'],'fixed');self.assertEqual(repair['tasks'],['old']);self.assertEqual(repair['dependencies'][m.TARGETS['admin-policy.json']],m.sha(result['admin-policy.json']))
 def test_existing_or_disabled_scope_requires_reconciliation(self):
  admin=json.loads(self.before['admin-policy.json']);admin['readiness_scope']={'old':'must-preserve'};self.before['admin-policy.json']=m.raw(admin)
  with self.assertRaises(ValueError):m.proposed(self.before,self.after,self.frozen)
 def test_wrong_expiry_rate_or_additional_security_directive_refused(self):
  for value in [m.raw({'schema_version':1,'enabled':True,'expires_at':m.EXPIRY+1,'minimum_poll_seconds':60}),m.raw({'schema_version':1,'enabled':True,'expires_at':m.EXPIRY,'minimum_poll_seconds':1})]:
   payload={**self.after,'icloud-readiness.json':value}
   with self.assertRaises(ValueError):m.proposed(self.before,payload,self.frozen)
  with self.assertRaises(ValueError):m.proposed(self.before,{**self.after,'icloud-readiness.conf':self.after['icloud-readiness.conf']+b'CapabilityBoundingSet=CAP_SYS_ADMIN\n'},self.frozen)
 def test_target_or_unchanged_scope_cannot_expand(self):
  with self.assertRaises(ValueError):m.proposed(self.before,{**self.after,'arbitrary.py':b'code'},self.frozen)
  with self.assertRaises(ValueError):m.proposed(self.before,self.after,{**self.frozen,'/arbitrary':b'content'})
 def test_legacy_submission_budget_and_authority_must_remain_exact(self):
  for name,key,value in [('admin-policy.json','enabled',False),('repair-policy.json','expires_at',m.EXPIRY+1),('repair-policy.json','maximum_submissions',3)]:
   before=copy.deepcopy(self.before);value_row=json.loads(before[name]);value_row[key]=value;before[name]=m.raw(value_row)
   with self.assertRaises(ValueError):m.proposed(before,self.after,self.frozen)
if __name__=='__main__':unittest.main()
