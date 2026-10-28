"""Real isolated filesystem transactions, interruption and concurrent-edit cases."""
from pathlib import Path
import json,os,tempfile,unittest
from deployment_files import FileTransaction,DeploymentUnavailable,TARGETS,CONSUMER,digest,manifest_hash

class FileDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mqtt-deployment-files-')
        self.base=Path(self.temp.name);self.root=self.base/'root';self.root.mkdir(mode=0o700)
        self.state=self.base/'state';self.state.mkdir(mode=0o700)
        self.artifacts={k:('PRIVACY_TEST_FIXTURE_after_'+k).encode()for k in TARGETS}
        self.spec={k:{'before_sha256':None,'after_sha256':digest(v)}for k,v in self.artifacts.items()}
        self.tx=None
    def open(self):
        self.tx=FileTransaction(self.root,self.state,manifest_hash(self.spec),uid=os.geteuid(),gid=os.getegid())
        return self.tx
    def close(self):
        if self.tx:self.tx.close();self.tx=None
    def tearDown(self):self.close();self.temp.cleanup()
    def path(self,key):return self.root/TARGETS[key][0]
    def safe_fixture_path(self,key):
        path=self.path(key);directory=self.root
        # Positive fixtures must satisfy the real guard even when cron inherits
        # a group-writable umask. Do not relax the deployment guard itself.
        for part in path.parent.relative_to(self.root).parts:
            directory=directory/part;directory.mkdir(mode=0o700,exist_ok=True)
        return path
    def existing(self,key,raw=b'PRIVACY_TEST_FIXTURE_before'):
        path=self.safe_fixture_path(key)
        path.write_bytes(raw);path.chmod(TARGETS[key][1]);self.spec[key]['before_sha256']=digest(raw)
    def test_existing_fixture_transaction_is_independent_of_cron_umask(self):
        previous=os.umask(0o002)
        try:self.existing('code/worker.py')
        finally:os.umask(previous)
        self.assertEqual(self.open().apply_approved(self.spec,self.artifacts)['state'],'applied')
    def test_closed_target_set_excludes_grants_bindings_credentials_and_backup_data(self):
        self.assertEqual(len(TARGETS),46)
        self.assertEqual({n.removeprefix('consumer/')for n in TARGETS if n.startswith('consumer/')},set(CONSUMER))
        for path,_mode in TARGETS.values():
            self.assertTrue(path.startswith(('opt/raspberry-mqtt-observation/','etc/systemd/system/raspberry-mqtt-observation.','etc/raspberry-mqtt-observation/')))
            self.assertNotIn('authorization',Path(path).name if not path.endswith('authorization_gate.py')else'code-only')
        spec={**self.spec,'../../etc/shadow':{'before_sha256':None,'after_sha256':'a'*64}}
        with self.assertRaisesRegex(DeploymentUnavailable,'target_set_invalid'):self.open().preflight(spec,self.artifacts)
    def test_preflight_changes_no_target_and_makes_no_operation_intent(self):
        result=self.open().preflight(self.spec,self.artifacts)
        self.assertEqual(result['state'],'preflight_passed_not_applied')
        self.assertEqual(list(self.root.iterdir()),[])
        self.assertFalse((self.state/'transaction.json').exists())
    def test_success_exact_readback_and_same_operation_never_rewrites_targets(self):
        tx=self.open();result=tx.apply_approved(self.spec,self.artifacts)
        self.assertEqual(result['state'],'applied');self.assertTrue(result['targets_match_applied'])
        identities={k:(self.path(k).stat().st_ino,self.path(k).stat().st_mtime_ns)for k in TARGETS}
        tx.apply_approved(self.spec,self.artifacts)
        self.assertEqual(identities,{k:(self.path(k).stat().st_ino,self.path(k).stat().st_mtime_ns)for k in TARGETS})
        self.assertTrue(all(self.path(k).read_bytes()==v for k,v in self.artifacts.items()))
    def test_existing_target_requires_exact_before_hash(self):
        self.existing('code/worker.py');self.spec['code/worker.py']['before_sha256']='b'*64
        with self.assertRaisesRegex(DeploymentUnavailable,'compare_conflict'):self.open().apply_approved(self.spec,self.artifacts)
        self.assertEqual(self.path('code/worker.py').read_bytes(),b'PRIVACY_TEST_FIXTURE_before')
        self.assertFalse((self.state/'transaction.json').exists())
    def test_artifact_change_fails_before_intent_or_target_effects(self):
        tx=self.open();bad={**self.artifacts,'plugin':b'changed'}
        with self.assertRaisesRegex(DeploymentUnavailable,'artifact_digest_mismatch'):tx.apply_approved(self.spec,bad)
        self.assertEqual(list(self.root.iterdir()),[])
    def test_target_symlink_and_hardlink_are_never_followed(self):
        key='code/worker.py';p=self.safe_fixture_path(key)
        preserve=self.base/'outside';preserve.write_bytes(b'PRIVACY_TEST_FIXTURE_preserve');preserve.chmod(0o644)
        p.symlink_to(preserve)
        with self.assertRaises((OSError,DeploymentUnavailable)):self.open().apply_approved(self.spec,self.artifacts)
        self.close();p.unlink();os.link(preserve,p)
        with self.assertRaises(DeploymentUnavailable):self.open().apply_approved(self.spec,self.artifacts)
        self.assertEqual(preserve.read_bytes(),b'PRIVACY_TEST_FIXTURE_preserve')
    def test_parent_symlink_or_group_write_is_rejected(self):
        other=self.base/'other';other.mkdir();(self.root/'opt').symlink_to(other,target_is_directory=True)
        with self.assertRaises((OSError,DeploymentUnavailable)):self.open().apply_approved(self.spec,self.artifacts)
        self.close();(self.root/'opt').unlink();(self.root/'opt').mkdir(mode=0o775);(self.root/'opt').chmod(0o775)
        with self.assertRaisesRegex(DeploymentUnavailable,'parent_unsafe'):self.open().apply_approved(self.spec,self.artifacts)
        self.assertEqual(list(other.iterdir()),[])
    def test_durable_intent_precedes_every_target_write(self):
        tx=self.open();original=tx._replace;seen=[]
        def inspect(key,raw,expected):
            journal=tx._load();self.assertEqual(journal['targets'][key]['state'],'writing')
            self.assertEqual(journal['phase'],'applying');seen.append(key);return original(key,raw,expected)
        tx._replace=inspect;tx.apply_approved(self.spec,self.artifacts);self.assertEqual(seen,list(TARGETS))
    def test_interruption_after_atomic_write_is_not_replayed_and_can_restore_baseline(self):
        self.existing('code/activated_reader.py');tx=self.open();original=tx._replace
        def interrupted(key,raw,expected):original(key,raw,expected);raise RuntimeError('PRIVACY_TEST_FIXTURE_crash')
        tx._replace=interrupted
        with self.assertRaises(RuntimeError):tx.apply_approved(self.spec,self.artifacts)
        self.close();tx=self.open();self.assertEqual(tx.status()['state'],'interrupted')
        before=self.path('code/activated_reader.py').read_bytes()
        with self.assertRaisesRegex(DeploymentUnavailable,'reconciliation'):tx.apply_approved(self.spec,self.artifacts)
        self.assertEqual(self.path('code/activated_reader.py').read_bytes(),before)
        self.assertEqual(tx.rollback_after_quiescence()['state'],'rolled_back')
        self.assertEqual(self.path('code/activated_reader.py').read_bytes(),b'PRIVACY_TEST_FIXTURE_before')
    def test_rollback_restores_existing_and_removes_only_new_known_targets(self):
        self.existing('code/worker.py');tx=self.open();tx.apply_approved(self.spec,self.artifacts)
        backups=sorted(p.name for p in self.state.glob('before-*.bin'))
        result=tx.rollback_after_quiescence();self.assertTrue(result['targets_match_baseline'])
        self.assertEqual(self.path('code/worker.py').read_bytes(),b'PRIVACY_TEST_FIXTURE_before')
        self.assertFalse(self.path('plugin').exists());self.assertEqual(backups,sorted(p.name for p in self.state.glob('before-*.bin')))
        self.assertEqual(tx.rollback_after_quiescence()['state'],'rolled_back')
    def test_rollback_preserves_concurrent_operator_edit_and_reports_conflict(self):
        tx=self.open();tx.apply_approved(self.spec,self.artifacts)
        self.path('code/worker.py').write_bytes(b'PRIVACY_TEST_FIXTURE_operator_edit')
        result=tx.rollback_after_quiescence()
        self.assertEqual(result['state'],'rollback_conflict')
        self.assertIn('code/worker.py',result['unexpected_target_keys'])
        self.assertEqual(self.path('code/worker.py').read_bytes(),b'PRIVACY_TEST_FIXTURE_operator_edit')
    def test_rollback_refuses_corrupt_archive(self):
        self.existing('code/worker.py');tx=self.open();tx.apply_approved(self.spec,self.artifacts)
        (self.state/tx._backup_name('code/worker.py')).write_bytes(b'changed')
        with self.assertRaisesRegex(DeploymentUnavailable,'backup_corrupt'):tx.rollback_after_quiescence()
        self.assertEqual(self.path('code/worker.py').read_bytes(),self.artifacts['code/worker.py'])
    def test_corrupt_journal_never_becomes_new_installation(self):
        tx=self.open();tx.apply_approved(self.spec,self.artifacts)
        path=self.state/'transaction.json';body=json.loads(path.read_text());body['body']['phase']='prepared';path.write_text(json.dumps(body))
        with self.assertRaisesRegex(DeploymentUnavailable,'journal_corrupt'):tx.apply_approved(self.spec,self.artifacts)
    def test_completed_receipt_is_not_current_deployment_proof_after_external_revert(self):
        self.existing('code/worker.py');tx=self.open();tx.apply_approved(self.spec,self.artifacts)
        self.path('code/worker.py').write_bytes(b'PRIVACY_TEST_FIXTURE_before')
        status=tx.status();self.assertEqual(status['state'],'applied_receipt_current_targets_changed')
        self.assertFalse(status['targets_match_applied']);self.assertEqual(status['unexpected_target_keys'],[])
    def test_second_handle_cannot_take_active_transaction_lock(self):
        self.open()
        with self.assertRaisesRegex(DeploymentUnavailable,'deployment_busy'):
            FileTransaction(self.root,self.state,manifest_hash(self.spec),uid=os.geteuid(),gid=os.getegid())
    def test_directory_replacement_and_permission_change_are_fail_closed(self):
        tx=self.open();self.state.chmod(0o755)
        with self.assertRaisesRegex(DeploymentUnavailable,'directory_changed'):tx.preflight(self.spec,self.artifacts)
        self.state.chmod(0o700);self.state.rename(self.base/'old-state');self.state.mkdir(mode=0o700)
        with self.assertRaisesRegex(DeploymentUnavailable,'directory_changed'):tx.status()
    def test_readonly_observation_never_creates_a_lock_or_accepts_mutation(self):
        with self.assertRaises(FileNotFoundError):
            FileTransaction(self.root,self.state,manifest_hash(self.spec),uid=os.geteuid(),gid=os.getegid(),read_only=True)
        self.assertEqual(list(self.state.iterdir()),[])
        self.open().apply_approved(self.spec,self.artifacts);self.close()
        self.tx=FileTransaction(self.root,self.state,manifest_hash(self.spec),uid=os.geteuid(),gid=os.getegid(),read_only=True)
        before=(self.state/'transaction.json').read_bytes();self.assertEqual(self.tx.status()['state'],'applied')
        with self.assertRaisesRegex(DeploymentUnavailable,'readonly'):self.tx.apply_approved(self.spec,self.artifacts)
        with self.assertRaisesRegex(DeploymentUnavailable,'readonly'):self.tx.rollback_after_quiescence()
        self.assertEqual((self.state/'transaction.json').read_bytes(),before)

if __name__=='__main__':unittest.main()
