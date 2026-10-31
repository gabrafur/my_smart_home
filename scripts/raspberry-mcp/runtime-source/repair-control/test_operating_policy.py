"""Pure synthetic policy tests; no Root/runtime/network/services or DB files."""
import contextlib
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest import mock

SPEC=importlib.util.spec_from_file_location('current_operating_policy',Path(__file__).with_name('health_summary.py'))
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
NOW=1793390000
AT=dt.datetime.fromtimestamp(NOW,dt.timezone.utc).isoformat()
TOOLS=['host_diagnostics','service_diagnostics','log_summary','backup_results','disk_space',
 'codex_task_list','codex_task_status','codex_task_create','codex_task_send','codex_task_reconcile',
 'project_files','project_read','project_prepare_edit','change_validate','operation_status','change_revert','admin_action_apply']

def facts():
 return dict(source='existing_task_policy_and_readonly_shared_ledgers',observed_at=AT,age_seconds=0,
  state='observed',collection_error=None,configured=True,admission_active=True,revoked=False,
  expires_at=NOW+3600,maximum_shared_sends_per_24h=48,minimum_spacing_seconds=60,
  shared_sends_last_24h=1,remaining_sends=47,spacing_ready=True,unresolved_dispatches=0,
  terminal_unreconciled=0,task_reservations=0,administrative_tasks=1,
  workspace_configured=True,workspace_admission_active=True,workspace_tasks=1,
  administrative_expires_at=NOW+3600)

def data():
 return dict(tool_names=TOOLS,tool_catalogue_source='actual_frontend_descriptors_not_authorization',
  administrative_delegation=dict(configured=True,admission_active=True),
  storage_maintenance_catalogue=dict(current_admission=dict(source='sealed_root_storage_policy_and_revocation_state',
   observed_at=AT,age_seconds=0,collection_error=None,execution_active=True,restore_active=True,
   expires_at=None,recurring_execution_enabled=False,interface_confirmations_required=True)))

def actions(policy):
 return {x['id']:x for x in policy['actions']}


class OperatingPolicy(unittest.TestCase):
 def project(self,d=None,f=None):return m.operating_policy_v1(data()if d is None else d,facts()if f is None else f,NOW)

 def test_configured_and_tools_cannot_override_actual_closed_admission(self):
  f=facts();f['admission_active']=False
  out=actions(self.project(f=f))
  self.assertEqual(out['prepare_scoped_administrative_task']['state'],'blocked')
  self.assertEqual(out['execute_existing_scoped_task']['state'],'blocked')
  self.assertFalse(any(x['state']=='ready'for x in out.values()if x['role']in('privileged_task','effect','storage_effect')))
  self.assertEqual(out['diagnose_host']['state'],'ready')

 def test_ready_is_existing_preflight_opportunity_and_no_new_parameters(self):
  out=self.project();a=actions(out)['execute_existing_scoped_task']
  self.assertEqual(a['state'],'ready');self.assertTrue(a['fresh_server_preflight_required'])
  self.assertTrue(a['standing_goal_scope_required']);self.assertFalse(a['scope_or_permission_override_supported'])
  self.assertFalse(out['completion']['full_goal_complete'])
  self.assertTrue(out['client_or_model_identity_is_not_authority'])

 def test_workspace_opportunity_does_not_reopen_expired_administration(self):
  f=facts();f.update(admission_active=False,administrative_expires_at=NOW-1)
  d=data();d['administrative_delegation']['admission_active']=False
  out=self.project(d=d,f=f);a=actions(out)
  self.assertEqual(a['prepare_workspace_task']['state'],'ready')
  self.assertEqual(a['execute_existing_workspace_task']['state'],'ready')
  self.assertEqual(a['execute_existing_scoped_task']['state'],'blocked')
  self.assertFalse(out['authority']['admission_active'])
  self.assertTrue(out['authority']['workspace_admission_active'])
  self.assertEqual(out['authority']['administrative_expires_at'],NOW-1)
  self.assertEqual(a['execute_existing_workspace_task']['fixed_profile'],'workspace_write_no_network_no_sudo')

 def test_workspace_cannot_bypass_shared_ledger_clock_or_revocation_gates(self):
  for change in [dict(workspace_admission_active=False),dict(workspace_configured=None),
   dict(expires_at=NOW),dict(revoked=True),dict(remaining_sends=0),dict(spacing_ready=False),
   dict(unresolved_dispatches=1),dict(terminal_unreconciled=1),dict(workspace_tasks=0),
   dict(observed_at=dt.datetime.fromtimestamp(NOW-121,dt.timezone.utc).isoformat())]:
   with self.subTest(change=change):
    f=facts();f.update(change)
    self.assertNotEqual(actions(self.project(f=f))['execute_existing_workspace_task']['state'],'ready')

 def test_expiry_revocation_budget_and_spacing_are_preserved(self):
  for field,value in [('expires_at',NOW),('revoked',True),('remaining_sends',0),('spacing_ready',False),('collection_error','unavailable')]:
   f=facts();f[field]=value
   with self.subTest(field=field):
    self.assertNotEqual(actions(self.project(f=f))['execute_existing_scoped_task']['state'],'ready')
  authority=self.project()['authority']
  self.assertEqual(authority['maximum_shared_sends_per_24h'],48)
  self.assertEqual(authority['minimum_spacing_seconds'],60)
  self.assertEqual(authority['expires_at'],NOW+3600)

 def test_uncertain_and_running_work_never_resend(self):
  f=facts();f['unresolved_dispatches']=1;out=self.project(f=f);a=actions(out)
  self.assertEqual(a['execute_existing_scoped_task']['state'],'blocked')
  self.assertEqual(a['acknowledge_terminal_task']['state'],'blocked')
  self.assertEqual(out['workflows']['operation_uncertain'],['observe_operation','observe_task','observe_tasks'])
  self.assertFalse(any(x['automatic_retry']for x in a.values()))

 def test_pending_OTP_blocks_only_dependent_effect_and_preserves_user_step(self):
  d=data();d['authentication_pending_user_action']=True
  out=self.project(d=d)
  self.assertEqual(actions(out)['execute_authentication_dependent_task']['state'],'blocked')
  self.assertEqual(actions(out)['execute_existing_scoped_task']['state'],'ready')
  self.assertEqual(out['authentication']['state'],'pending_user_action')
  self.assertEqual(out['authentication']['functional_health'],'unknown')
  self.assertFalse(out['authentication']['unrelated_maintenance_blocked'])
  self.assertIn('wait_for_user',out['control']['pending_OTP'])

 def test_header_describes_observed_contract_not_action_or_authentication_health(self):
  out=self.project()
  self.assertEqual(out['age_seconds'],0);self.assertEqual(out['state'],'observed');self.assertIsNone(out['collection_error'])
  self.assertEqual(out['authentication']['state'],'unknown');self.assertEqual(out['authentication']['functional_health'],'unknown')
  self.assertEqual(actions(out)['execute_authentication_dependent_task']['state'],'blocked')

 def test_canonical_waiting_user_phase_is_recognized_without_new_producer(self):
  d=data();d['icloud_readiness']={'loaded':{'state':'observed','entry_phase':'entry_waiting_user'}}
  self.assertEqual(self.project(d=d)['authentication']['state'],'pending_user_action')

 def test_storage_until_revoked_is_independent_and_confirmation_never_suppressed(self):
  f=facts();f['admission_active']=False;out=self.project(f=f);a=actions(out)
  self.assertEqual(a['storage_plan_npm_logs']['state'],'ready')
  for key in ['storage_quarantine_npm_logs','storage_restore_npm_logs']:
   self.assertEqual(a[key]['state'],'requires_confirmation');self.assertTrue(a[key]['interface_confirmation_required'])
  self.assertIsNone(out['authority']['storage_expires_at'])
  self.assertFalse(out['authority']['storage_recurring_execution_enabled'])
  self.assertFalse(out['control']['new_schedule_enabled'])

 def test_storage_unknown_or_revoked_never_becomes_ready(self):
  for field,value in [('execution_active',False),('collection_error','unavailable'),('expires_at',NOW),('recurring_execution_enabled',True)]:
   d=data();d['storage_maintenance_catalogue']['current_admission'][field]=value
   self.assertEqual(actions(self.project(d=d))['storage_quarantine_npm_logs']['state'],'blocked')

 def test_protected_data_has_no_delete_route_or_automatic_recurrence(self):
  out=self.project();a=actions(out)
  self.assertEqual(a['delete_protected_data']['state'],'unsupported');self.assertIsNone(a['delete_protected_data']['tool'])
  self.assertEqual(a['turn_on_recurrence']['state'],'requires_confirmation')
  for item in a.values():self.assertNotIn('command',item);self.assertNotIn('path',item);self.assertNotIn('prompt',item)

 def test_unknown_and_stale_evidence_cannot_admit_effects(self):
  for value in (None,{},dict(facts(),state='unknown',terminal_unreconciled=None,task_reservations=None),dict(facts(),observed_at=dt.datetime.fromtimestamp(NOW-121,dt.timezone.utc).isoformat())):
   self.assertEqual(actions(self.project(f=value if value is not None else {}))['execute_existing_scoped_task']['state'],'blocked')

 def test_backend_catalogue_requires_actual_frontend_check(self):
  d=data();d.pop('tool_catalogue_source');a=actions(self.project(d=d))['execute_existing_scoped_task']
  self.assertEqual(a['state'],'blocked');self.assertEqual(a['admission_state'],'ready')

 def test_missing_tool_is_unsupported_not_implicitly_granted(self):
  d=data();d['tool_names']=[]
  self.assertEqual(actions(self.project(d=d))['execute_existing_scoped_task']['state'],'unsupported')

 def test_input_immutability_and_untrusted_source_fields_not_exported(self):
  d=data();f=facts();before=copy.deepcopy((d,f));self.project(d,f);self.assertEqual((d,f),before)
  f['expires_at']='PRIVATE_SENTINEL';f['source']='PRIVATE_SENTINEL'
  text=json.dumps(self.project(d,f));self.assertNotIn('PRIVATE_SENTINEL',text)


class ReadonlySnapshot(unittest.TestCase):
 def test_snapshot_uses_existing_policy_and_readonly_SQL_not_store_or_RPC(self):
  state=mock.MagicMock();(state/'revoked').exists.return_value=False
  policy=dict(enabled=True,expires_at=NOW+100,max_sends_per_24h=48,minimum_spacing_seconds=60,
              admin_delegation=dict(task_key_prefix='approved-admin-',enabled=True,expires_at=NOW+50))
  tasks=types.SimpleNamespace(STATE=state,LEGACY_DB=Path('/synthetic/legacy.sqlite3'),UID=1001,ADMIN_DELEGATION=policy['admin_delegation'],
   locked=mock.Mock(return_value=contextlib.nullcontext()),policy=mock.Mock(return_value=(policy,{})),
   read=mock.Mock(),legacy_summary=mock.Mock(return_value={'busy':0,'count':2,'latest':NOW-61}))
  connection=mock.MagicMock()
  # PRAGMA, BEGIN then eight fixed aggregate SELECTs, including workspace tasks.
  values=iter([(1,),(NOW-61,),(0,),(0,),(0,),(0,),(1,),(2,)])
  def execute(sql,*args):
   cursor=mock.Mock()
   if sql.startswith('SELECT'):cursor.fetchone.return_value=next(values)
   return cursor
  connection.execute.side_effect=execute
  with mock.patch('sqlite3.connect',return_value=connection)as connect,mock.patch('os.path.lexists',return_value=False):
   result=m.operating_admission_snapshot(tasks,object(),NOW)
  self.assertEqual(result['state'],'observed');self.assertEqual(result['shared_sends_last_24h'],3)
  self.assertEqual(result['remaining_sends'],45);tasks.locked.assert_called_once_with(read_only=True)
  self.assertTrue(result['workspace_admission_active']);self.assertTrue(result['admission_active'])
  self.assertEqual(result['workspace_tasks'],2)
  self.assertIn('?mode=ro',connect.call_args.args[0]);self.assertTrue(connect.call_args.kwargs['uri'])
  statements=[call.args[0]for call in connection.execute.call_args_list]
  self.assertTrue(all(sql.startswith(('SELECT','PRAGMA query_only=ON','BEGIN'))for sql in statements))


if __name__=='__main__':unittest.main()
