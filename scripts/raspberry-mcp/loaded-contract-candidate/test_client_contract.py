import copy,datetime,importlib.util,json
from pathlib import Path
import unittest
P=Path(__file__).parent
spec=importlib.util.spec_from_file_location('contract_root_test_fixture',P/'test_root_contract_view.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
spec=importlib.util.spec_from_file_location('candidate_readiness_client',P/'root-candidate/readiness_client.py');client=importlib.util.module_from_spec(spec);spec.loader.exec_module(client)

class ClientContractTest(unittest.TestCase):
    def setUp(self):
        self.base=fixture.Cases();self.base.setUp();self.now=self.base.now
    def value(self):return self.base.result()
    def test_actual_root_shape_passes_independent_client_projection(self):
        value=client.project(self.value(),self.now+1);self.assertEqual(value['state'],'observed');self.assertEqual(value['native_contract']['age_seconds'],1)
    def test_old_native_schema_keeps_explicit_unknown(self):
        self.base.proof['schema_version']=1
        value=client.project(self.value(),self.now);self.assertEqual(value['state'],'unknown');self.assertEqual(value['native_contract']['collection_error'],'native_contract_unconfirmed')
    def test_extra_top_level_data_and_execution_claims_fail_closed(self):
        for change in ({'private':'PRIVATE_SENTINEL'},{'functional_recovery_proven':True}):
            value=self.value();value.update(change);clean=client.project(value,self.now);self.assertEqual(clean['state'],'unknown');self.assertIsNone(clean['native_contract']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(clean))
    def test_private_role_fields_are_withheld(self):
        value=self.value();value['native_contract']['data']['bindings']['roles'][0]['account']='PRIVATE_SENTINEL'
        clean=client.project(value,self.now);self.assertIsNone(clean['native_contract']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(clean))
    def test_attempt_age_is_recomputed_and_still_historical(self):
        at=datetime.datetime.fromtimestamp(self.now-11,datetime.timezone.utc).isoformat()
        data={'icloud_refresh_diagnostics':{fixture.model.ROLES[0]:{'stage':'provider_refresh','outcome':'error','observed_at':at,'exception_class':'PyiCloudServiceUnavailable'}}}
        self.base.proof['native_contract']=fixture.model.snapshot(self.base.proof['native_contract']['bindings'],data,self.base.setup_sha,self.now)
        clean=client.project(self.value(),self.now+2);row=clean['native_contract']['data']['latest_attempts'][0]
        self.assertEqual(row['age_seconds'],13);self.assertTrue(row['historical_attempt_only']);self.assertFalse(clean['functional_recovery_proven'])
    def test_service_collection_failure_preserves_historical_success(self):
        self.base.service.update(state='unknown',collection_error='transport_unconfirmed',registered=None)
        value=client.project(self.value(),self.now);self.assertEqual(value['state'],'unknown');self.assertTrue(value['service_registration']['last_success']['historical_not_current'])
    def test_stale_root_reply_is_refused(self):
        clean=client.project(self.value(),self.now+11);self.assertEqual(clean['collection_error'],'root_readiness_unavailable');self.assertIsNone(clean['native_contract'])
    def test_duplicate_role_or_native_success_claim_is_refused(self):
        value=self.value();value['native_contract']['data']['latest_attempts'][1]['role']=fixture.model.ROLES[0]
        self.assertIsNone(client.project(value,self.now)['native_contract'])
        value=self.value();value['native_contract']['data']['functional_recovery_proven']=True
        self.assertIsNone(client.project(value,self.now)['native_contract'])
