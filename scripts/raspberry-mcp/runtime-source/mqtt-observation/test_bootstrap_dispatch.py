"""Isolated admission/consumption tests; no real worker, network or service."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import copy,hashlib,os,tempfile,unittest
import bootstrap_dispatch as m
from maintenance_journal import Journal,canonical,digest,validate_facts,MaintenanceUnavailable
from deployment_files import DeploymentUnavailable

H='a'*64
DOMAIN='b'*64
ID='c'*32

class Records(unittest.TestCase):
    def test_previous_three_phase_chains_remain_valid_historical_data(self):
        from maintenance_journal import record_body,validate_operation
        values=[('bootstrap_begin',{'profile_sha256':H,'worker_manifest_sha256':H,'bootstrap_approval_sha256':H,
          'baseline_policy_sha256':H,'baseline_manifest_sha256':H,'snapshot_operation_sha256':H,'deadline_ns':'1000'}),
          ('bootstrap_remote_intent',{'bundle_sha256':H,'request_sha256':H,'dispatch_completed':False}),
          ('bootstrap_report_recorded',{'report_sha256':H,'independent_acceptance':False})]
        rows=[];previous=None
        for i,(phase,facts)in enumerate(values):
            body=record_body(ID,H,phase,facts,str(100+i),DOMAIN,i+1,previous)
            row={'body':body,'sha256':digest(body)};rows.append(row);previous=row['sha256']
        op={'operation_id':ID,'approval_sha256':H,'records':rows}
        self.assertEqual(validate_operation(op),op)
    def test_intent_and_report_cannot_attest_dispatch_or_independent_acceptance(self):
        validate_facts('bootstrap_remote_intent',{'bundle_sha256':H,'request_sha256':H,'dispatch_completed':False})
        validate_facts('bootstrap_report_recorded',{'report_sha256':H,'independent_acceptance':False})
        for phase,facts in [('bootstrap_remote_intent',{'bundle_sha256':H,'request_sha256':H,'dispatch_completed':True}),
            ('bootstrap_report_recorded',{'report_sha256':H,'independent_acceptance':True})]:
            with self.assertRaises(MaintenanceUnavailable):validate_facts(phase,facts)

@unittest.skipUnless(os.geteuid()==os.getegid()==0,'isolated Root fixture required; ordinary suite never escalates')
class Root(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.state=self.base/'state';self.state.mkdir(mode=0o700)
        worker=self.base/'worker';worker.mkdir(mode=0o755)
        self.entry=worker/'worker.mjs';self.entry.write_bytes(b'// synthetic worker; never executed\n');self.entry.chmod(0o644)
        self.interpreter=self.base/'node';self.interpreter.write_bytes(b'synthetic interpreter; never executed');self.interpreter.chmod(0o755)
        self.policy=self.base/'policy.json';self.policy.write_bytes(b'{"synthetic":true}\n');self.policy.chmod(0o600)
        self.manifest=self.base/'manifest.json';self.manifest.write_bytes(b'{"synthetic_manifest":true}\n');self.manifest.chmod(0o644)
        self.paths=m.Paths(worker,self.interpreter,self.policy,self.manifest,0,0)
        self.j=Journal(self.state,H);self.now=100;self.wall=1000;self.checks=0
        self.backend=SimpleNamespace(policy={'approval_sha256':H,'code_manifest_sha256':H},
          verify_installed_code=self.verify,clock=lambda:(str(self.now),DOMAIN))
        self.guard=m.BootstrapDispatch(self.j,self.backend,self.paths,wall=lambda:self.wall)
        self.profile={'schema_version':1,'scope':m.SCOPE,'enabled':True,'issued_at':999,'expires_at':1100,
          'approval_sha256':'d'*64,'code_manifest_sha256':H,'operation_id':ID,'snapshot_operation_id':'e'*32,
          'maximum_duration_ns':'10000','baseline_policy_sha256':self.sha(self.policy),
          'baseline_manifest_sha256':self.sha(self.manifest),'worker_files':{'worker.mjs':self.sha(self.entry)},
          'interpreter_sha256':self.sha(self.interpreter)}
        self.save_profile()
    def tearDown(self):self.j.close();self.temp.cleanup()
    def sha(self,path):return hashlib.sha256(path.read_bytes()).hexdigest()
    def verify(self):self.checks+=1
    def save_profile(self):
        p=self.state/'first-backup-policy.json';p.write_bytes(canonical(self.profile));p.chmod(0o600)
    def begin(self):
        result=self.guard.begin()
        if result['newly_recorded']:
            self.guard.bind_worker(self.profile['operation_id'],{'pid':'42','start_ticks':'1','interpreter_dev':'1',
              'interpreter_ino':'1','interpreter_sha256':self.profile['interpreter_sha256'],
              'command_sha256':H,'worker_manifest_sha256':digest(self.profile['worker_files'])})
        return result
    def admit(self):return self.guard.admit_remote(self.profile['operation_id'],bundle_sha256=H,request_sha256='f'*64)
    def reopen(self,*,read_only=False):
        self.j.close();self.j=Journal(self.state,H,read_only=read_only);self.guard=m.BootstrapDispatch(self.j,self.backend,self.paths,wall=lambda:self.wall)
    def report(self):return self.guard.record_report(self.profile['operation_id'],H)
    def test_profile_absent_is_closed_without_creating_journal(self):
        (self.state/'first-backup-policy.json').unlink()
        with self.assertRaises(FileNotFoundError):self.begin()
        self.assertFalse((self.state/'maintenance.json').exists())
    def test_begin_is_consumed_across_reopen_and_does_not_rewrite_receipt(self):
        self.assertTrue(self.begin()['newly_recorded']);file=self.state/'maintenance.json';raw=file.read_bytes();inode=file.stat().st_ino
        self.reopen();self.assertFalse(self.begin()['newly_recorded']);self.assertEqual(file.read_bytes(),raw);self.assertEqual(file.stat().st_ino,inode)
    def test_remote_intent_is_durable_and_cannot_be_admitted_twice(self):
        self.begin();result=self.admit();self.assertFalse(result['dispatch_executed']);self.assertFalse(result['remote_effect_proven'])
        raw=(self.state/'maintenance.json').read_bytes();self.reopen()
        with self.assertRaisesRegex(MaintenanceUnavailable,'consumed'):self.admit()
        self.assertEqual((self.state/'maintenance.json').read_bytes(),raw)
    def test_lost_intent_return_is_uncertain_and_never_dispatched_again(self):
        self.begin();original=self.j.tx._atomic
        def lost(*args):original(*args);raise OSError('synthetic lost return')
        with patch.object(self.j.tx,'_atomic',side_effect=lost),self.assertRaisesRegex(MaintenanceUnavailable,'write_uncertain'):self.admit()
        self.reopen();self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_remote_intent')
        with self.assertRaisesRegex(MaintenanceUnavailable,'consumed'):self.admit()
    def test_profile_revocation_after_intent_consumes_without_permission_to_retry(self):
        self.begin();original=self.j.append
        def revoke(*args,**kwargs):
            result=original(*args,**kwargs);self.profile['enabled']=False;self.save_profile();return result
        with patch.object(self.j,'append',side_effect=revoke),self.assertRaisesRegex(MaintenanceUnavailable,'profile_closed'):self.admit()
        self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_remote_intent')
        self.assertFalse(self.guard.status(ID)['automatic_retry'])
    def test_worker_change_after_intent_does_not_free_the_consumed_operation(self):
        self.begin();original=self.j.append
        def change(*args,**kwargs):
            result=original(*args,**kwargs);self.entry.write_bytes(b'changed worker');return result
        with patch.object(self.j,'append',side_effect=change),self.assertRaisesRegex(MaintenanceUnavailable,'worker_changed'):self.admit()
        self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_remote_intent')
    def test_worker_interpreter_and_baseline_changes_block_before_any_intent(self):
        self.begin()
        for file in [self.entry,self.interpreter,self.policy,self.manifest]:
            with self.subTest(file=file.name):
                raw=file.read_bytes();file.write_bytes(b'changed')
                with self.assertRaises(MaintenanceUnavailable):self.admit()
                file.write_bytes(raw)
        self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_worker_bound')
    def test_worker_modes_owners_symlinks_hardlinks_and_unsafe_names_fail_closed(self):
        raw=self.entry.read_bytes()
        for kind in ['writable','owner','symlink','hardlink','traversal','directory_symlink']:
            with self.subTest(kind=kind):
                baseline=copy.deepcopy(self.profile)
                if kind=='writable':self.entry.chmod(0o666)
                elif kind=='owner':os.chown(self.entry,1000,1000)
                elif kind=='symlink':self.entry.unlink();self.entry.symlink_to(self.manifest)
                elif kind=='hardlink':os.link(self.entry,self.base/'alias')
                elif kind=='traversal':self.profile['worker_files']['../manifest.json']=H;self.save_profile()
                elif kind=='directory_symlink':
                    (self.paths.worker/'alias').symlink_to(self.base,target_is_directory=True)
                    self.profile['worker_files']['alias/manifest.json']=self.sha(self.manifest);self.save_profile()
                with self.assertRaises((MaintenanceUnavailable,OSError)):self.begin()
                self.profile=baseline;self.save_profile()
                if kind=='symlink':self.entry.unlink();self.entry.write_bytes(raw)
                if kind=='hardlink':(self.base/'alias').unlink()
                if kind=='directory_symlink':(self.paths.worker/'alias').unlink()
                os.chown(self.entry,0,0);self.entry.chmod(0o644)
        self.assertFalse((self.state/'maintenance.json').exists())
    def test_expiry_disabled_oversized_window_and_boolean_clock_are_rejected(self):
        original=copy.deepcopy(self.profile)
        for changes in [{'enabled':False},{'expires_at':1000},{'expires_at':None},{'issued_at':True},
          {'issued_at':1001},{'expires_at':999+86401},{'maximum_duration_ns':str(m.DAY_NS+1)},
          {'operation_id':self.profile['snapshot_operation_id']},{'code_manifest_sha256':'f'*64}]:
            with self.subTest(changes=changes):
                self.profile={**original,**changes};self.save_profile()
                with self.assertRaises(MaintenanceUnavailable):self.begin()
        self.assertFalse((self.state/'maintenance.json').exists())
    def test_unlisted_worker_files_and_writable_directories_are_rejected(self):
        extra=self.paths.worker/'unreviewed.mjs';extra.write_bytes(b'// unreviewed');extra.chmod(0o644)
        with self.assertRaisesRegex(MaintenanceUnavailable,'inventory_changed'):self.begin()
        extra.unlink();self.paths.worker.chmod(0o777)
        with self.assertRaisesRegex(MaintenanceUnavailable,'directory_unsafe'):self.begin()
        self.paths.worker.chmod(0o755)
        self.assertFalse((self.state/'maintenance.json').exists())
    def test_protected_profile_modes_and_aliases_are_rejected_without_journal_changes(self):
        profile=self.state/'first-backup-policy.json';raw=profile.read_bytes();profile.chmod(0o644)
        with self.assertRaises(DeploymentUnavailable):self.begin()
        profile.chmod(0o600);os.link(profile,self.base/'profile-alias')
        with self.assertRaises(DeploymentUnavailable):self.begin()
        (self.base/'profile-alias').unlink();profile.unlink();(self.base/'profile-copy').write_bytes(raw);profile.symlink_to(self.base/'profile-copy')
        with self.assertRaises(OSError):self.begin()
        self.assertFalse((self.state/'maintenance.json').exists())
    def test_actual_backend_static_binding_rejects_changed_Root_code_without_Docker(self):
        import test_maintenance_backend as fixture
        from maintenance_backend import Backend
        source=fixture.Tests();source.setUp()
        try:
            source.policy['enabled']=False;source.write(source.paths.policy,source.policy)
            def forbidden(*args,**kwargs):raise AssertionError('Docker is outside this guard')
            backend=Backend(source.paths,run=forbidden);backend.clock=lambda:(str(self.now),DOMAIN)
            self.j.close();self.j=Journal(self.state,backend.policy['approval_sha256'])
            self.guard=m.BootstrapDispatch(self.j,backend,self.paths,wall=lambda:self.wall)
            self.profile['code_manifest_sha256']=backend.policy['code_manifest_sha256'];self.save_profile()
            self.begin();(source.paths.root_code/'bootstrap_dispatch.py').write_bytes(b'changed Root code')
            with self.assertRaisesRegex(MaintenanceUnavailable,'code_changed'):self.admit()
            self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_worker_bound')
        finally:source.tearDown()
    def test_remote_boundary_requires_a_worker_witness_and_cannot_rebind_it(self):
        self.guard.begin()
        with self.assertRaisesRegex(MaintenanceUnavailable,'worker_unbound'):self.admit()
        self.begin()  # A consumed begin cannot silently bind a different process.
        self.assertFalse(self.guard.status(ID)['worker_witness_recorded'])
    def test_monotonic_deadline_and_clock_domain_change_block_remote_boundary(self):
        self.begin();self.now=10100
        with self.assertRaisesRegex(MaintenanceUnavailable,'deadline'):self.admit()
        self.now=99
        with self.assertRaisesRegex(MaintenanceUnavailable,'clock_changed'):self.admit()
        self.now=101;self.backend.clock=lambda:('101','f'*64)
        with self.assertRaisesRegex(MaintenanceUnavailable,'clock_changed'):self.admit()
    def test_report_after_expiry_is_data_only_and_duplicate_preserves_bytes_and_inode(self):
        self.begin();self.admit();self.wall=2000
        with self.assertRaisesRegex(MaintenanceUnavailable,'expired'):self.admit()
        result=self.report();self.assertFalse(result['independent_acceptance']);self.assertFalse(result['policy_promoted'])
        file=self.state/'maintenance.json';raw=file.read_bytes();inode=file.stat().st_ino;self.reopen();self.report()
        self.assertEqual(file.read_bytes(),raw);self.assertEqual(file.stat().st_ino,inode)
        with self.assertRaisesRegex(MaintenanceUnavailable,'report_conflict'):self.guard.record_report(ID,'f'*64)
    def test_report_requires_existing_remote_intent(self):
        self.begin()
        with self.assertRaisesRegex(MaintenanceUnavailable,'intent_missing'):self.report()
    def test_readonly_status_survives_expiry_without_profile_or_worker_and_never_writes(self):
        self.begin();self.admit();file=self.state/'maintenance.json';raw=file.read_bytes();inode=file.stat().st_ino
        (self.state/'first-backup-policy.json').unlink();self.entry.unlink();self.wall=2000;self.reopen(read_only=True)
        self.assertEqual(self.guard.status(ID)['phase'],'bootstrap_remote_intent');self.assertEqual(file.read_bytes(),raw);self.assertEqual(file.stat().st_ino,inode)
    def test_report_does_not_become_terminal_or_allow_a_new_profile_to_bypass_uncertainty(self):
        from maintenance_archive import TERMINAL
        self.begin();self.admit();self.report();self.reopen()
        self.assertFalse(self.begin()['newly_recorded'])
        with self.assertRaisesRegex(MaintenanceUnavailable,'consumed'):self.admit()
        self.assertNotIn('bootstrap_report_recorded',TERMINAL)
        self.profile['operation_id']='f'*32;self.save_profile()
        with self.assertRaisesRegex(MaintenanceUnavailable,'prior_operation'):self.begin()
        self.assertFalse((self.state/'maintenance-archive.json').exists())
    def test_profile_swap_after_begin_and_another_pending_operation_do_not_reset_consumption(self):
        self.begin();self.profile['operation_id']='f'*32;self.save_profile()
        with self.assertRaisesRegex(MaintenanceUnavailable,'prior_operation'):self.begin()
        self.profile['operation_id']=ID;self.profile['approval_sha256']='f'*64;self.save_profile()
        with self.assertRaisesRegex(MaintenanceUnavailable,'profile_changed'):self.admit()
    def test_actual_snapshot_and_historical_restore_preserve_consumed_dispatch_ID_and_current_grant(self):
        import test_backup_snapshot as snapshot_fixture
        import test_restored_history as restore_fixture
        from restored_history import restore_snapshot
        self.begin();self.admit();self.report();operation=self.j.find(ID)
        source=snapshot_fixture.Root();source.setUp()
        try:
            for row in operation['records']:
                b=row['body']
                source.journal.append(ID,b['phase'],b['facts'],at_ns=b['at_ns'],clock_domain_sha256=b['clock_domain_sha256'],
                  expected_previous_sha256=b['previous_sha256'])
            source.prepare()
            factory=restore_fixture.Root();factory.base=source.base;target=factory.paths('bootstrap-restored')
            before=target.authorization.read_bytes();result=restore_snapshot(target,source.destination)
            self.assertTrue(result['historical_only']);self.assertFalse(result['old_effects_replayed'])
            self.assertEqual(target.authorization.read_bytes(),before)
            with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):
                with_journal=Journal(target.maintenance,'f'*64)
                try:with_journal.find(ID)
                finally:with_journal.close()
            self.assertFalse((target.runtime/'authorized').exists())
            with_journal=Journal(target.maintenance,'f'*64)
            try:
                self.backend.policy['approval_sha256']='f'*64
                guard=m.BootstrapDispatch(with_journal,self.backend,self.paths,wall=lambda:self.wall)
                profile=target.maintenance/'first-backup-policy.json';profile.write_bytes(canonical(self.profile));profile.chmod(0o600)
                original=(target.maintenance/'maintenance.json').read_bytes()
                with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):guard.begin()
                self.assertEqual((target.maintenance/'maintenance.json').read_bytes(),original)
            finally:with_journal.close()
            self.assertEqual(target.authorization.read_bytes(),before)
        finally:source.tearDown()
