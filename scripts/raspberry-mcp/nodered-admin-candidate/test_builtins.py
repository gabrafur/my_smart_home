import copy,json,unittest
from pathlib import Path
import engine as E
FUNCTIONS=Path(__file__).resolve().parents[3]/'nodered/tools/functions'
NODES=[{'id':'global_observer_eva_private_'+kind,'type':'function','z':'global_flow_observer_tab',
        'func':(FUNCTIONS/('eva-private-notice-'+kind+'.js')).read_text().rstrip(),
        'libs':[{'var':'fs','module':'fs'}]+([{'var':'crypto','module':'crypto'}] if kind=='export' else []),
        'outputs':0 if kind=='export' else 2,'initialize':'','finalize':''}
       for kind in ('export','status')]
OP='a'*32;POLICY='b'*64
class BuiltinTests(unittest.TestCase):
 def plan(self,before,edits):return E.build_plan(OP,{'rev':'fixture','flows':before},edits,POLICY,100)
 def create(self,node):return self.plan([], [{'kind':'create','node':node}])
 def patch(self,before,fields,unset=None):return self.plan([before],[{'kind':'patch','node_id':before['id'],'expected_node_sha256':E.digest(before),'set_fields':fields,'unset_fields':unset or []}])
 def test_exact_two_public_functions_create(self):
  for n in NODES:
   p=self.create(n);self.assertEqual(p['after_flows'],[n]);self.assertTrue(p['risk']['requires_exact_effect_review']);self.assertFalse(p['risk']['automated_scan_is_authorization'])
 def test_other_identity_tab_type_or_source_refuses(self):
  for delta in ({'id':'other'}, {'z':'other'}, {'type':'debug'}, {'func':'return msg;'}, {'initialize':'fs.readFileSync("x")'}, {'finalize':'return;'}, {'outputs':7}):
   n={**NODES[0],**delta}
   with self.assertRaisesRegex(ValueError,'module_install_not_admitted'):self.create(n)
 def test_npm_alias_subpath_wrong_variable_duplicate_or_extra_refuses(self):
  for libs in ([{'var':'fs','module':'node:fs'}],[{'var':'fs','module':'fs/promises'}],[{'var':'fs','module':'left-pad'}],[{'var':'other','module':'fs'}],NODES[0]['libs']*2,NODES[0]['libs']+[{'var':'os','module':'os'}]):
   with self.assertRaisesRegex(ValueError,'module_install_not_admitted'):self.create({**NODES[0],'libs':libs})
 def test_patch_admits_exact_full_node_library_contract(self):
  n=NODES[0];old={**n,'libs':[],'func':'return null;'}
  p=self.patch(old,{'libs':n['libs'],'func':n['func']});self.assertEqual(p['after_flows'],[n])
 def test_func_only_patch_cannot_reuse_granted_fs(self):
  with self.assertRaisesRegex(ValueError,'module_install_not_admitted'):self.patch(NODES[0],{'func':'fs.unlinkSync(msg.path);'})
 def test_initializer_and_tab_change_cannot_reuse_granted_fs(self):
  for delta in ({'initialize':'fs.readFileSync("x")'},{'finalize':'fs.readFileSync("x")'},{'z':'other'}):
   with self.assertRaisesRegex(ValueError,'module_install_not_admitted'):self.patch(NODES[0],delta)
 def test_layout_patch_preserves_exact_program(self):
  p=self.patch(NODES[0],{'x':999});self.assertEqual(p['after_flows'][0]['func'],NODES[0]['func'])
 def test_removal_allows_own_library_revocation(self):
  p=self.patch(NODES[0],{'libs':[],'func':'return null;'});self.assertEqual(p['after_flows'][0]['libs'],[])
 def test_generic_module_install_and_shell_remain_closed(self):
  n={'id':'other','type':'function','z':'tab','func':'return msg;','libs':[]}
  with self.assertRaisesRegex(ValueError,'module_install_not_admitted'):self.patch(n,{'libs':[{'var':'fs','module':'fs'}]})
  with self.assertRaisesRegex(ValueError,'shell_node_refused'):self.create({'id':'shell','type':'exec'})
 def test_stale_node_cas_still_refuses_before_admission(self):
  with self.assertRaisesRegex(ValueError,'node_compare_swap_conflict'):self.plan([NODES[0]],[{'kind':'patch','node_id':NODES[0]['id'],'expected_node_sha256':'0'*64,'set_fields':{'x':2},'unset_fields':[]}])
if __name__=='__main__':unittest.main()

class ClassificationTests(unittest.TestCase):
 def test_current_execution_blocker_is_not_misreported_as_owner_revoked(self):
  import types
  p={'enabled':True,'host':'raspberry','project':'/mnt/data/docker','activation_confirmed':True,'lease_kind':'persistent_revocable','standing_maintenance_authorized':True,'expires_at':None,'maximum_deploys_per_24h':4,'minimum_deploy_spacing_seconds':60,'maximum_plan_age_seconds':900}
  e=object.__new__(E.Engine);e.policy=p;e.clock=lambda:100
  for why in ('session_receipt_missing','owned_session_cleanup_unconfirmed','standing_installation_unconfirmed'):
   e.coordination=types.SimpleNamespace(execution_blocker=lambda:why,revoked=lambda:True)
   with self.assertRaisesRegex(ValueError,'^'+why+'$'):e._policy()
  e.coordination=types.SimpleNamespace(execution_blocker=lambda:'authority_revocation_record')
  with self.assertRaisesRegex(ValueError,'^policy_revoked$'):e._policy()
