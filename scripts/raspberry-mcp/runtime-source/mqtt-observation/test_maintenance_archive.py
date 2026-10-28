"""Crash/ownership history fixtures; never touches Docker or home services."""
import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import maintenance_journal as journal
import maintenance_archive as archive
from maintenance_controller import Controller
from test_maintenance_journal import facts,H,DOMAIN

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700)
        self.open()
    def tearDown(self):self.j.close();self.temp.cleanup()
    def open(self,approval=H,read_only=False):
        self.j=journal.Journal(self.path,approval,uid=os.geteuid(),gid=os.getegid(),read_only=read_only)
    def reopen(self,approval=H,read_only=False):self.j.close();self.open(approval,read_only)
    def append(self,index,phase,values=None):
        identity=f'{index:032x}';op=self.j.find(identity)
        existing=next((r for r in op['records']if r['body']['phase']==phase),None)if op else None
        at=int(existing['body']['at_ns'])if existing else 100+len(op['records'])if op else 100
        return self.j.append(identity,phase,values if values is not None else facts(phase),at_ns=str(at),
            clock_domain_sha256=DOMAIN,expected_previous_sha256=op['records'][-1]['sha256']if op else None)
    def begin(self,index=100):return self.append(index,'begin')
    def fill(self,complete=False):
        for index in range(journal.MAX_OPERATIONS):
            for phase in journal.PHASES if complete and index==0 else ('begin','armed','cancelled'):
                self.append(index,phase,{'reason':'deadline','no_effects_dispatched':True}if phase=='cancelled'else None)
    def index(self):return archive.Archive(self.j.tx).index()[1]

    def test_terminal_history_moves_only_after_an_immutable_verified_copy(self):
        self.fill(complete=True);before=self.j.find('0'*32);self.begin()
        state=self.j.status();self.assertEqual(state['body']['schema_version'],2)
        self.assertEqual(len(state['body']['operations']),16);self.assertEqual(state['body']['archived_operations'],'1')
        self.assertEqual(self.j.find('0'*32),before)
        self.assertEqual(self.index()['body']['operations'][0]['terminal_sha256'],before['records'][-1]['sha256'])
        self.assertEqual(len(list(self.path.glob('maintenance-archive-*.json'))),1)
        self.reopen();self.assertEqual(self.j.find('0'*32),before)
        self.assertFalse(journal.correlation_facts(before)['full24h_proven'])

    def test_consumed_ids_cannot_begin_again_after_rotation_or_restart(self):
        self.fill();old=self.j.find('0'*32);self.begin();self.reopen('e'*64)
        self.assertEqual(self.j.find('0'*32),old);before=self.j.status()
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'operation_archived'):
            self.j.append('0'*32,'begin',facts('begin'),at_ns='100',clock_domain_sha256=DOMAIN,expected_previous_sha256=None)
        self.assertEqual(self.j.status(),before)

    def test_controller_reads_archived_results_without_requesting_an_effect(self):
        self.fill(complete=True);self.begin()
        class NoEffects:
            def __getattr__(self,key):raise AssertionError('backend must not run: '+key)
        controller=Controller(self.j,NoEffects())
        self.assertEqual(controller.observe('0'*32,'begin',None)['state'],'already_recorded')
        result=controller.dispatch('0'*32,'stop_source',None)
        self.assertEqual(result['state'],'already_recorded');self.assertFalse(result['dispatched'])

    def test_incomplete_capacity_is_never_archived(self):
        for i in range(journal.MAX_OPERATIONS):self.begin(i)
        before=self.j.status()
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'capacity_reached'):self.begin()
        self.assertEqual(self.j.status(),before);self.assertFalse((self.path/archive.INDEX).exists())

    def test_failed_or_uncertain_work_cannot_be_hidden_by_a_new_controller_id(self):
        self.fill();self.begin();self.append(100,'failed',{'reason':'effect_uncertain'})
        before=self.j.status()
        with self.assertRaisesRegex(Exception,'prior_operation_unresolved'):
            Controller(self.j,object()).observe(f'{101:032x}','begin',None,purpose='backup_snapshot')
        self.assertEqual(self.j.status(),before)

    def test_invalid_new_record_does_not_mutate_retirement_storage(self):
        self.fill();before=self.j.status()
        with self.assertRaises(journal.MaintenanceUnavailable):self.begin_with_private_text()
        self.assertEqual(self.j.status(),before);self.assertFalse((self.path/archive.INDEX).exists())
    def begin_with_private_text(self):return self.append(100,'begin',{**facts('begin'),'private':'PRIVATE_SENTINEL'})

    def test_archive_capacity_fails_closed_without_replacing_active_history(self):
        self.fill()
        with patch.object(archive,'MAX_ARCHIVED_OPERATIONS',1):
            self.begin();before=self.j.status();index=self.index()
            with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_capacity_reached'):self.begin(101)
            self.assertEqual(self.j.status(),before);self.assertEqual(self.index(),index)

    def test_crash_after_each_publication_boundary_reconciles_without_id_reuse(self):
        for boundary in ('record','index','retirement','new_begin'):
            with self.subTest(boundary=boundary):
                self.fill();original=self.j.find('0'*32);atomic=self.j.tx._atomic;calls=0
                def crash(fd,name,raw,mode):
                    nonlocal calls
                    atomic(fd,name,raw,mode)
                    if name=='maintenance.json':calls+=1
                    if ((boundary=='record'and name.startswith('maintenance-archive-'))or
                        (boundary=='index'and name==archive.INDEX)or
                        (boundary=='retirement'and name=='maintenance.json'and calls==1)or
                        (boundary=='new_begin'and name=='maintenance.json'and calls==2)):
                        raise OSError('synthetic_after_fsync')
                with patch.object(self.j.tx,'_atomic',side_effect=crash):
                    with self.assertRaisesRegex(journal.MaintenanceUnavailable,'write_uncertain'):self.begin()
                self.reopen();self.begin();self.assertEqual(self.j.find('0'*32),original)
                self.assertEqual(len(self.j.status()['body']['operations']),16)
                self.assertEqual(len(self.index()['body']['operations']),1)
                self.assertEqual(len(self.j.find(f'{100:032x}')['records']),1)
                self.j.close();self.temp.cleanup();self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700);self.open()

    def test_missing_archive_index_cannot_be_treated_as_an_empty_history(self):
        self.fill();self.begin();before=self.j.status();(self.path/archive.INDEX).unlink()
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_anchor_changed'):self.begin(101)
        self.assertEqual(self.j.status(),before)
        # Existing active facts remain usable to restore the house. Corruption
        # of older storage cannot force a retry of an existing effect.
        self.append(100,'armed');self.assertEqual(self.j.find(f'{100:032x}')['records'][-1]['body']['phase'],'armed')

    def test_valid_but_older_index_is_rejected_by_the_active_anchor(self):
        self.fill();self.begin();prior=(self.path/archive.INDEX).read_bytes();self.begin(101)
        before=self.j.status();(self.path/archive.INDEX).write_bytes(prior)
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_anchor_changed'):self.begin(102)
        self.assertEqual(self.j.status(),before)

    def test_archive_record_digest_and_file_safety_are_required_before_retirement(self):
        for kind in ('symlink','hardlink','mode','conflict'):
            with self.subTest(kind=kind):
                self.fill();before=self.j.status();p=self.path/('maintenance-archive-'+'0'*32+'.json')
                if kind=='symlink':p.symlink_to(self.path/'maintenance.json')
                elif kind=='hardlink':
                    target=self.path/'synthetic-link-target';target.write_bytes(b'{}');target.chmod(0o600);os.link(target,p)
                elif kind=='mode':p.write_bytes(b'{}');p.chmod(0o644)
                else:p.write_bytes(b'{}');p.chmod(0o600)
                with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_(invalid|conflict)'):self.begin()
                if kind=='hardlink':p.unlink()
                self.assertEqual(self.j.status(),before)
                self.j.close();self.temp.cleanup();self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700);self.open()

    def test_read_only_archived_lookup_never_creates_or_rewrites_storage(self):
        self.fill();self.begin();self.reopen(read_only=True)
        paths=sorted(self.path.glob('*'));before={p.name:p.read_bytes()for p in paths}
        self.assertEqual(self.j.find('0'*32)['records'][-1]['body']['phase'],'cancelled')
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'read_only'):
            archive.Archive(self.j.tx).preserve(self.j.find('0'*32))
        self.assertEqual({p.name:p.read_bytes()for p in sorted(self.path.glob('*'))},before)

    def test_unknown_ids_and_extra_index_fields_fail_before_any_file_lookup(self):
        for identity in ('../private','A'*32,'1'*31,True):
            with self.assertRaisesRegex(journal.MaintenanceUnavailable,'operation_invalid'):self.j.find(identity)
        self.fill();self.begin();p=self.path/archive.INDEX;v=json.loads(p.read_bytes());v['body']['private']='PRIVATE_SENTINEL'
        p.write_bytes(journal.canonical(v))
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_invalid'):self.begin(101)

    def test_history_export_covers_active_archived_and_consumed_receipts_without_current_authority(self):
        self.fill();original=self.j.find('0'*32);self.begin()
        for prefix in ('backup-plan-','backup-rescue-','binding-','source-policy-seal-'):
            value={'schema_version':1,'operation_id':'0'*32,'approval_sha256':H,'before_file_hex':b'historical policy only'.hex()}
            path=self.path/(prefix+'0'*32+'.json');path.write_bytes(journal.canonical({'body':value,'sha256':journal.digest(value)}));path.chmod(0o600)
        for name in ('authorization.json','policy.json','source-policy.json','prepared.json','source-candidate.json'):
            (self.path/name).write_text('PRIVATE_CURRENT_AUTHORITY_SENTINEL')
        before=self.j.status();rows=dict(self.j.history_files())
        self.assertEqual(set(rows),{'maintenance.json',archive.INDEX,'maintenance-archive-'+'0'*32+'.json',
            *[p+'0'*32+'.json'for p in ('backup-plan-','backup-rescue-','binding-','source-policy-seal-')]})
        self.assertEqual(json.loads(rows['maintenance-archive-'+'0'*32+'.json'])['operation'],original)
        self.assertFalse(any(b'PRIVATE_CURRENT_AUTHORITY_SENTINEL'in raw for raw in rows.values()))
        self.assertEqual(self.j.status(),before)

    def test_history_export_rejects_missing_archived_bytes_and_mismatched_receipt_hash(self):
        self.fill();self.begin();p=self.path/('maintenance-archive-'+'0'*32+'.json');raw=p.read_bytes();p.unlink()
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'archive_invalid'):list(self.j.history_files())
        p.write_bytes(raw);p.chmod(0o600)
        receipt=self.path/('backup-plan-'+'0'*32+'.json')
        receipt.write_bytes(journal.canonical({'body':{'operation_id':'0'*32,'approval_sha256':H},'sha256':'f'*64}));receipt.chmod(0o600)
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'history_receipt_invalid'):list(self.j.history_files())

    def test_history_export_never_accepts_partial_iteration_as_a_verified_snapshot(self):
        self.fill();self.begin();stream=self.j.history_files();self.assertEqual(next(stream)[0],'maintenance.json')
        p=self.path/'maintenance.json';value=json.loads(p.read_bytes());value['body']['revision']=str(int(value['body']['revision'])+1)
        value['sha256']=journal.digest(value['body']);p.write_bytes(journal.canonical(value))
        with self.assertRaisesRegex(journal.MaintenanceUnavailable,'history_changed'):list(stream)

if __name__=='__main__':unittest.main()
