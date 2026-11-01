"""Synthetic core only. No Docker, systemd, network ACL or Root calls."""
import copy,importlib.util,json,sys,threading,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('binding_candidate',Path(__file__).with_name('controller.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def policy():
 return {'enabled':True,'recurring_execution_enabled':False,'target_kind':'fixed_compose_nodered_service_on_existing_listener','network_id':'3'*64,'network_name':'docker_default','subnet':'192.0.2.0/24','base_allow':['127.0.0.0/8','::1/128','198.51.100.1/32'],'seed_peers':['192.0.2.7'],'unit_hashes':['4'*64]}

class Store:
 def __init__(self):self.rows={};self.events=[];self.mutex=threading.Lock();self.is_revoked=False
 def lock(self):return self.mutex
 def revoked(self):return self.is_revoked
 def history(self):return copy.deepcopy(list(self.rows.values()))
 def get(self,key):return copy.deepcopy(self.rows.get(key))
 def save(self,row):self.rows[row['id']]=copy.deepcopy(row);self.events.append(row['state'])

class Manager:
 def __init__(self,store):
  self.store=store;self.writes=[];self.failure=False;self.lose_reply=False;self.safe=True
  p=policy();self.value={k:p[k]for k in ('network_id','network_name')};self.value.update(container_id='1'*64,image_id='2'*64,logical_service_verified=True)
  self.value.update(peer_ipv4='192.0.2.6',running=True,unit_sha256='4'*64,unit_active='inactive',deny_all=True,allowed=sorted(p['base_allow']+['192.0.2.7/32']))
 def headroom(self):return self.safe
 def inspect(self):return copy.deepcopy(self.value)
 def set_allow(self,expected,wanted):
  assert self.store.events[-1]in('apply_intent','restore_intent')
  assert m.networks(self.value['allowed'])==expected
  self.writes.append(copy.deepcopy(wanted))
  if not self.failure:self.value['allowed']=wanted
  if self.failure or self.lose_reply:raise TimeoutError('synthetic unknown outcome')

class BindingCore(unittest.TestCase):
 def setUp(self):
  self.now=100000.;self.store=Store();self.manager=Manager(self.store);self.controller=m.Controller(policy(),self.store,self.manager,lambda:self.now)
 def args(self,verb='plan',identifier='a'*32):return {'host':'raspberry','action':'nodered_'+verb+'_reader_binding','idempotency_key':'nodered-peer-'+identifier}
 def call(self,verb='plan',identifier='a'*32,tool='admin_action_apply'):return self.controller.request(tool,self.args(verb,identifier))
 def test_plan_is_private_dry_run_and_duplicate_keeps_identity(self):
  first=self.call();self.now+=1;second=self.call();self.assertEqual(first['operation_id'],second['operation_id']);self.assertEqual(second['age_seconds'],1)
  self.assertEqual(self.manager.writes,[]);self.assertEqual(len(self.store.rows),1);self.assertNotIn('192.0.2',json.dumps(first));self.assertNotIn('1'*64,json.dumps(first))
 def test_apply_persists_intent_changes_single_peer_without_restart(self):
  self.call();result=self.call('apply');self.assertEqual(result['state'],'applied');self.assertEqual(len(self.manager.writes),1)
  self.assertEqual(set(self.manager.writes[0])-set(policy()['base_allow']),{'192.0.2.6/32'});self.assertEqual(result['service_restarts'],0)
 def test_duplicate_apply_never_writes_again(self):
  self.call();self.call('apply');self.call('apply');self.assertEqual(len(self.manager.writes),1)
 def test_missing_plan_or_expiry_cannot_write(self):
  with self.assertRaises(m.Refused):self.call('apply')
  self.call();self.now+=901
  with self.assertRaises(m.Refused):self.call('apply')
  self.assertEqual(self.manager.writes,[])
 def test_changed_network_unit_or_unverified_logical_service_blocks_no_adoption(self):
  for key,value in [('logical_service_verified',False),('network_id','9'*64),('unit_sha256','9'*64),('running',False),('deny_all',False)]:
   original=copy.deepcopy(self.manager.value);self.manager.value[key]=value
   with self.subTest(key=key),self.assertRaises(m.Refused):self.call()
   self.manager.value=original
  self.assertEqual(self.store.rows,{})
 def test_unknown_extra_network_permission_and_peer_outside_boundary_block(self):
  for allowed in [self.manager.value['allowed']+['0.0.0.0/0'],policy()['base_allow']+['192.0.2.99/32']]:
   original=self.manager.value['allowed'];self.manager.value['allowed']=allowed
   with self.assertRaises(m.Refused):self.call()
   self.manager.value['allowed']=original
  self.manager.value['peer_ipv4']='8.8.8.8'
  with self.assertRaises(m.Refused):self.call()
 def test_no_change_is_no_effect(self):
  self.manager.value['peer_ipv4']='192.0.2.7';self.assertEqual(self.call()['state'],'no_change');self.call('apply');self.assertEqual(self.manager.writes,[])
 def test_active_reader_does_not_consume_intent(self):
  self.call();self.manager.value['unit_active']='active'
  with self.assertRaises(m.Refused):self.call('apply')
  self.assertEqual(self.store.get('a'*32)['state'],'planned');self.assertEqual(self.manager.writes,[])
 def test_foreign_change_since_plan_does_not_write(self):
  self.call();self.manager.value['peer_ipv4']='192.0.2.8'
  with self.assertRaises(m.Refused):self.call('apply')
  self.assertEqual(self.manager.writes,[])
 def test_lost_reply_preserves_one_intent_blocks_new_ids_and_reconcile_only_reads(self):
  self.call();self.manager.lose_reply=True;self.assertEqual(self.call('apply')['state'],'outcome_unknown');self.call('apply')
  with self.assertRaises(m.Refused):self.call(identifier='b'*32)
  self.assertEqual(self.call('apply',tool='admin_action_reconcile')['state'],'applied');self.assertEqual(len(self.manager.writes),1)
 def test_unknown_no_change_can_be_observed_but_never_automatically_retried(self):
  self.call();self.manager.failure=True;self.call('apply');self.assertEqual(self.call('apply',tool='admin_action_reconcile')['state'],'not_applied_observed');self.call('apply');self.assertEqual(len(self.manager.writes),1)
 def test_restore_uses_only_own_record_and_counts_both_writes(self):
  original=self.manager.value['allowed'];self.call();self.call('apply');self.now+=600;self.call('plan_restore');result=self.call('restore')
  self.assertEqual(result['state'],'restored');self.assertEqual(self.manager.value['allowed'],original);self.assertEqual(len(self.store.get('a'*32)['effects']),2);self.call('restore');self.assertEqual(len(self.manager.writes),2)
 def test_restore_refuses_external_permission_change(self):
  self.call();self.call('apply');self.now+=600;self.manager.value['allowed']=policy()['base_allow']+['192.0.2.7/32']
  with self.assertRaises(m.Refused):self.call('plan_restore')
  self.assertEqual(len(self.manager.writes),1)
 def test_budget_spacing_revocation_and_low_headroom_block_effects(self):
  self.call();self.manager.safe=False
  with self.assertRaises(m.Refused):self.call('apply')
  self.manager.safe=True;self.call('apply')
  with self.assertRaises(m.Refused):self.call('plan_restore')
  self.now+=600;self.store.is_revoked=True
  with self.assertRaises(m.Refused):self.call('plan_restore')
  self.assertEqual(self.call('apply',tool='admin_action_status')['state'],'applied')
 def test_four_write_budget_includes_restores_without_counter_reset(self):
  for identifier in ['a'*32,'b'*32]:
   self.manager.value['peer_ipv4']='192.0.2.6';self.call(identifier=identifier);self.call('apply',identifier);self.now+=600;self.call('plan_restore',identifier);self.call('restore',identifier);self.now+=600
  with self.assertRaisesRegex(m.Refused,'daily_budget'):self.call(identifier='c'*32)
  self.assertEqual(len(self.manager.writes),4)
 def test_status_clock_is_not_refreshed_and_reverse_clock_is_unknown(self):
  self.call();self.now+=50;status=self.call(tool='admin_action_status');self.assertEqual(status['age_seconds'],50)
  self.now-=100;status=self.call(tool='admin_action_status');self.assertIsNone(status['age_seconds']);self.assertEqual(status['collection_error'],'clock_order_unconfirmed')
 def test_paths_commands_peers_overrides_and_other_hosts_are_rejected(self):
  for extra in [{'path':'/tmp/free'},{'command':'anything'},{'peer':'192.0.2.6'},{'approved':True},{'host':'other'}]:
   args=self.args();args.update(extra)
   with self.subTest(extra=extra),self.assertRaises(m.Refused):self.controller.request('admin_action_apply',args)
  self.assertEqual(self.manager.writes,[])
 def test_restore_hours_later_requires_fresh_preview_without_refreshing_effect_age(self):
  self.call();self.call('apply');self.now+=3600
  self.assertEqual(self.call('restore')['required_before_restore'],'fresh_restore_plan');self.assertEqual(len(self.manager.writes),1)
  preview=self.call('plan_restore');self.assertTrue(preview['dry_run']);self.assertEqual(preview['age_seconds'],0);self.assertEqual(preview['effect_age_seconds'],3600)
  self.assertEqual(self.call('restore')['state'],'restored');self.assertEqual(len(self.manager.writes),2)
 def test_expired_restore_preview_cannot_write_and_reobservation_preserves_prior_preview(self):
  self.call();self.call('apply');self.now+=600;first=self.call('plan_restore');old=self.store.get('a'*32)['restore_previews'][0]
  self.now+=901
  with self.assertRaisesRegex(m.Refused,'restore_plan_expired'):self.call('restore')
  self.assertEqual(len(self.manager.writes),1);second=self.call('plan_restore');self.assertEqual(second['restore_preview_revision'],2)
  self.assertEqual(self.store.get('a'*32)['restore_previews'][0],old);self.assertEqual(self.call('restore')['state'],'restored')
 def test_restore_preview_checks_current_approved_revision_and_rejects_later_change(self):
  self.call();self.call('apply');self.now+=600;self.controller.policy['unit_hashes'].append('5'*64);self.manager.value['unit_sha256']='5'*64
  self.call('plan_restore');self.manager.value['unit_sha256']='4'*64
  with self.assertRaisesRegex(m.Refused,'changed_since_plan'):self.call('restore')
  self.assertEqual(len(self.manager.writes),1);self.now+=901;self.call('plan_restore');self.assertEqual(self.call('restore')['state'],'restored')
 def test_reconciliation_discloses_unknown_actor_instead_of_claiming_native_ack(self):
  self.call();self.manager.lose_reply=True;self.call('apply');result=self.call(tool='admin_action_reconcile')
  self.assertEqual(result['prior_uncertainty'],'outcome_unknown');self.assertEqual(result['effect_evidence'],'state_observed_after_uncertain_intent_actor_unconfirmed');self.assertEqual(len(self.manager.writes),1)
 def test_duplicate_restore_preview_reuses_clock_and_eight_preview_capacity_is_bounded(self):
  self.call();self.call('apply');self.now+=600
  for i in range(8):
   preview=self.call('plan_restore');self.now+=1;duplicate=self.call('plan_restore');self.assertEqual(duplicate['restore_preview_revision'],i+1);self.assertEqual(duplicate['age_seconds'],1);self.now+=900
  with self.assertRaisesRegex(m.Refused,'preview_capacity'):self.call('plan_restore')
  self.assertEqual(len(self.manager.writes),1)
 def test_confirmed_restore_preserves_earlier_uncertainty_and_its_own_ack_evidence(self):
  self.call();self.manager.lose_reply=True;self.call('apply');self.call(tool='admin_action_reconcile');self.manager.lose_reply=False;self.now+=600
  self.call('plan_restore');result=self.call('restore');self.assertEqual(result['state'],'restored');self.assertEqual(result['prior_uncertainty'],'outcome_unknown');self.assertEqual(result['effect_evidence'],'native_command_ack_and_postverification')
 def test_reviewed_logical_service_replacement_can_receive_new_preview(self):
  self.manager.value.update(container_id='f'*64,image_id='e'*64)
  self.assertEqual(self.call()['state'],'planned');self.assertEqual(self.call('apply')['state'],'applied')
 def test_instance_or_image_swap_after_preview_cannot_use_old_preview(self):
  self.call()
  for key in('container_id','image_id'):
   old=self.manager.value[key];self.manager.value[key]='f'*64
   with self.subTest(key=key),self.assertRaisesRegex(m.Refused,'instance_changed'):self.call('apply')
   self.manager.value[key]=old
  self.assertEqual(self.manager.writes,[])
 def test_old_effect_cannot_be_restored_on_replacement_instance(self):
  self.call();self.call('apply');self.now+=600;self.manager.value['container_id']='f'*64
  with self.assertRaisesRegex(m.Refused,'instance_changed_since_original'):self.call('plan_restore')
  self.assertEqual(len(self.manager.writes),1)
 def test_unknown_old_instance_cannot_be_reconciled_using_new_instance_observation(self):
  self.call();self.manager.lose_reply=True;self.call('apply');self.manager.value['container_id']='f'*64
  with self.assertRaisesRegex(m.Refused,'instance_changed_uncertain'):self.call(tool='admin_action_reconcile')
  self.assertEqual(self.store.get('a'*32)['state'],'outcome_unknown');self.assertEqual(len(self.manager.writes),1)
 def test_replacement_gets_new_operation_after_previous_success_without_erasing_history(self):
  self.call();self.call('apply');self.now+=600;self.manager.value.update(container_id='f'*64,image_id='e'*64,peer_ipv4='192.0.2.8')
  self.call(identifier='b'*32);self.assertEqual(self.call('apply',identifier='b'*32)['state'],'applied')
  self.assertEqual(len(self.manager.writes),2);self.assertEqual(len(self.store.rows),2)

if __name__=='__main__':unittest.main()
