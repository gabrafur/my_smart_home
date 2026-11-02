"""Synthetic guard tests. No real Root FS, API, proc or DB reads.
Principal runs serially; this child only prepared them.
"""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('private_native_guard', Path(__file__).with_name('native_guard.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeIO:
    def __init__(self):
        self.process_data = {'birth_ticks': 333, 'state': 'S', 'uids': [1000]*4,
                             'gids': [1000]*4, 'root_identity': [7,8], 'mountinfo_sha256': '4'*64}
        self.credential = 'a'*64
        self.ledger_data = {'task': {'tasks': [], 'sends': []},
                           'legacy': {'jobs': [], 'repair_receipts': []},
                           'component_jobs': {'jobs': [], 'phases': [], 'observations': [], 'meta':[{'version':1}]},
                           'component_workflow': {'operations': []}}
        self.locks_ok = True
    def prepare_proof_folder(self,operation_id,lease_id):
        m.need(m.identifier(operation_id) and m.identifier(lease_id),'fixed_proof_identity_required');return True
    def held_locks(self, ctx, expected):
        m.need(self.locks_ok and ctx['lock_fds'] == (10,11,12,13,14), 'kernel_exclusive_flock_not_owned')
        return list(expected.values())
    def process(self, pid):
        m.need(pid == 222, 'fixed_fake_pid_required')
        return copy.deepcopy(self.process_data)
    def runtime_file(self, pid, path, maximum):
        m.need(pid == 222 and path in m.RUNTIME_FILES, 'fixed_fake_file_required')
        value = self.credential if path.endswith('flows_cred.json') else ('3'*64 if path.endswith('settings.js') else '2'*64)
        return {'sha256':value,'bytes':32,'device':7,'inode':9,'uid':1000,'gid':1000,
                'mode':0o600,'root_identity':[7,8], 'fixed_relative_path_sha256':hashlib.sha256(path.encode()).hexdigest(),
                'descendants_no_symlinks':True}
    def existing_executor(self, ctx, identities, hashes, sealed_read):
        return {'snapshot_sha256':'f'*64,'coverage':['legacy_admin_executor','deployment_journal_and_immutable_corrections','durable_jobs'],
                'registered_existing_executors_idle':True,'private_rows_exported':False}
    def ledger(self, name, expected):
        return copy.deepcopy(self.ledger_data[name])


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.now=100.0
        self.io=FakeIO()
        self.files={}
        self.ctx={'lock_lease_id':'1'*32,'executing_pid':111,'locks_acquired_at':99.0,
                  'lock_fds':(10,11,12,13,14),'lock_identities':{p:[1,2,0,0,0o600] for p in m.LOCKS}}
        activation={'schema_version':1,'core_version':'5.0.9','pid':222,'birth_ticks':333,
                    'uid':1000,'gid':1000,'root_identity':[7,8],'mountinfo_sha256':'4'*64,
                    'image_digest':'sha256:'+'5'*64,'core_sha256':{p:'2'*64 for p in m.CORE_FILES},
                    'settings_sha256':'3'*64,'runtime_file_owners':{p:[1000,1000] for p in m.RUNTIME_FILES},'context_store_modules':{'default':'memoryOnly','memoryOnly':'memory','persistent':'localfilesystem'}}
        review={'schema_version':1,'core_version':'5.0.9','core_sha256':activation['core_sha256'],
                'settings_sha256':activation['settings_sha256'],'context_store_modules':activation['context_store_modules'],
                'checks':sorted(m.CHECKS),'isolated_exit_code':0,'isolated_evidence_sha256':'6'*64,
                'reviewed_effects_require_exact_admission':True}
        evidence={'schema_version':1,'core_version':'5.0.9','passed':True,'core_sha256':activation['core_sha256'],
                  'cases':[{'name':name,'passed':True} for name in sorted(m.CORE_CASES)],
                  'coverage':['actual_core_module_exports','in_memory_io_stubs','synthetic_ids_only','fake_persistent_store'],
                  'proves_full_runtime_deploy':False,'proves_real_store_flush':False,
                  'proves_context_value_equality':False,'proves_contrib_finalize_safety':False,
                  'logical_disable_restore_core_semantics_only':True}
        self.files[m.EVIDENCE]=m.raw(evidence)
        review['isolated_evidence_sha256']=hashlib.sha256(self.files[m.EVIDENCE]).hexdigest()
        self.files[m.SOURCE]=b'synthetic_source_never_executed'
        self.files[m.ACTIVATION]=m.raw(activation)
        self.files[m.REVIEW]=m.raw(review)
        self.policy={'engine':{'expires_at':1000},'shared_locks':self.ctx['lock_identities'],
          'native_guard_producer':{'mode':'inline',
            'source_sha256':hashlib.sha256(self.files[m.SOURCE]).hexdigest(),
            'runtime_activation_sha256':hashlib.sha256(self.files[m.ACTIVATION]).hexdigest(),
            'isolated_review_sha256':hashlib.sha256(self.files[m.REVIEW]).hexdigest(),
            'ledger_identities':{n:[1,2,0,0,0o600] for n in m.LEDGERS},
            'existing_executor_source_sha256':{n:'e'*64 for n in m.EXISTING_SOURCES}}}
        def read(path,*args):
            if path not in self.files:raise FileNotFoundError(str(path))
            return self.files[path]
        def create(path,value):
            m.need(path not in self.files,'exclusive_proof_already_exists')
            self.files[path]=m.raw(value)
        self.guard=m.NativeGuard(self.policy,'7'*64,lambda:self.now,read,create,self.io)
        self.plan={'operation_id':'8'*32,'before_flows':[{'id':'flow','type':'tab'}, {'id':'node','type':'function','z':'flow'}],
                   'after_flows':[{'id':'flow','type':'tab'}, {'id':'node','type':'function','z':'flow','func':'return msg'}], 'risk':{}}
        self.patches=[patch.object(m.os,'getpid',return_value=111),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'__file__',str(m.SOURCE))]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
    def test_inline_policy_schema_matches_coordinator_and_projection_extension(self):
        policy=copy.deepcopy(self.policy)
        policy['native_guard_producer']['public_source_catalog_producer']={'source_sha256':'f'*64}
        m.NativeGuard(policy,'7'*64,lambda:self.now,self.guard.read,self.guard.create,self.io)
        policy['native_guard_producer']['caller_ready']=True
        with self.assertRaises(ValueError):m.NativeGuard(policy,'7'*64,lambda:self.now,self.guard.read,self.guard.create,self.io)

    def before(self):return self.guard.produce_guard(self.plan,'before',self.ctx)
    def intent(self):
        self.files[m.STATE/'operations'/self.plan['operation_id']/'intent.json']=m.raw({'plan_sha256':m.digest(self.plan),'attempted_at':99.5})
    def proof(self,phase):
        return m.decode(self.files[m.ATTESTATIONS/self.plan['operation_id']/'leases'/self.ctx['lock_lease_id']/('guard-'+phase+'.json')])
    def test_before_after_ciphertext_only_and_explicit_context_limits(self):
        self.before();self.intent();self.guard.produce_guard(self.plan,'after',self.ctx)
        proof=self.proof('after')
        self.assertTrue(proof['credentials_unchanged'])
        self.assertFalse(proof['full_runtime_context_value_equality_proven'])
        self.assertFalse(proof['credential_semantic_equality_proven'])
        self.assertEqual(proof['disabled_node_context_values'],'unknown')
        self.assertNotIn('credential_ciphertext_sha256',proof)
    def test_changed_ciphertext_no_restore_no_rebaseline(self):
        self.before();self.intent();self.io.credential='b'*64
        with self.assertRaisesRegex(ValueError,'protected_state_changed_unconfirmed_no_restore'):
            self.guard.produce_guard(self.plan,'after',self.ctx)
        self.ctx['lock_lease_id']='9'*32
        with self.assertRaisesRegex(ValueError,'immutable_baseline_changed_no_retry'):self.before()
    def test_after_without_intent_refused(self):
        self.before()
        with self.assertRaises(FileNotFoundError):self.guard.produce_guard(self.plan,'after',self.ctx)
    def test_after_wrong_intent_refused(self):
        self.before();self.intent()
        p=m.STATE/'operations'/self.plan['operation_id']/'intent.json'
        self.files[p]=m.raw({'plan_sha256':'0'*64,'attempted_at':99.5})
        with self.assertRaisesRegex(ValueError,'post_guard_requires_prior_exact_intent'):
            self.guard.produce_guard(self.plan,'after',self.ctx)
    def test_immutable_baseline_survives_new_executor_lease(self):
        self.before();before=self.files[m.ATTESTATIONS/self.plan['operation_id']/'protected-baseline.json']
        self.ctx['lock_lease_id']='9'*32;self.before()
        self.assertEqual(before,self.files[m.ATTESTATIONS/self.plan['operation_id']/'protected-baseline.json'])
    def test_source_drift_refused(self):
        self.files[m.SOURCE]=b'changed'
        with self.assertRaisesRegex(ValueError,'inline_guard_source_drift'):self.before()
    def test_runtime_birth_and_root_drift_refused(self):
        for key,value in [('birth_ticks',444),('root_identity',[8,9]),('mountinfo_sha256','0'*64)]:
            with self.subTest(key=key):
                old=self.io.process_data[key];self.io.process_data[key]=value
                with self.assertRaisesRegex(ValueError,'runtime_process_or_mount_drift'):self.before()
                self.io.process_data[key]=old
    def test_missing_real_flock_refused(self):
        self.io.locks_ok=False
        with self.assertRaisesRegex(ValueError,'kernel_exclusive_flock_not_owned'):self.before()
    def test_context_id_removal_or_scope_migration_refused(self):
        self.plan['after_flows']=self.plan['after_flows'][:1]
        with self.assertRaisesRegex(ValueError,'context_id_removal'):self.before()
        self.plan['after_flows']=copy.deepcopy(self.plan['before_flows']);self.plan['after_flows'][1]['z']='other'
        with self.assertRaisesRegex(ValueError,'context_scope'):self.before()
    def test_clean_coordination_metadata_only(self):
        binding={'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)}
        result=self.guard.produce_coordination(binding,self.ctx)
        proof=m.decode(self.files[Path(result['proof_path'])])
        self.assertTrue(proof['metadata_only'])
        self.assertTrue(proof['native_clients_outside_shared_locks_not_globally_serialized'])
    def test_unknown_and_uncertain_ledger_states_never_ignored(self):
        for state in ('uncertain','running','invented','released'):
            self.io.ledger_data['legacy']['jobs']=[{'state':state}]
            with self.assertRaisesRegex(ValueError,'unrelated_busy_uncertain_or_unknown'):
                self.guard.produce_coordination({'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)},self.ctx)
    def test_cancelled_before_send_requires_reconciliation(self):
        binding={'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)}
        self.io.ledger_data['task']['tasks']=[{'state':'cancelled_before_first_send','reconciled':0}]
        with self.assertRaisesRegex(ValueError,'unreconciled_task'):self.guard.produce_coordination(binding,self.ctx)
        self.io.ledger_data['task']['tasks'][0]['reconciled']=1
        self.guard.produce_coordination(binding,self.ctx)

    def test_unreconciled_and_unacknowledged_refused(self):
        self.io.ledger_data['task']['sends']=[{'state':'completed','reconciled':0}]
        with self.assertRaisesRegex(ValueError,'unreconciled_task'):self.guard.produce_coordination({'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)},self.ctx)
        self.io.ledger_data['task']['sends']=[];self.io.ledger_data['legacy']['repair_receipts']=[{'ack':0}]
        with self.assertRaisesRegex(ValueError,'unreconciled_repair'):self.guard.produce_coordination({'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)},self.ctx)
    def test_unknown_schema_or_missing_coverage_refused(self):
        del self.io.ledger_data['component_jobs']['meta']
        with self.assertRaisesRegex(ValueError,'metadata_coverage_unknown'):
            self.guard.produce_coordination({'operation_id':'8'*32,'plan_sha256':m.digest(self.plan)},self.ctx)
    def test_review_without_real_evidence_does_not_attest(self):
        del self.files[m.EVIDENCE]
        with self.assertRaises(FileNotFoundError):self.before()
    def test_failed_core_case_refused_even_with_review_pin(self):
        evidence=m.decode(self.files[m.EVIDENCE]);evidence['cases'][0]['passed']=False
        self.files[m.EVIDENCE]=m.raw(evidence)
        review=m.decode(self.files[m.REVIEW]);review['isolated_evidence_sha256']=hashlib.sha256(self.files[m.EVIDENCE]).hexdigest()
        self.files[m.REVIEW]=m.raw(review)
        self.guard.expected['isolated_review_sha256']=hashlib.sha256(self.files[m.REVIEW]).hexdigest()
        with self.assertRaisesRegex(ValueError,'isolated_core_cases_unproven'):self.before()
    def test_duplicate_proof_not_overwritten(self):
        self.before()
        with self.assertRaisesRegex(ValueError,'exclusive_proof_already_exists'):self.before()
    def test_expired_lease_refused(self):
        self.now=500
        with self.assertRaisesRegex(ValueError,'current_root_lock_lease_required'):self.before()


if __name__=='__main__':unittest.main()
