import contextlib,copy,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).parent
s=importlib.util.spec_from_file_location('fixed_kia_deployment',P.parent/'runtime-source/administrative-recovery/apply_kia_promotion_evidence.py');u=importlib.util.module_from_spec(s);s.loader.exec_module(u)
def context():
 create={'operation_id':'a'*32,'task_key':'eva-admin-fixed-kia-fixture','objective':'fixed synthetic objective','acceptance':'fixed synthetic acceptance'}
 send={'operation_id':'b'*32,'task_id':create['operation_id'],'text':'fixed synthetic instructions'}
 m={'phases':{'apply':{'create':create,'send':send}}}
 t={'id':create['operation_id'],'task_key':create['task_key'],'spec_hash':u.fingerprint(create),'state':'created','thread':'1'*36,'reconciled':1}
 s={'id':send['operation_id'],'task':t['id'],'input_hash':u.fingerprint(send),'state':'accepted','turn':'2'*36,'result':None,'reconciled':0}
 return m,[t],[s]
class ContextTests(unittest.TestCase):
 def test_only_exact_admitted_operation_is_exempt(self):
  m,t,s=context();u.validate_task_context(m,'apply',t,s)
 def test_wrong_task_key_spec_or_identity_refused(self):
  for change in [{'task_key':'ordinary-task'},{'spec_hash':'0'*64},{'thread':None},{'reconciled':0},{'state':'create_unknown'}]:
   m,t,s=context();t[0].update(change);self.assertRaises(ValueError,u.validate_task_context,m,'apply',t,s)
 def test_uncertain_terminal_or_unbound_send_never_performs_effect(self):
  for change in [{'state':'send_unknown'},{'state':'outcome_unknown'},{'state':'completed'},{'turn':None},{'result':'{}'},{'input_hash':'0'*64},{'task':'c'*32},{'id':'c'*32},{'reconciled':1}]:
   m,t,s=context();s[0].update(change);self.assertRaises(ValueError,u.validate_task_context,m,'apply',t,s)
 def test_other_open_task_or_send_blocks(self):
  for kind in ['task','send']:
   m,t,s=context()
   if kind=='task':t.append({**t[0],'id':'c'*32,'reconciled':0})
   else:s.append({**s[0],'id':'c'*32})
   self.assertRaises(ValueError,u.validate_task_context,m,'apply',t,s)
 def test_other_busy_but_acknowledged_row_also_blocks(self):
  for kind in ['task','send']:
   m,t,s=context()
   if kind=='task':t.append({**t[0],'id':'c'*32,'state':'create_unknown','reconciled':1})
   else:s.append({**s[0],'id':'c'*32,'state':'accepted','reconciled':1})
   self.assertRaises(ValueError,u.validate_task_context,m,'apply',t,s)
 def test_terminal_acknowledged_history_is_preserved(self):
  m,t,s=context();t.append({**t[0],'id':'c'*32,'state':'creation_lost_before_send','reconciled':1});s.append({**s[0],'id':'d'*32,'state':'failed','reconciled':1});u.validate_task_context(m,'apply',t,s)

class LifecycleTests(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name);self.stage=root/'stage';self.stage.mkdir();self.state=root/'state';self.targets={n:root/n for n in ['promote-kia-uvo-candidate.mjs','kia_model.cjs','repair-policy.json']};self.before={n:('before-'+n).encode()for n in self.targets};self.after={n:('after-'+n).encode()for n in self.targets};self.before['repair-policy.json']=u.raw({'dependencies':{str(self.targets['kia_model.cjs']):u.sha(self.before['kia_model.cjs'])},'authority':'fixed'});self.after['repair-policy.json']=u.raw({'dependencies':{str(self.targets['kia_model.cjs']):u.sha(self.after['kia_model.cjs'])},'authority':'fixed'})
  self.m={'operation_id':'synthetic','targets':{n:{'uid':0,'mode':420,'before':u.sha(self.before[n]),'after':u.sha(self.after[n])}for n in self.targets},'phases':{'apply':{},'rollback':{},'reapply':{}}};self.commands=[]
  for n,p in self.targets.items():p.write_bytes(self.before[n]);(self.stage/n).write_bytes(self.after[n])
  for n in ['apply.py','MANIFEST.json','sealed_helpers.py']:(self.stage/n).write_bytes(b'fixed-fixture')
  self.h=types.SimpleNamespace(chains=lambda:None,directory=lambda p,*a:p.mkdir(),atomic=lambda p,b,*a:p.write_bytes(b))
  stack=contextlib.ExitStack();self.addCleanup(stack.close)
  replacements={'STAGE':self.stage,'STATE':self.state,'BUNDLE':self.state/'bundle','TARGETS':self.targets,'load':lambda:(self.m,self.after),'helper':lambda:self.h,'frozen':lambda m:None,'locks':lambda *a,**k:contextlib.nullcontext(),'read':lambda p,*a:Path(p).read_bytes(),'services':lambda:{'synthetic':'running original-start'},'diagnostic_manager':lambda:{'ActiveState':'active','MainPID':'42'},'put':lambda h,p,b,*a:p.write_bytes(b),'reload':lambda h,phase:self.commands.append(phase)or{'previous_pid':'42','new_pid':'43'}}
  replacements['command']=lambda argv:b'active\n'
  for name,value in replacements.items():stack.enter_context(patch.object(u,name,value))
  stack.enter_context(patch.object(u.os,'geteuid',lambda:0));stack.enter_context(patch.object(u.time,'time',lambda:u.EXPIRY-1000));stack.enter_context(patch('builtins.print'))
 def test_apply_rollback_and_reapply_are_distinct_confirmed_phases(self):
  for action,data in [('apply',self.after),('rollback',self.before),('reapply',self.after)]:
   u.main(action);self.assertEqual({n:p.read_bytes()for n,p in self.targets.items()},data);self.assertTrue((self.state/(action+'-result.json')).exists())
  self.assertEqual(self.commands,['apply','rollback','reapply'])
 def test_duplicate_phase_never_repeats_restart(self):
  u.main('apply');self.assertRaisesRegex(ValueError,'existing_intent',u.main,'apply');self.assertEqual(self.commands,['apply'])
 def test_unknown_restart_preserves_intent_and_requires_reconciliation(self):
  with patch.object(u,'reload',side_effect=TimeoutError):self.assertRaises(TimeoutError,u.main,'apply')
  self.assertTrue((self.state/'apply-intent.json').exists());self.assertFalse((self.state/'apply-result.json').exists());self.assertRaisesRegex(ValueError,'existing_intent',u.main,'apply')
 def test_external_edit_blocks_rollback_before_effect(self):
  u.main('apply');self.targets['kia_model.cjs'].write_bytes(b'outside');self.assertRaisesRegex(ValueError,'target_baseline_changed',u.main,'rollback');self.assertFalse((self.state/'rollback-intent.json').exists());self.assertEqual(self.commands,['apply'])
 def test_corrupt_last_backup_blocks_all_rollback_writes(self):
  u.main('apply');(self.state/'before/repair-policy.json').write_bytes(b'corrupt');self.assertRaisesRegex(ValueError,'backup_changed',u.main,'rollback');self.assertFalse((self.state/'rollback-intent.json').exists());self.assertEqual({n:p.read_bytes()for n,p in self.targets.items()},self.after)
 def test_failed_diagnostics_prevents_production_edits(self):
  with patch.object(u,'diagnostic_manager',return_value={'ActiveState':'failed','MainPID':'0'}):self.assertRaisesRegex(ValueError,'diagnostics_state_unconfirmed',u.main,'apply')
  self.assertFalse(self.state.exists())
 def test_normal_idle_sidecar_can_load_sources_without_household_restart(self):
  with patch.object(u,'diagnostic_manager',return_value={'ActiveState':'inactive','MainPID':'0'}):u.main('apply')
  self.assertEqual(self.commands,['apply']);self.assertTrue((self.state/'apply-result.json').exists())
 def test_failed_socket_prevents_production_edits(self):
  with patch.object(u,'command',side_effect=ValueError('fixed_command_unconfirmed')):self.assertRaisesRegex(ValueError,'fixed_command_unconfirmed',u.main,'apply')
  self.assertFalse(self.state.exists())
 def test_expired_authority_prevents_mutation(self):
  with patch.object(u.time,'time',return_value=u.EXPIRY):self.assertRaisesRegex(ValueError,'valid_root_authority',u.main,'apply')
  self.assertFalse(self.state.exists())
 def test_partial_write_outcome_cannot_be_replayed_or_rolled_back_as_confirmed(self):
  def put(h,p,b,*args):
   if p==self.targets['kia_model.cjs']:raise OSError('synthetic partial write')
   p.write_bytes(b)
  with patch.object(u,'put',side_effect=put):self.assertRaises(OSError,u.main,'apply')
  self.assertTrue((self.state/'apply-intent.json').exists());self.assertFalse((self.state/'apply-result.json').exists());self.assertRaisesRegex(ValueError,'existing_intent',u.main,'apply');self.assertRaisesRegex(ValueError,'application_unconfirmed',u.main,'rollback');self.assertFalse(self.commands)
if __name__=='__main__':unittest.main()
