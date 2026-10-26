import copy,hashlib,importlib.util,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import heartbeat_effect as h
from heartbeat_files import FixedHeartbeatSources,HeartbeatJournal
from static_code_identity import SourceCodeIdentity
spec=importlib.util.spec_from_file_location('trusted_native_fingerprint',(Path(__file__).resolve().parent.parent/'runtime-source/host-heartbeat/loaded_identity.py'));native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
class Clock:
 def __init__(self):self.value=100
 def wall(self):return self.value+1000
 def mono(self):return self.value
 def sleep(self,n):self.value+=n
class Effect(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);self.code=self.base/'code';self.code.mkdir(mode=0o700);self.state=self.base/'journal';self.state.mkdir(mode=0o700);self.clock=Clock();self.compiler=SourceCodeIdentity(native.fingerprint)
  self.before={name:b'def sample():\n return 1\n'for name in h.SOURCE_FILES}
  for name,raw in self.before.items():p=self.code/name;p.write_bytes(raw);p.chmod(0o644)
  self.after={**self.before,'heartbeat.py':b'def sample():\n return 2\n'};self.old=self.identity(self.before);self.new=self.identity(self.after)
  self.prepared={'operation_id':'a'*32,'task_id':'b'*32,'principal_sha256':'c'*64,'component_id':'external_heartbeat','action':'apply','before_sha256':self.old,'after_sha256':self.new,'artifact_id':'d'*32,'before_source_set_sha256':h.source_set(self.before),'before_source_sha256':h.sha(self.before['heartbeat.py']),'after_source_sha256':h.sha(self.after['heartbeat.py']),'candidate_source':self.after['heartbeat.py'].decode()};self.tree=FixedHeartbeatSources(self.code,os.getuid(),self.clock.wall,self.clock.mono);self.store=HeartbeatJournal(self.state,os.getuid());self.observations=0;self.success=True
 def tearDown(self):self.tmp.cleanup()
 def identity(self,s):return self.compiler.compile({n.removesuffix('.py'):v for n,v in s.items()if n!='heartbeat-entrypoint.py'})['expected_code_sha256']
 def observe(self):
  self.observations+=1;loaded=self.new if self.success and self.observations>1 else self.old
  return {'component_id':'external_heartbeat','root_verified':True,'collection_error':None,'native_invocation_verified':True,'critical_bindings_valid':True,'loaded_sha256':loaded,'observed_monotonic':self.clock.mono(),'invocation_started_monotonic':self.clock.mono(),'boot_id_sha256':'e'*64}
 def admit(self,b):return {**b,'identity_kind':'python_code_objects_v1',**{k:True for k in ('registered_task','reviewed_candidate','principal_matches','shared_budget_reserved','global_admin_idle','resources_available','maintenance_lock_held')},'observed_at':self.clock.wall(),'expires_at':self.clock.wall()+1000}
 def worker(self,observe=None,admit=None):return h.HeartbeatWorker(self.tree,self.store,self.compiler,{'d'*32:'heartbeat.py','f'*32:'loaded_identity.py'},admit or self.admit,observe or self.observe,self.clock.wall,self.clock.mono,self.clock.sleep,timeout=4)
 def test_apply_waits_for_native_and_duplicate_never_writes(self):
  worker=self.worker();result=worker.run(self.prepared);self.assertEqual(result['state'],'applied');self.assertTrue(result['natural_native_load_verified']);self.assertFalse(result['functional_recovery_proven']);self.assertEqual((self.code/'heartbeat.py').read_bytes(),self.after['heartbeat.py'])
  with patch.object(self.tree,'replace',side_effect=AssertionError('duplicate write')):self.assertTrue(worker.run(self.prepared)['duplicate'])
  self.assertEqual(len(list((self.state/('a'*32+'-apply')).glob('receipt-*.json'))),2)
 def test_missing_native_confirmation_reconciles_after_restart_without_write(self):
  self.success=False;worker=self.worker();first=worker.run(self.prepared);self.assertEqual(first['state'],'source_written_runtime_unconfirmed');self.assertFalse(first['executor_terminal']);self.success=True
  restarted=self.worker();restarted.store=HeartbeatJournal(self.state,os.getuid())
  with patch.object(self.tree,'replace',side_effect=AssertionError('replay')):after=restarted.reconcile(h.binding_from(self.prepared))
  self.assertEqual(after['state'],'applied');self.assertTrue(after['reconciled_without_source_write'])
 def test_uncertain_after_atomic_replace_can_be_observed_without_replay(self):
  original=os.replace
  def interrupted(src,dst):original(src,dst);raise OSError('synthetic interruption after replace')
  with patch('heartbeat_files.os.replace',side_effect=interrupted):result=self.worker().run(self.prepared)
  self.assertEqual(result['state'],'uncertain');self.assertEqual((self.code/'heartbeat.py').read_bytes(),self.after['heartbeat.py'])
  with patch.object(self.tree,'replace',side_effect=AssertionError('replay')):result=self.worker().reconcile(h.binding_from(self.prepared))
  self.assertEqual(result['state'],'applied');self.assertIn('lower_bound',result['effect_time_semantics'])
 def test_wrong_version_instrumentation_or_outer_scope_refused_without_write(self):
  for change in [lambda p:p.update(before_sha256='0'*64),lambda p:p.update(artifact_id='f'*32),lambda p:p.update(candidate_source='CHANGED=2\ndef sample():return 2\n')]:
   with self.subTest(change=change):
    p=copy.deepcopy(self.prepared);p['operation_id']=hashlib.sha256(str(change).encode()).hexdigest()[:32];change(p)
    with patch.object(self.tree,'replace',side_effect=AssertionError('unauthorized write')):result=self.worker().run(p)
    self.assertTrue(result['definitive_no_effect']);self.assertEqual(result['state'],'rejected_without_effect')
 def test_unverified_boolean_admission_is_not_permission(self):
  with patch.object(self.tree,'replace',side_effect=AssertionError('write')):result=self.worker(admit=lambda b:True).run(self.prepared)
  self.assertTrue(result['definitive_no_effect'])
 def test_old_invocation_or_boot_cannot_confirm_new_code(self):
  self.success=False;worker=self.worker();worker.run(self.prepared);self.success=True
  for change in [lambda p:p.update(invocation_started_monotonic=99),lambda p:p.update(boot_id_sha256='f'*64),lambda p:p.update(root_verified=False)]:
   def observe():r=self.observe();change(r);return r
   result=self.worker(observe=observe).reconcile(h.binding_from(self.prepared));self.assertEqual(result['state'],'source_written_runtime_unconfirmed')
 def test_atomic_compare_replace_rejects_concurrent_source_change(self):
  (self.code/'webhook.py').write_text('def sample():return 3\n')
  with self.assertRaisesRegex(ValueError,'compare_replace_conflict'):self.tree.replace('heartbeat.py',self.after['heartbeat.py'],self.before,'a'*32,'apply',lambda:None)
  self.assertEqual((self.code/'heartbeat.py').read_bytes(),self.before['heartbeat.py'])
 def test_explicit_rollback_restores_backup_and_never_claims_recovery(self):
  self.worker().run(self.prepared);backup=self.store.backup(h.binding_from(self.prepared));old_source=backup['before_sources']['heartbeat.py'];rollback={**self.prepared,'action':'rollback','before_sha256':self.new,'after_sha256':self.old,'before_source_set_sha256':h.source_set(self.after),'before_source_sha256':h.sha(self.after['heartbeat.py']),'after_source_sha256':h.sha(old_source.encode()),'candidate_source':old_source};calls=0
  def observe():
   nonlocal calls
   calls+=1;r=self.observe();r['loaded_sha256']=self.new if calls==1 else self.old;return r
  result=self.worker(observe=observe).run(rollback);self.assertEqual(result['state'],'applied');self.assertFalse(result['functional_recovery_proven']);self.assertEqual((self.code/'heartbeat.py').read_text(),old_source)
  with patch.object(self.tree,'replace',side_effect=AssertionError('rollback replay')):self.assertTrue(self.worker(observe=observe).run(rollback)['duplicate'])
 def test_last_admission_after_staging_refuses_replace_without_effect(self):
  calls=0
  def gate(b):
   nonlocal calls
   calls+=1
   if calls==3:raise ValueError('synthetic admission withdrawn')
   return self.admit(b)
  result=self.worker(admit=gate).run(self.prepared);self.assertTrue(result['definitive_no_effect']);self.assertTrue(result['security_cleanup_confirmed']);self.assertEqual((self.code/'heartbeat.py').read_bytes(),self.before['heartbeat.py']);self.assertFalse(list(self.code.glob('.*.component-*')))
if __name__=='__main__':unittest.main()
