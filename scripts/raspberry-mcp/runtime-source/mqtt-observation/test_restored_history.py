"""Historical restore and crash fences, always on fresh isolated fixtures."""
from pathlib import Path
import hashlib,json,os,tempfile,time,unittest
from unittest.mock import patch
import restored_history as module
import recovery_data
from maintenance_journal import Journal,PHASES,canonical,digest,MaintenanceUnavailable
from authorization_gate import SCOPE
from worker import Paths
from backup_snapshot import prepare as snapshot_data
import test_backup_snapshot as source_fixture
from test_maintenance_journal import facts,H,DOMAIN

def append(journal,identity,phase):
    operation=journal.find(identity);existing=operation['records']if operation else []
    value={'reason':'deadline','no_effects_dispatched':True}if phase=='cancelled'else facts(phase)
    return journal.append(identity,phase,value,at_ns=str(100+len(existing)),clock_domain_sha256=DOMAIN,
       expected_previous_sha256=existing[-1]['sha256']if existing else None)

class Fence(unittest.TestCase):
    def test_pending_fence_blocks_ids_and_cannot_be_downgraded_by_append(self):
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp);path.chmod(0o700);j=Journal(path,H,uid=os.geteuid(),gid=os.getegid())
            try:
                body={'schema_version':3,'revision':'1','operations':[],'archived_operations':'0','archive_sha256':None,
                    'restored_operations':'1','restored_history_sha256':H,'history_restore_state':'pending',
                    'restore_snapshot_sha256':H,'restore_authorization_sha256':H}
                j.tx._atomic(j.tx.state_fd,'maintenance.json',canonical(module.envelope(body)),0o600)
                for call in [lambda:j.find('a'*32),lambda:append(j,'a'*32,'begin'),lambda:list(j.history_files())]:
                    with self.assertRaisesRegex(MaintenanceUnavailable,'restore_pending'):call()
                self.assertEqual(j.status()['body'],body)
            finally:j.close()

@unittest.skipUnless(os.geteuid()==os.getegid()==0,'requires isolated Root files; ordinary suite never escalates')
class Root(unittest.TestCase):
    def setUp(self):
        self.source=source_fixture.Root();self.source.setUp();self.base=self.source.base
        self.identity=self.source.operation_id;self.operation=self.source.journal.find(self.identity)
        receipt=module.envelope({'schema_version':1,'operation_id':self.identity,'approval_sha256':H,
            'before_file_hex':canonical({'enabled':True,'synthetic_old_policy':True}).hex()})
        path=self.source.paths.maintenance/('backup-plan-'+self.identity+'.json');path.write_bytes(canonical(receipt));path.chmod(0o600)
        self.source.prepare();self.target=self.paths('target');self.before=self.target.authorization.read_bytes()
    def tearDown(self):self.source.tearDown()
    def paths(self,name):
        root=self.base/name;root.mkdir(mode=0o700);p=Paths(root/'state',root/'runtime',root/'reports',root/'consumer',root/'maintenance')
        for path,uid,gid,mode in [(p.state,0,0,0o700),(p.runtime,0,0,0o755),(p.report,0,1000,0o750),
             (p.consumer,1000,1000,0o700),(p.maintenance,0,0,0o700)]:
            path.mkdir(mode=mode);path.chmod(mode);os.chown(path,uid,gid)
        p.authorization.write_bytes(canonical({'version':1,'scope':SCOPE,'enabled':False,'expires_at':None,'approval_id':'f'*64}));p.authorization.chmod(0o600)
        return p
    def journal(self,paths=None):return Journal((paths or self.target).maintenance,'f'*64)
    def restore(self,**kwargs):return module.restore_snapshot(self.target,self.source.destination,**kwargs)
    def hashes(self):
        return {str(p.relative_to(self.target.state.parent)):p.read_bytes()for parent in(self.target.state,self.target.consumer,self.target.maintenance)for p in parent.iterdir()if p.is_file()}
    def test_original_chains_and_receipts_are_data_only_and_current_authority_unchanged(self):
        result=self.restore();self.assertTrue(result['historical_only']);self.assertFalse(result['old_effects_replayed'])
        self.assertEqual(self.target.authorization.read_bytes(),self.before)
        self.assertEqual(recovery_data.checked_db(self.target.ledger),recovery_data.checked_db(self.source.destination/'data/state.sqlite3'))
        with _journal(self.journal())as j:
            value=j.status();self.assertEqual(value['body']['operations'],[]);self.assertEqual(value['body']['history_restore_state'],'complete')
            with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(self.identity)
            files=dict(j.history_files());name='restored-operation-'+self.identity+'.json'
            self.assertEqual(json.loads(files[name])['body']['operation'],self.operation)
            self.assertIn('restored-receipt-backup-plan-'+self.identity+'.json',files)
        self.assertFalse((self.target.maintenance/('backup-plan-'+self.identity+'.json')).exists())
        self.assertFalse((self.target.state/'source-policy.json').exists())
    def test_consumed_id_blocks_controller_and_rescue_before_backend_access(self):
        self.restore()
        from maintenance_controller import Controller
        class Never:
            def __getattr__(self,key):raise AssertionError('unexpected backend use: '+key)
        with _journal(self.journal())as j:
            c=Controller(j,Never())
            for call in [lambda:c.observe(self.identity,'begin',None,purpose='backup_snapshot'),
                         lambda:c.dispatch(self.identity,'start_source',None)]:
                with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):call()
        self.assertEqual(self.target.authorization.read_bytes(),self.before)
    def test_current_disabled_authority_is_required_before_the_fence(self):
        value=json.loads(self.before);value.update(enabled=True,expires_at=int(time.time())+60)
        self.target.authorization.write_bytes(canonical(value))
        with self.assertRaises(Exception):self.restore()
        self.assertFalse((self.target.maintenance/'maintenance.json').exists());self.assertFalse(self.target.ledger.exists())
    def test_duplicate_restore_and_tampered_source_do_not_overwrite_destinations(self):
        self.restore();before=self.hashes()
        with self.assertRaisesRegex(MaintenanceUnavailable,'existing_state_refused'):self.restore()
        self.assertEqual(self.hashes(),before)
        self.source.destination.joinpath('history/maintenance.json').write_bytes(b'changed')
        with self.assertRaises(Exception):self.restore(reconcile=True)
        self.assertEqual(self.hashes(),before)
    def test_missing_or_changed_history_index_cannot_free_old_ids(self):
        self.restore();index=self.target.maintenance/module.INDEX;raw=index.read_bytes();index.unlink()
        with _journal(self.journal())as j:
            with self.assertRaisesRegex(MaintenanceUnavailable,'anchor_changed'):append(j,'c'*32,'begin')
        index.write_bytes(raw);index.chmod(0o600);value=json.loads(raw);value['body']['operations']=[];value['sha256']=digest(value['body']);index.write_bytes(canonical(value))
        with _journal(self.journal())as j:
            with self.assertRaisesRegex(MaintenanceUnavailable,'anchor_changed'):j.find(self.identity)
    def test_live_operations_and_archival_preserve_the_imported_fence(self):
        self.restore()
        with _journal(self.journal())as j:
            for i in range(17):
                for phase in('begin','armed','cancelled'):append(j,f'{i:032x}',phase)
            self.assertEqual(j.status()['body']['schema_version'],3)
            self.assertEqual(j.status()['body']['archived_operations'],'1')
            with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(self.identity)
            self.assertIn(module.INDEX,dict(j.history_files()))
    def test_second_backup_and_restore_preserves_older_ids_and_receipts(self):
        self.restore();new_id='d'*32
        with _journal(self.journal())as j:
            for phase in PHASES[:PHASES.index('consumer_stopped')+1]:append(j,new_id,phase)
            destination=self.base/'second-snapshot';snapshot_data(self.target,j,destination,new_id,lambda:None)
        final=self.paths('final');module.restore_snapshot(final,destination)
        with _journal(self.journal(final))as j:
            self.assertEqual(j.status()['body']['restored_operations'],'2')
            for identity in(self.identity,new_id):
                with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(identity)
            files=dict(j.history_files());self.assertEqual(len(json.loads(files[module.INDEX])['body']['sources']),2)
            self.assertIn('restored-receipt-backup-plan-'+self.identity+'.json',files)
    def test_incomplete_copy_never_retries_files_during_reconciliation(self):
        original=module.put
        def crash(path,*args,**kwargs):
            original(path,*args,**kwargs)
            if path.name.startswith('restored-operation-'):raise OSError('synthetic_after_write')
        with patch.object(module,'put',side_effect=crash):
            with self.assertRaisesRegex(OSError,'synthetic_after_write'):self.restore()
        before=self.hashes()
        with patch.object(module,'put',side_effect=AssertionError('must not recopy')):
            with self.assertRaises(Exception):self.restore(reconcile=True)
        self.assertEqual(self.hashes(),before)
        with _journal(self.journal())as j:
            with self.assertRaisesRegex(MaintenanceUnavailable,'restore_pending'):append(j,'c'*32,'begin')
    def test_complete_copy_with_lost_final_return_can_only_publish_the_fence(self):
        with patch.object(module,'finish',side_effect=OSError('synthetic_before_complete')):
            with self.assertRaises(OSError):self.restore()
        with _journal(self.journal())as j:self.assertEqual(j.status()['body']['history_restore_state'],'pending')
        before_data={str(p):p.read_bytes()for parent in(self.target.state,self.target.consumer)for p in parent.iterdir()if p.is_file()}
        with (patch.object(module,'put',side_effect=AssertionError('must not recopy')),
             patch.object(recovery_data,'put',side_effect=AssertionError('must not recopy'))):
            self.assertTrue(self.restore(reconcile=True)['historical_only'])
        self.assertEqual({str(p):p.read_bytes()for parent in(self.target.state,self.target.consumer)for p in parent.iterdir()if p.is_file()},before_data)
    def test_authority_change_during_pending_restore_is_not_reconciled(self):
        with patch.object(module,'finish',side_effect=OSError('synthetic_before_complete')):
            with self.assertRaises(OSError):self.restore()
        value=json.loads(self.before);value['approval_id']='d'*64;self.target.authorization.write_bytes(canonical(value))
        with self.assertRaisesRegex(MaintenanceUnavailable,'identity_changed'):self.restore(reconcile=True)
        with _journal(self.journal())as j:self.assertEqual(j.status()['body']['history_restore_state'],'pending')
    def test_pending_fence_is_durable_before_any_copy_even_if_the_write_return_is_lost(self):
        real=module.Journal
        def journal(*args,**kwargs):
            j=real(*args,**kwargs);atomic=j.tx._atomic
            def crash(fd,name,raw,mode):
                atomic(fd,name,raw,mode)
                if name=='maintenance.json':raise OSError('synthetic_after_fence_fsync')
            j.tx._atomic=crash;return j
        with patch.object(module,'Journal',side_effect=journal):
            with self.assertRaisesRegex(OSError,'after_fence_fsync'):self.restore()
        self.assertFalse(self.target.ledger.exists())
        with _journal(self.journal())as j:
            with self.assertRaisesRegex(MaintenanceUnavailable,'restore_pending'):j.find(self.identity)
        before=self.hashes()
        with self.assertRaises(Exception):self.restore(reconcile=True)
        self.assertEqual(self.hashes(),before)
    def test_partial_SQLite_copy_cannot_be_replayed_by_reconciliation(self):
        real=recovery_data.put
        def crash(path,*args,**kwargs):
            real(path,*args,**kwargs)
            if path==self.target.ledger:raise OSError('synthetic_after_SQLite')
        with patch.object(recovery_data,'put',side_effect=crash):
            with self.assertRaisesRegex(OSError,'after_SQLite'):self.restore()
        self.assertTrue(self.target.ledger.exists());self.assertFalse((self.target.consumer/'state.json').exists())
        before=self.hashes()
        with patch.object(recovery_data,'put',side_effect=AssertionError('must not recopy')):
            with self.assertRaises(Exception):self.restore(reconcile=True)
        self.assertEqual(self.hashes(),before)
    def test_lost_complete_return_is_read_only_and_does_not_reapply_data(self):
        real=module.Journal
        def journal(*args,**kwargs):
            j=real(*args,**kwargs);atomic=j.tx._atomic
            def crash(fd,name,raw,mode):
                atomic(fd,name,raw,mode)
                if name=='maintenance.json'and json.loads(raw)['body']['history_restore_state']=='complete':
                    raise OSError('synthetic_after_complete_fsync')
            j.tx._atomic=crash;return j
        with patch.object(module,'Journal',side_effect=journal):
            with self.assertRaisesRegex(OSError,'after_complete_fsync'):self.restore()
        before=self.hashes()
        with patch.object(module,'put',side_effect=AssertionError('must not recopy')):
            self.assertTrue(self.restore(reconcile=True)['historical_only'])
        self.assertEqual(self.hashes(),before)
    def test_archive_and_active_chains_are_all_imported_as_consumed(self):
        for i in range(16):
            for phase in('begin','armed','cancelled'):append(self.source.journal,f'{i:032x}',phase)
        snapshot=self.base/'archive-snapshot'
        snapshot_data(self.source.paths,self.source.journal,snapshot,self.identity,lambda:None)
        result=module.restore_snapshot(self.target,snapshot);self.assertEqual(result['consumed_operation_ids'],17)
        with _journal(self.journal())as j:
            for identity in (self.identity,'0'*32):
                with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(identity)
    def test_missing_backup_operation_or_capacity_refuses_before_target_fence(self):
        p=self.source.destination/'backup-snapshot.json';original=json.loads(p.read_bytes())
        p.write_bytes(canonical({**original,'operation_id':'a'*32}))
        with self.assertRaisesRegex(MaintenanceUnavailable,'job_missing'):self.restore()
        self.assertFalse((self.target.maintenance/'maintenance.json').exists())
        p.write_bytes(canonical(original))
        with patch.object(module,'MAX_OPERATIONS',0):
            with self.assertRaisesRegex(MaintenanceUnavailable,'capacity'):self.restore()
        self.assertFalse((self.target.maintenance/'maintenance.json').exists())

    def rewrite_manifest(self):
        path=self.source.destination/'backup-snapshot.json';value=json.loads(path.read_bytes())
        for row in value['files']:
            raw=(self.source.destination/row['path']).read_bytes()
            row.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
        path.write_bytes(canonical(value))

    def test_unaccounted_source_receipt_refuses_before_fence(self):
        name='history/backup-plan-'+'0'*32+'.json';path=self.source.destination/name
        raw=canonical(module.envelope({'operation_id':'0'*32,'approval_sha256':H}))
        path.write_bytes(raw);path.chmod(0o600)
        header=self.source.destination/'backup-snapshot.json';value=json.loads(header.read_bytes())
        value['files'].append({'path':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
            'role':'historical_maintenance_data_not_authority'})
        header.write_bytes(canonical(value))
        with self.assertRaisesRegex(MaintenanceUnavailable,'inventory_unaccounted'):self.restore()
        self.assertFalse((self.target.maintenance/'maintenance.json').exists())
        self.assertFalse(self.target.ledger.exists())

    def test_inner_data_validation_precedes_pending_fence(self):
        path=self.source.destination/'data/manifest.json';value=json.loads(path.read_bytes())
        value['files']['state.sqlite3']['sha256']='0'*64;path.write_bytes(canonical(value));self.rewrite_manifest()
        with self.assertRaisesRegex(recovery_data.RecoveryUnavailable,'digest_mismatch'):self.restore()
        self.assertFalse((self.target.maintenance/'maintenance.json').exists())
        self.assertFalse(self.target.ledger.exists())

    def test_corrupt_record_and_receipt_block_export_without_releasing_consumed_id(self):
        self.restore()
        for name in ('restored-operation-'+self.identity+'.json','restored-receipt-backup-plan-'+self.identity+'.json'):
            path=self.target.maintenance/name;original=path.read_bytes();path.write_bytes(b'{}')
            with _journal(self.journal())as j:
                with self.assertRaisesRegex(MaintenanceUnavailable,'historical_operation_consumed'):j.find(self.identity)
                with self.assertRaises(MaintenanceUnavailable):list(j.history_files())
            path.write_bytes(original)

    def test_unsafe_index_never_allows_a_new_operation(self):
        self.restore();path=self.target.maintenance/module.INDEX;raw=path.read_bytes()
        for attack in ('symlink','hardlink','mode','owner'):
            if attack in ('symlink','hardlink'):
                path.unlink();other=self.target.maintenance/'isolated-index-copy';other.write_bytes(raw);other.chmod(0o600)
                if attack=='symlink':path.symlink_to(other)
                else:os.link(other,path)
            elif attack=='mode':path.chmod(0o644)
            else:os.chown(path,1000,1000)
            with _journal(self.journal())as j:
                with self.assertRaises(MaintenanceUnavailable):append(j,'c'*32,'begin')
            path.unlink()
            if attack in ('symlink','hardlink'):other.unlink()
            path.write_bytes(raw);path.chmod(0o600)

    def test_existing_active_operation_can_recover_when_historical_index_is_unavailable(self):
        self.restore();identity='c'*32
        with _journal(self.journal())as j:
            append(j,identity,'begin');(self.target.maintenance/module.INDEX).unlink()
            append(j,identity,'armed');append(j,identity,'cancelled')
            self.assertEqual(j.find(identity)['records'][-1]['body']['phase'],'cancelled')
            with self.assertRaisesRegex(MaintenanceUnavailable,'anchor_changed'):append(j,'d'*32,'begin')

class _journal:
    def __init__(self,journal):self.journal=journal
    def __enter__(self):return self.journal
    def __exit__(self,*_):self.journal.close()

if __name__=='__main__':unittest.main()
