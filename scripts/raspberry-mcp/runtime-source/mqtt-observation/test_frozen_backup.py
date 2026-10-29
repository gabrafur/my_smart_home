"""Closed-authorization data snapshots, never residential service effects."""
from pathlib import Path
from dataclasses import replace
import copy,io,json,os,sys,unittest
from types import SimpleNamespace
from unittest.mock import patch
import frozen_backup as module
import backup_snapshot
from maintenance_journal import Journal,canonical,digest,validate_facts,MaintenanceUnavailable
from authorization_gate import SCOPE as AUTH_SCOPE,AuthorizationGate
from recovery_data import checked_db
from worker import Paths
import test_backup_snapshot as source_fixture
import test_maintenance_journal as normal

H=normal.H
DOMAIN=normal.DOMAIN

def begin_facts():
    return {'source_authorization_sha256':H,'source_approval_sha256':H,'source_authorization_state':'disabled',
      'source_expires_at':'none','source_runtime_marker_present':False,'code_manifest_sha256':H,'profile_sha256':H,
      'deadline_ns':'1000','metadata_integrity':'unknown','effects_dispatched':False}

class Records(unittest.TestCase):
    def test_data_only_facts_cannot_claim_effects_authorization_or_verified_integrity(self):
        validate_facts('frozen_begin',begin_facts())
        for key,value in [('effects_dispatched',True),('metadata_integrity','verified'),
                          ('source_authorization_state','active'),('source_expires_at',123)]:
            with self.subTest(key=key),self.assertRaises(MaintenanceUnavailable):
                validate_facts('frozen_begin',{**begin_facts(),key:value})

@unittest.skipUnless(os.geteuid()==os.getegid()==0,'isolated Root fixture required; ordinary suite never escalates')
class Root(unittest.TestCase):
    def setUp(self):
        self.source=source_fixture.Root();self.source.setUp();self.base=self.source.base
        self.source.journal.close();maintenance=self.base/'frozen-maintenance';maintenance.mkdir(mode=0o700)
        self.paths=replace(self.source.paths,maintenance=maintenance)
        self.authority(enabled=False)
        self.journal=Journal(maintenance,H);self.now=100;self.wall=10000;self.verifications=0
        outer=self
        class Backend:
            policy={'approval_sha256':H,'code_manifest_sha256':H}
            def verify_installed_code(self):outer.verifications+=1
            def clock(self):return str(outer.now),DOMAIN
            def __getattr__(self,key):raise AssertionError('unexpected backend effect or live fact: '+key)
        self.backend=Backend();self.profile();self.frozen=module.FrozenBackup(self.journal,self.backend,self.paths,wall=lambda:self.wall)
        self.identity='b'*32
    def tearDown(self):self.journal.close();self.source.tearDown()
    def authority(self,*,enabled,expires=None):
        self.paths.authorization.write_bytes(canonical({'version':1,'scope':AUTH_SCOPE,'enabled':enabled,
          'expires_at':expires,'approval_id':H}));self.paths.authorization.chmod(0o600)
    def profile(self,**changes):
        value={'schema_version':1,'scope':module.SCOPE,'enabled':True,'expires_at':None,
          'approval_sha256':H,'code_manifest_sha256':H,'maximum_duration_ns':'10000'}
        value.update(changes);path=self.paths.maintenance/'closed-backup-policy.json';path.write_bytes(canonical(value));path.chmod(0o600)
    def capture(self,identity=None):
        identity=identity or self.identity;self.frozen.prepare(identity);return self.frozen.export(identity)
    def test_disabled_source_captures_existing_data_with_unknown_integrity_and_no_grant_writes(self):
        before=self.paths.authorization.read_bytes()
        with patch.object(AuthorizationGate,'refresh',side_effect=AssertionError('must not refresh or enable')):
            target=self.capture();result=self.frozen.resume(self.identity)
        value=backup_snapshot.artifact(target,self.identity)
        self.assertEqual(value['consistency'],'closed_metadata_unknown_cut');self.assertEqual(value['metadata_integrity'],'unknown')
        self.assertFalse(value['current_authority_included']);self.assertFalse(value['full24h_proven'])
        self.assertEqual(checked_db(target/'data/state.sqlite3')['accepted_frames'],1)
        self.assertFalse(result['source_effects_executed']);self.assertGreater(self.verifications,0)
        self.assertEqual(self.paths.authorization.read_bytes(),before);self.assertFalse((self.paths.runtime/'authorized').exists())
        self.assertFalse(any('authorization'in r['path']for r in value['files']))
    def test_expired_source_retains_original_expiry_and_even_an_existing_marker_without_refresh(self):
        self.authority(enabled=True,expires=self.wall-1);marker=self.paths.runtime/'authorized';marker.write_bytes(b'');marker.chmod(0o444)
        before=self.paths.authorization.read_bytes()
        with patch.object(AuthorizationGate,'refresh',side_effect=AssertionError('must not refresh or enable')):
            target=self.capture()
        op=self.journal.find(self.identity);facts=op['records'][0]['body']['facts']
        self.assertEqual(facts['source_authorization_state'],'expired');self.assertEqual(facts['source_expires_at'],str(self.wall-1))
        self.assertTrue(facts['source_runtime_marker_present']);self.assertTrue(marker.exists())
        self.assertEqual(self.paths.authorization.read_bytes(),before)
        self.assertEqual(backup_snapshot.artifact(target,self.identity)['metadata_integrity'],'unknown')
    def test_revoked_profile_observes_existing_revocation_without_removing_it(self):
        self.authority(enabled=True,expires=self.wall+100);marker=self.paths.runtime/'revoked';marker.write_bytes(b'');marker.chmod(0o444)
        self.capture();self.assertTrue(marker.exists())
        self.assertEqual(self.journal.find(self.identity)['records'][0]['body']['facts']['source_authorization_state'],'revoked')
    def test_active_source_cannot_use_data_only_path(self):
        self.authority(enabled=True,expires=self.wall+100)
        with self.assertRaisesRegex(MaintenanceUnavailable,'source_active'):self.frozen.prepare(self.identity)
        self.assertIsNone(self.journal.status())
    def test_missing_disabled_expired_or_unreviewed_profile_refuses_before_operation(self):
        path=self.paths.maintenance/'closed-backup-policy.json';path.unlink()
        with self.assertRaises(FileNotFoundError):self.frozen.prepare(self.identity)
        for changes in [{'enabled':False},{'expires_at':self.wall-1},{'code_manifest_sha256':'0'*64}]:
            self.profile(**changes)
            with self.assertRaises(MaintenanceUnavailable):self.frozen.prepare(self.identity)
            self.assertIsNone(self.journal.status())
    def test_changed_source_or_profile_after_prepare_cannot_start_capture(self):
        self.frozen.prepare(self.identity);self.authority(enabled=True,expires=self.wall+100)
        with self.assertRaisesRegex(MaintenanceUnavailable,'source_active'):self.frozen.export(self.identity)
        self.authority(enabled=False);self.profile(maximum_duration_ns='20000')
        with self.assertRaisesRegex(MaintenanceUnavailable,'profile_changed'):self.frozen.export(self.identity)
        self.assertFalse((self.paths.maintenance/'backup-snapshots').exists())
    def test_deadline_is_original_and_never_renewed_on_repeated_prepare(self):
        self.frozen.prepare(self.identity);before=self.journal.status();self.now=20000
        self.frozen.prepare(self.identity);self.assertEqual(self.journal.status(),before)
        with self.assertRaisesRegex(MaintenanceUnavailable,'deadline'):self.frozen.export(self.identity)
    def test_data_only_operations_never_enter_live_controller(self):
        self.capture();self.frozen.resume(self.identity)
        from maintenance_controller import Controller
        c=Controller(self.journal,self.backend)
        for call in [lambda:c.observe(self.identity,'begin',None,purpose='backup_snapshot'),
                     lambda:c.dispatch(self.identity,'start_source',None)]:
            with self.assertRaisesRegex(MaintenanceUnavailable,'data_only_operation'):call()
    def test_unresolved_household_effect_cannot_be_skipped_by_a_closed_backup(self):
        self.journal.append('c'*32,'begin',normal.facts('begin'),at_ns='100',clock_domain_sha256=DOMAIN,expected_previous_sha256=None)
        with self.assertRaisesRegex(MaintenanceUnavailable,'prior_effect_unresolved'):self.frozen.prepare(self.identity)
    def test_copy_interruption_is_retained_and_cannot_be_recopied(self):
        self.frozen.prepare(self.identity);real=backup_snapshot.snapshot_data
        def change_source(*args):
            value=real(*args);self.authority(enabled=True,expires=self.wall+100);return value
        with patch.object(backup_snapshot,'snapshot_data',side_effect=change_source):
            with self.assertRaises(MaintenanceUnavailable):self.frozen.export(self.identity)
        target=self.paths.maintenance/'backup-snapshots'/self.identity
        self.assertTrue((target/'data/state.sqlite3').exists());self.assertFalse((target/'backup-snapshot.json').exists())
        self.authority(enabled=False)
        with patch.object(module,'prepare_closed',side_effect=AssertionError('must not recopy')):
            with self.assertRaisesRegex(MaintenanceUnavailable,'capture_consumed'):self.frozen.export(self.identity)
            with self.assertRaises(Exception):self.frozen.resume(self.identity)
    def test_lost_capture_return_reconciles_complete_artifact_without_copy_or_effects(self):
        self.frozen.prepare(self.identity);real=module.prepare_closed
        def lost(*args):real(*args);raise OSError('synthetic_lost_return')
        with patch.object(module,'prepare_closed',side_effect=lost):
            with self.assertRaises(OSError):self.frozen.export(self.identity)
        with patch.object(module,'prepare_closed',side_effect=AssertionError('must not recopy')):
            self.assertEqual(self.frozen.resume(self.identity)['state'],'backup_closed_metadata_complete')
        before=self.journal.status();self.frozen.resume(self.identity);self.assertEqual(self.journal.status(),before)
        with self.assertRaisesRegex(MaintenanceUnavailable,'capture_consumed'):self.frozen.export(self.identity)
    def test_terminal_frozen_jobs_are_archived_and_their_ids_stay_consumed(self):
        for i in range(17):
            identity=f'{i:032x}';self.capture(identity);self.frozen.resume(identity)
        self.assertEqual(self.journal.status()['body']['archived_operations'],'1')
        self.assertEqual(self.frozen.prepare('0'*32)['state'],'backup_closed_metadata_complete')
        with self.assertRaisesRegex(MaintenanceUnavailable,'capture_consumed'):self.frozen.export('0'*32)
    def test_closed_snapshot_history_restores_consumed_job_without_old_live_authority(self):
        target=self.capture();from restored_history import restore_snapshot
        root=self.base/'restore';root.mkdir(mode=0o700)
        paths=Paths(root/'state',root/'runtime',root/'reports',root/'consumer',root/'maintenance')
        for folder,uid,gid,mode in [(paths.state,0,0,0o700),(paths.runtime,0,0,0o755),(paths.report,0,1000,0o750),
          (paths.consumer,1000,1000,0o700),(paths.maintenance,0,0,0o700)]:
            folder.mkdir(mode=mode);folder.chmod(mode);os.chown(folder,uid,gid)
        paths.authorization.write_bytes(canonical({'version':1,'scope':AUTH_SCOPE,'enabled':False,'expires_at':None,'approval_id':'f'*64}));paths.authorization.chmod(0o600)
        before=paths.authorization.read_bytes();result=restore_snapshot(paths,target)
        self.assertEqual(result['consumed_operation_ids'],1);self.assertEqual(paths.authorization.read_bytes(),before)
        j=Journal(paths.maintenance,'f'*64)
        try:
            with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(self.identity)
        finally:j.close()
    def test_fixed_cli_selects_closed_mode_streams_and_reconciles_without_live_backend(self):
        import backup_cli
        self.journal.close();out=io.BytesIO();before=self.paths.authorization.read_bytes()
        def request(action):
            with patch.object(backup_cli,'STATE',self.paths.maintenance),\
              patch('maintenance_backend.Backend',return_value=self.backend),patch('worker.Paths',return_value=self.paths),\
              patch.object(sys,'argv',['backup_cli.py',action,self.identity]),\
              patch.object(sys,'stdout',SimpleNamespace(buffer=out)),\
              patch.object(backup_cli.resource,'setrlimit'),patch.object(backup_cli.signal,'signal'),patch.object(backup_cli.signal,'alarm'):
                return backup_cli.main()
        try:
            selected=request('mode');self.assertEqual(selected['mode'],'closed')
            self.assertEqual(request('prepare-closed')['state'],'backup_closed_capture_ready')
            self.assertIsNone(request('export-closed'))
            frames=[json.loads(row)for row in out.getvalue().splitlines()]
            self.assertEqual(frames[-1]['metadata']['metadata_integrity'],'unknown')
            self.assertFalse(frames[-1]['metadata']['full24h_proven'])
            self.assertEqual(request('resume-closed')['state'],'backup_closed_metadata_complete')
            self.assertEqual(request('resume-closed')['state'],'backup_closed_metadata_complete')
            self.assertEqual(self.paths.authorization.read_bytes(),before)
        finally:self.journal=Journal(self.paths.maintenance,H)

if __name__=='__main__':unittest.main()
