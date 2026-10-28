"""Actual isolated Root files; fake Docker/reader observations are explicit."""
import copy,json,os,unittest
from pathlib import Path
from unittest.mock import patch
import test_maintenance_backend as fixture_module
import maintenance_backend as m
import maintenance_journal as j
from maintenance_rebind import Transaction
from test_maintenance_journal import facts

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0,'requires isolated Root fixture; ordinary suite never escalates')
class Tests(unittest.TestCase):
    write=fixture_module.Tests.write
    fake_run=fixture_module.Tests.fake_run
    def setUp(self):
        fixture_module.Tests.setUp(self)
        self.state=self.base/'journal';self.state.mkdir(mode=0o700)
        self.journal=j.Journal(self.state,self.policy['approval_sha256'])
        self.metadata_path=self.paths.reader_state/'maintenance-status.json'
        self.before={**self.policy['source_definition'],'container_id':'f'*64}
        # Pretty bytes, not a reconstruction, must survive for exact rollback.
        self.before_raw=(json.dumps(self.before,indent=2)+'\n').encode()
        (self.paths.reader_state/'source-policy.json').write_bytes(self.before_raw)
        (self.paths.reader_state/'source-policy.json').chmod(0o600)
        metadata=m.decode(self.metadata_path.read_bytes());b=metadata['body']
        b['source_policy_sha256']=m.digest(self.before)
        b['reader']['source_facts'].update(closed=True,identity_state='verified_exited')
        self.states['source']['Running']=False
        self.consumer['canvas_checkpoint']['reader_observation']={'consumer_instance_sha256':'e'*64}
        self.publish_metadata(b)
        self.operation_id='c'*32;parent=None
        consumer_binding=self.backend.inspect('consumer')['binding_sha256']
        for i,phase in enumerate(j.PHASES[:10]):
            f=facts(phase)
            if phase=='begin':f.update(consumer_binding_sha256=consumer_binding,source_instance_sha256='e'*64)
            if phase=='source_stopped':f['source_instance_sha256']='e'*64
            if phase=='source_drained':f.update(source_instance_sha256='e'*64,accepted_frames='4',acknowledged_frames='4',protocol_counts_sha256=m.digest(self.consumer['acked_counts']))
            if phase in('consumer_stop_intent','consumer_stopped','consumer_start_intent','consumer_started','consumer_ready'):f['binding_sha256']=consumer_binding
            if phase=='consumer_ready':f.update(old_source_instance_sha256='e'*64,protocol_counts_sha256=m.digest(self.consumer['acked_counts']))
            row=self.journal.append(self.operation_id,phase,f,at_ns=str(100+i),clock_domain_sha256=m.local_clock_domain(),expected_previous_sha256=parent)
            parent=row['receipt']['sha256']
        self.op=self.journal.status()['body']['operations'][0]
        self.tx=Transaction(self.journal.tx,self.backend,self.op)
        self.binding_file=self.state/('binding-'+self.operation_id+'.json')
    def tearDown(self):
        self.journal.close();fixture_module.Tests.tearDown(self)
    def publish_metadata(self,b):self.write(self.metadata_path,{'body':b,'sha256':m.digest(b)})
    def reader_confirms(self):
        b=m.decode(self.metadata_path.read_bytes())['body'];b['source_policy_sha256']=m.digest(self.policy['source_definition']);self.publish_metadata(b)
    def policy_bytes(self):return (self.paths.reader_state/'source-policy.json').read_bytes()
    def root_binding(self):return m.decode(self.binding_file.read_bytes())['body']
    def assert_no_container_effect(self):self.assertFalse(any(a[0]=='/usr/bin/docker'and a[1]in('start','stop')for a in self.calls))
    def test_configuration_dispatch_preserves_exact_baseline_and_never_starts_a_container(self):
        r=self.tx.run();self.assertEqual(r['state'],'binding_awaiting_reader');self.assertTrue(r['dispatched']);self.assertTrue(r['configuration_dispatched']);self.assertFalse(r['docker_dispatched'])
        b=self.root_binding();self.assertEqual(bytes.fromhex(b['before_file_hex']),self.before_raw);self.assertEqual(b['before_policy'],self.before)
        self.assertEqual(self.policy_bytes(),m.canonical(self.policy['source_definition']));self.assert_no_container_effect()
        self.assertEqual(self.journal.status()['body']['operations'][0],self.op)
    def test_pending_or_confirmed_replays_observe_without_rewriting_policy_or_request(self):
        self.tx.run();paths=[self.paths.reader_state/n for n in ('source-policy.json','source-rebind.json')]
        before=[(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns)for p in paths]
        self.assertEqual(self.tx.run()['state'],'binding_result_unknown')
        self.reader_confirms();r=self.tx.run();self.assertEqual(r['state'],'binding_reader_confirmed');self.assertFalse(r['dispatched'])
        receipt=self.binding_file.read_bytes();self.assertEqual(self.tx.run()['state'],'binding_reader_confirmed');self.assertEqual(self.binding_file.read_bytes(),receipt)
        self.assertEqual([(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns)for p in paths],before);self.assert_no_container_effect()
    def test_interrupt_after_request_never_replays_remaining_policy_write(self):
        original=self.journal.tx._atomic
        def crash(fd,name,*a):
            if name=='source-policy.json':raise OSError('synthetic_interruption')
            return original(fd,name,*a)
        with patch.object(self.journal.tx,'_atomic',side_effect=crash),self.assertRaises(OSError):self.tx.run()
        self.assertEqual(self.policy_bytes(),self.before_raw);self.assertEqual(self.root_binding()['phase'],'intent')
        with patch.object(self.journal.tx,'_atomic',side_effect=AssertionError('unexpected_write')):
            self.assertEqual(self.tx.run()['state'],'binding_result_unknown')
        self.assert_no_container_effect()
    def test_interrupt_after_files_fsync_is_reconciled_only_from_same_reader(self):
        original=self.tx._save
        def crash(b):
            if b['phase']=='files_written':raise OSError('synthetic_after_files_fsync')
            return original(b)
        with patch.object(self.tx,'_save',side_effect=crash),self.assertRaises(OSError):self.tx.run()
        self.assertEqual(self.root_binding()['phase'],'intent');self.assertEqual(self.tx.run()['state'],'binding_result_unknown')
        self.reader_confirms();self.assertEqual(self.tx.run()['state'],'binding_reader_confirmed');self.assert_no_container_effect()
    def test_revocation_before_intent_has_no_binding_effect(self):
        self.write(self.paths.policy,{**self.policy,'enabled':False})
        with self.assertRaises(j.MaintenanceUnavailable):self.tx.run()
        self.assertFalse(self.binding_file.exists());self.assertEqual(self.policy_bytes(),self.before_raw);self.assert_no_container_effect()
    def test_authority_closes_between_request_and_policy_without_retry(self):
        original=self.backend.authorize;calls=[]
        def expire(*a,**kw):
            calls.append(None)
            if len(calls)==3:raise j.MaintenanceUnavailable('maintenance_authorization_closed')
            return original(*a,**kw)
        with patch.object(self.backend,'authorize',side_effect=expire),self.assertRaises(j.MaintenanceUnavailable):self.tx.run()
        self.assertEqual(self.policy_bytes(),self.before_raw);self.assertTrue((self.paths.reader_state/'source-rebind.json').exists())
        self.assertEqual(self.tx.run()['state'],'binding_result_unknown');self.assert_no_container_effect()
    def test_directory_swap_after_request_cannot_write_through_an_obsolete_fd(self):
        original=self.journal.tx._atomic;old=self.base/'old-reader'
        def swap(fd,name,*a):
            r=original(fd,name,*a)
            if name=='source-rebind.json':
                self.paths.reader_state.rename(old);self.paths.reader_state.mkdir(mode=0o700)
                (self.paths.reader_state/'source-policy.json').write_bytes(self.before_raw);(self.paths.reader_state/'source-policy.json').chmod(0o600)
            return r
        with patch.object(self.journal.tx,'_atomic',side_effect=swap),self.assertRaisesRegex(j.MaintenanceUnavailable,'directory_changed'):self.tx.run()
        self.assertEqual(self.policy_bytes(),self.before_raw);self.assertEqual((old/'source-policy.json').read_bytes(),self.before_raw)
        self.assertEqual(self.tx.run()['state'],'binding_result_unknown');self.assert_no_container_effect()
    def test_changed_Reader_nonce_never_confirms_or_resets_the_transaction(self):
        self.tx.run();self.reader_confirms();b=m.decode(self.metadata_path.read_bytes())['body'];b['reader']['reader_instance_sha256']='0'*64;self.publish_metadata(b)
        original=self.binding_file.read_bytes();self.assertEqual(self.tx.run()['state'],'binding_result_unknown');self.assertEqual(self.binding_file.read_bytes(),original)
    def test_binding_receipt_corruption_is_rejected_before_any_policy_write(self):
        self.tx.run();before=self.binding_file.read_bytes();policy=self.policy_bytes()
        for key,value in [('before_file_hex','00'),('before_policy',None),('request',None),('schema_version',True)]:
            v=m.decode(before);v['body'][key]=value;v['sha256']=m.digest(v['body']);self.write(self.binding_file,v)
            with self.subTest(key=key),self.assertRaises(j.MaintenanceUnavailable):self.tx.run()
            self.assertEqual(self.policy_bytes(),policy)
    def test_missing_private_metadata_cannot_be_misreported_as_a_failed_policy_write(self):
        self.tx.run();self.metadata_path.unlink();self.assertEqual(self.tx.run()['state'],'binding_result_unknown');self.assert_no_container_effect()

if __name__=='__main__':unittest.main()
