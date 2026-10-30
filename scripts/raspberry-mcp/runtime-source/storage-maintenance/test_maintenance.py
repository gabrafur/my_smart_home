"""Synthetic cache files only. No runtime cleanup, service or credentials."""
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import maintenance as m

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.owner=patch.object(m,'OWNER_UID',os.getuid());self.owner.start();self.addCleanup(self.owner.stop)
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)
        self.cache=self.base/'cache';self.cache.mkdir(mode=0o700)
        self.common=self.base/'common.lock';self.common.touch(mode=0o600)
        self.scopes={'npm_logs':(self.cache,0,r'\d{4}-\d\d-\d\dT[0-9_]+Z-debug-\d+\.log')}
        self.engine=m.Maintenance(self.base/'state',self.scopes,probe=lambda:(set(),True),
                    authorize=lambda:True,resource_gate=lambda:{'available_bytes':99999999},common_lock=self.common)
        self.name='2020-01-01T00_00_00_000Z-debug-0.log';self.file=self.cache/self.name
        self.file.write_bytes(b'SYNTHETIC CONTENT\n'*100);self.file.chmod(0o600)
        self.op='a'*32

    def tearDown(self):self.tmp.cleanup()

    def test_roundtrip_keeps_content_private_and_restores_without_overwrite(self):
        body=self.file.read_bytes();plan=self.engine.plan('npm_logs',self.op)
        self.assertEqual(len(plan['items']),1);self.assertNotIn(self.name,json.dumps(plan));self.assertNotIn('SYNTHETIC',json.dumps(plan))
        result=self.engine.execute('npm_logs',self.op)
        self.assertEqual(result['state'],'recoverable_quarantine_complete');self.assertFalse(self.file.exists())
        self.assertTrue(result['items'][0]['recovery_verified'])
        restored=self.engine.restore('npm_logs',self.op)
        self.assertEqual(restored['state'],'cache_restored_without_overwrite');self.assertEqual(self.file.read_bytes(),body)
        self.assertTrue(list((self.base/'state'/self.op/'payload').glob('*.gz')))

    def test_protected_scope_and_unrecognized_personal_files_are_not_candidates(self):
        for scope in ['backups','recorder','docker','/tmp']:
            with self.assertRaisesRegex(ValueError,'scope_protected_or_unknown'):self.engine.plan(scope,self.op)
        (self.cache/'personal.txt').write_text('private')
        plan=self.engine.plan('npm_logs',self.op);self.assertEqual(len(plan['items']),1)
        self.assertEqual(plan['skipped']['not_eligible'],1)
        (self.cache/'link').symlink_to('/etc')
        again=self.engine.plan('npm_logs','b'*32);self.assertEqual(len(again['items']),1)

    def test_open_file_unknown_coverage_and_hardlinks_block(self):
        s=self.file.stat();self.engine.probe=lambda:({(s.st_dev,s.st_ino)},True)
        self.assertEqual(self.engine.plan('npm_logs',self.op)['items'],[])
        self.engine.probe=lambda:(set(),False)
        self.assertFalse(self.engine.plan('npm_logs','b'*32)['items'][0]['open_file_observation_complete'])
        self.engine.probe=lambda:(set(),True);os.link(self.file,self.cache/'other')
        self.assertEqual(self.engine.plan('npm_logs','c'*32)['items'],[])

    def test_concurrency_and_operation_identity(self):
        fd=os.open(self.common,os.O_WRONLY|os.O_CREAT,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError,'maintenance_busy'):self.engine.plan('npm_logs',self.op)
        finally:os.close(fd)
        one=self.engine.plan('npm_logs',self.op);two=self.engine.plan('npm_logs',self.op)
        self.assertEqual(one['items'],two['items']);self.assertTrue(two['duplicate'])
        with self.assertRaisesRegex(ValueError,'invalid_operation_id'):self.engine.plan('npm_logs','../elsewhere')

    def test_duplicate_execution_does_not_touch_new_source_file(self):
        self.engine.plan('npm_logs',self.op);self.engine.execute('npm_logs',self.op)
        self.file.write_bytes(b'new data');self.file.chmod(0o600)
        two=self.engine.execute('npm_logs',self.op);self.assertTrue(two['duplicate']);self.assertEqual(self.file.read_bytes(),b'new data')
        restored=self.engine.restore('npm_logs',self.op)
        self.assertEqual(restored['reason'],'restore_target_exists_no_overwrite')
        self.assertEqual(self.file.read_bytes(),b'new data')

    def test_source_replacement_or_disabled_policy_never_deletes(self):
        self.engine.plan('npm_logs',self.op);self.file.unlink();self.file.symlink_to('/etc/passwd')
        out=self.engine.execute('npm_logs',self.op);self.assertEqual(out['state'],'outcome_unknown_reconciliation_required')
        self.assertTrue(self.file.is_symlink());self.assertEqual(out['completed_items'],[])
        def refuse():raise ValueError('specific_maintenance_policy_approval_required')
        self.engine.authorize=refuse
        with self.assertRaisesRegex(ValueError,'specific_maintenance_policy_approval_required'):self.engine.execute('npm_logs',self.op)

    def test_corrupt_recovery_never_overwrites_or_claims_success(self):
        self.engine.plan('npm_logs',self.op);self.engine.execute('npm_logs',self.op)
        archive=next((self.base/'state'/self.op/'payload').glob('*.gz'));archive.write_bytes(b'not gzip')
        out=self.engine.restore('npm_logs',self.op)
        self.assertEqual(out['state'],'restore_unconfirmed_no_automatic_retry');self.assertFalse(self.file.exists())
        again=self.engine.restore('npm_logs',self.op);self.assertTrue(again['duplicate'])
        self.assertFalse(self.file.exists())

    def test_kernel_lease_blocks_an_opener_not_detected_by_partial_fd_scan(self):
        self.engine.probe=lambda:(set(),False)
        self.engine.plan('npm_logs',self.op)
        with self.file.open('rb'):
            result=self.engine.execute('npm_logs',self.op)
        self.assertEqual(result['state'],'outcome_unknown_reconciliation_required')
        self.assertTrue(self.file.exists());self.assertEqual(result['completed_items'],[])

    def test_budget_and_cooldown_prevent_second_batch(self):
        self.engine.plan('npm_logs',self.op);self.engine.execute('npm_logs',self.op)
        self.file.write_bytes(b'SYNTHETIC SECOND');self.file.chmod(0o600)
        other='b'*32;self.engine.plan('npm_logs',other)
        with self.assertRaisesRegex(ValueError,'maintenance_budget_held'):self.engine.execute('npm_logs',other)
        self.assertFalse((self.base/'state'/other/'intent.json').exists());self.assertTrue(self.file.exists())

    def test_empty_plan_and_duplicate_revoke_do_not_create_execution_or_reset_history(self):
        self.file.unlink();self.engine.plan('npm_logs',self.op)
        r=self.engine.execute('npm_logs',self.op)
        self.assertEqual(r['state'],'no_eligible_items_no_execution')
        self.assertFalse((self.base/'state'/self.op/'intent.json').exists())
        self.engine.revoke();self.assertTrue(self.engine.revoke()['duplicate'])

    def test_partial_quarantine_can_restore_only_the_moved_items(self):
        other=self.cache/'2020-01-01T00_00_00_001Z-debug-1.log';other.write_bytes(b'SYNTHETIC OTHER');other.chmod(0o600)
        self.engine.plan('npm_logs',self.op)
        original=self.engine.quarantine_one
        calls=[]
        def fail_second(*args):
            calls.append(True)
            if len(calls)==2:raise ValueError('synthetic_second_item_refused')
            return original(*args)
        self.engine.quarantine_one=fail_second
        self.assertEqual(self.engine.execute('npm_logs',self.op)['state'],'outcome_unknown_reconciliation_required')
        result=self.engine.restore('npm_logs',self.op)
        self.assertEqual(result['state'],'cache_restored_without_overwrite');self.assertEqual(len(result['items']),1)
        self.assertTrue(self.file.exists());self.assertTrue(other.exists())

if __name__=='__main__':unittest.main()
