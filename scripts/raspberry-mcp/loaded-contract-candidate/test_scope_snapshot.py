import copy,datetime,importlib.util,json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('contract_snapshot_model',Path(__file__).with_name('loaded_contract.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NOW=1800000000.0
AT=datetime.datetime.fromtimestamp(NOW-5,datetime.timezone.utc).isoformat()
SECRET='PRIVATE_DIAGNOSTIC_SENTINEL'

class ScopeSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.scope={'schema_version':1,'enabled':True,'issued_at':NOW-60,'expires_at':NOW+600,'operation_id':'a'*32,'release_revision':'b'*64}
        self.request={'operation_id':'a'*32,'release_revision':'b'*64,'schema_version':1}
        facts={role:{**{k:True for k in m.FIELDS},'collection_error':None}for role in m.ROLES}
        self.bindings=m.project(facts)
        self.container={'icloud_refresh_diagnostics':{m.ROLES[0]:{'stage':'provider_refresh','outcome':'error','observed_at':AT,'exception_class':'PyiCloudServiceUnavailable'}}}
    def test_scope_binds_current_nonce_release_and_time(self):
        self.assertTrue(m.scope_allowed(self.scope,self.request,NOW))
        for key,value in [('operation_id','c'*32),('release_revision','c'*64),('expires_at',NOW),('issued_at',NOW+1),('enabled',False),('schema_version',True)]:
            row={**self.scope,key:value}
            self.assertFalse(m.scope_allowed(row,self.request,NOW))
    def test_scope_rejects_unbounded_duration_and_bad_numeric_types(self):
        self.assertFalse(m.scope_allowed({**self.scope,'expires_at':NOW+86401},self.request,NOW))
        for v in (True,float('nan'),float('inf'),SECRET):
            self.assertFalse(m.scope_allowed({**self.scope,'expires_at':v},self.request,NOW))
            self.assertFalse(m.scope_allowed(self.scope,self.request,v))
    def test_natural_error_is_class_only_and_not_a_diagnostic_call(self):
        value=m.snapshot(self.bindings,self.container,'d'*64,NOW)
        row=value['latest_attempts'][0]
        self.assertEqual(row['exception_class'],'PyiCloudServiceUnavailable');self.assertEqual(row['age_seconds'],5)
        self.assertTrue(row['historical_attempt_only']);self.assertFalse(value['diagnostic_calls_executed']);self.assertFalse(value['functional_recovery_proven'])
    def test_missing_attempt_is_unobserved_not_success(self):
        value=m.snapshot(self.bindings,None,'d'*64,NOW)
        self.assertTrue(all(row['state']=='not_observed' and row['outcome']is None for row in value['latest_attempts']))
    def test_unknown_error_text_and_extra_private_fields_are_withheld(self):
        for change in ({'exception_class':SECRET},{'message':SECRET},{'observed_at':SECRET}):
            container=copy.deepcopy(self.container);container['icloud_refresh_diagnostics'][m.ROLES[0]].update(change)
            value=m.snapshot(self.bindings,container,'d'*64,NOW)
            self.assertEqual(value['latest_attempts'][0]['state'],'unknown');self.assertNotIn(SECRET,json.dumps(value))
    def test_future_and_naive_timestamps_remain_unknown(self):
        for at in (datetime.datetime.fromtimestamp(NOW+1,datetime.timezone.utc).isoformat(),'2027-01-15T08:00:00'):
            c=copy.deepcopy(self.container);c['icloud_refresh_diagnostics'][m.ROLES[0]]['observed_at']=at
            self.assertEqual(m.attempt_rows(c,NOW)[0]['state'],'unknown')
    def test_completed_downstream_is_historical_attempt_not_global_health(self):
        c=copy.deepcopy(self.container);c['icloud_refresh_diagnostics'][m.ROLES[0]].update(stage='downstream_call',outcome='completed',exception_class=None)
        v=m.snapshot(self.bindings,c,'d'*64,NOW);self.assertEqual(v['latest_attempts'][0]['outcome'],'completed');self.assertFalse(v['functional_recovery_proven'])
    def test_validator_recomputes_attempt_age(self):
        value=m.snapshot(self.bindings,self.container,'d'*64,NOW)
        clean=m.validate_snapshot(value,NOW+10)
        self.assertIsNotNone(clean);self.assertEqual(clean['latest_attempts'][0]['age_seconds'],15)
    def test_validator_refuses_private_fields_or_execution_claims(self):
        value=m.snapshot(self.bindings,self.container,'d'*64,NOW)
        for key,v in [('raw_message',SECRET),('diagnostic_calls_executed',True),('functional_recovery_proven',True)]:
            row={**value,key:v};self.assertIsNone(m.validate_snapshot(row,NOW))
    def test_validator_rejects_role_reordering_or_bool_schema(self):
        value=m.snapshot(self.bindings,self.container,'d'*64,NOW)
        row=copy.deepcopy(value);row['latest_attempts'].reverse();self.assertIsNone(m.validate_snapshot(row,NOW))
        row=copy.deepcopy(value);row['schema_version']=True;self.assertIsNone(m.validate_snapshot(row,NOW))
    def test_unknown_contract_roundtrips_without_inventing_data(self):
        value=m.snapshot(m.project(m.unknown('scope_inactive')),None,None,NOW)
        self.assertEqual(m.validate_snapshot(value,NOW),value)
