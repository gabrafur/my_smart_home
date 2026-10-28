import copy,hashlib,json,os,unittest
from unittest.mock import patch
import maintenance_backend as m
import maintenance_journal as j
from maintenance_policy import Issuer
import test_maintenance_backend as fixture_module
from test_maintenance_journal import facts

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0,'requires isolated Root fixture; ordinary suite never escalates')
class Tests(unittest.TestCase):
    write=fixture_module.Tests.write
    fake_run=fixture_module.Tests.fake_run
    def setUp(self):
        fixture_module.Tests.setUp(self)
        self.state=self.base/'maintenance';self.state.mkdir(mode=0o700)
        self.journal=j.Journal(self.state,'c'*64)
        self.states['source'].update(Running=False,Pid=0)
        old_binding=self.backend.inspect('source')['binding_sha256']
        consumer_binding=self.backend.inspect('consumer')['binding_sha256']
        self.metadata_path=self.paths.reader_state/'maintenance-status.json'
        metadata=m.decode(self.metadata_path.read_bytes())['body']
        metadata['reader']['source_facts'].update(closed=True,identity_state='verified_exited')
        self.write(self.metadata_path,{'body':metadata,'sha256':m.digest(metadata)})
        self.consumer['canvas_checkpoint']['reader_observation']={'consumer_instance_sha256':'e'*64}
        parent=None;self.opid='c'*32
        for i,phase in enumerate(j.PHASES[:10]):
            f=facts(phase)
            if phase=='begin':f.update(purpose='container_update',code_manifest_sha256=self.backend.policy['code_manifest_sha256'],source_binding_sha256=old_binding,consumer_binding_sha256=consumer_binding,source_instance_sha256='e'*64)
            if phase in('source_stop_intent','source_stopped'):f['binding_sha256']=old_binding
            if phase in('source_stopped','source_drained'):f['source_instance_sha256']='e'*64
            if phase=='source_drained':f.update(accepted_frames='4',acknowledged_frames='4',protocol_counts_sha256=m.digest(self.consumer['acked_counts']))
            if phase in('consumer_stop_intent','consumer_stopped','consumer_start_intent','consumer_started','consumer_ready'):f['binding_sha256']=consumer_binding
            if phase=='consumer_ready':f.update(old_source_instance_sha256='e'*64,protocol_counts_sha256=m.digest(self.consumer['acked_counts']))
            row=self.journal.append(self.opid,phase,f,at_ns=str(100+i),clock_domain_sha256=m.local_clock_domain(),expected_previous_sha256=parent)
            parent=row['receipt']['sha256']
        self.op=self.journal.status()['body']['operations'][0]
        self.identity['replacement']=copy.deepcopy(self.identity['source']);self.identity['replacement']['container_id']='9'*64
        self.states['replacement']=copy.deepcopy(self.states['source'])
        target={'container_id':'9'*64,'identity_sha256':m.digest(self.identity['replacement'])}
        self.policy['replacement']=target # fake Docker dispatch table, never serialized as Root policy
        self.before_raw=self.paths.policy.read_bytes();self.before=m.decode(self.before_raw)
        definition={**self.before['source_definition'],'container_id':'9'*64}
        self.candidate={'schema_version':1,'source':'fixed_Root_audited_mqtt_replacement','operation_id':self.opid,
          'approval_sha256':'c'*64,'journal_head_sha256':parent,'clock_domain_sha256':m.local_clock_domain(),
          'issued_at_ns':'110','before_policy_sha256':hashlib.sha256(self.before_raw).hexdigest(),
          'target':target,'source_definition':definition,'audit':{'kind':'fixed_mosquitto_replacement_audit_v1',
          'image_id':self.identity['replacement']['image_id'],'binary_sha256':definition['binary_sha256'],
          'plugin_sha256':definition['plugin_sha256']}}
        self.candidate_path=self.paths.policy.parent/'source-candidate.json';self.write(self.candidate_path,self.candidate)
        self.receipt=self.state/('source-policy-seal-'+self.opid+'.json')
    def tearDown(self):
        self.journal.close();fixture_module.Tests.tearDown(self)
    def run_issuer(self):return self.backend.prepare_replacement(self.journal.tx,self.op)
    def assert_no_docker_effect(self):
        self.assertFalse(any(a[0]=='/usr/bin/docker'and a[1]in('stop','start')for a in self.calls))
    def test_seals_only_source_and_preserves_exact_old_bytes_without_starting_a_container(self):
        r=self.run_issuer();self.assertEqual(r['state'],'replacement_policy_ready');self.assertTrue(r['configuration_dispatched'])
        after=m.decode(self.paths.policy.read_bytes());self.assertEqual(after['source'],self.candidate['target'])
        after['source']=self.before['source'];after['source_definition']=self.before['source_definition'];self.assertEqual(after,self.before)
        receipt=m.decode(self.receipt.read_bytes())['body'];self.assertEqual(bytes.fromhex(receipt['before_file_hex']),self.before_raw)
        self.assertEqual(self.journal.status()['body']['operations'][0],self.op);self.assert_no_docker_effect()
    def test_repeated_confirmation_does_not_rewrite_policy_or_receipt(self):
        self.run_issuer();before=[(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns)for p in [self.paths.policy,self.receipt]]
        with patch.object(self.journal.tx,'_atomic',side_effect=AssertionError('unexpected_write')):
            r=self.run_issuer();self.assertEqual(r['state'],'replacement_policy_ready');self.assertFalse(r['dispatched'])
        self.assertEqual(before,[(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns)for p in [self.paths.policy,self.receipt]])
    def test_failure_before_policy_write_is_never_completed_by_retry(self):
        original=self.journal.tx._atomic
        def stop(fd,name,*args):
            if name==self.paths.policy.name:raise OSError('synthetic_before_policy_write')
            return original(fd,name,*args)
        with patch.object(self.journal.tx,'_atomic',side_effect=stop),self.assertRaises(OSError):self.run_issuer()
        self.assertEqual(self.paths.policy.read_bytes(),self.before_raw)
        with patch.object(self.journal.tx,'_atomic',side_effect=AssertionError('unexpected_replay')):
            self.assertEqual(self.run_issuer()['state'],'replacement_policy_unconfirmed')
        self.assert_no_docker_effect()
    def test_failure_after_policy_write_reconciles_without_second_write(self):
        original=self.journal.tx._atomic
        def stop(fd,name,*args):
            original(fd,name,*args)
            if name==self.paths.policy.name:raise OSError('synthetic_after_policy_write')
        with patch.object(self.journal.tx,'_atomic',side_effect=stop),self.assertRaises(OSError):self.run_issuer()
        with patch.object(self.journal.tx,'_atomic',side_effect=AssertionError('unexpected_replay')):
            self.assertEqual(self.run_issuer()['state'],'replacement_policy_ready')
        self.assert_no_docker_effect()
    def test_live_replacement_or_audit_image_mismatch_cannot_create_intent(self):
        self.states['replacement']['Running']=True
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertFalse(self.receipt.exists());self.states['replacement']['Running']=False
        self.candidate['audit']['image_id']='sha256:'+'f'*64;self.write(self.candidate_path,self.candidate)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertFalse(self.receipt.exists());self.assertEqual(self.paths.policy.read_bytes(),self.before_raw)
    def test_candidate_is_root_private_and_bound_to_exact_operation_head(self):
        self.candidate_path.chmod(0o644)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.candidate_path.chmod(0o600);self.candidate['journal_head_sha256']='f'*64;self.write(self.candidate_path,self.candidate)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertFalse(self.receipt.exists())
    def test_policy_conflict_preserves_concurrent_edit(self):
        changed=copy.deepcopy(self.before);changed['enabled']=False;self.write(self.paths.policy,changed)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertEqual(m.decode(self.paths.policy.read_bytes()),changed);self.assertFalse(self.receipt.exists())
    def test_policy_change_during_final_container_inspection_is_not_overwritten(self):
        original=self.backend._inspect_target;seen=[];changed={**self.before,'enabled':False}
        def race(target):
            value=original(target)
            if target['container_id']==self.candidate['target']['container_id']:
                seen.append(True)
                if len(seen)==2:self.write(self.paths.policy,changed)
            return value
        with patch.object(self.backend,'_inspect_target',side_effect=race),self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertTrue(self.receipt.exists());self.assertEqual(m.decode(self.paths.policy.read_bytes()),changed)
        with patch.object(self.journal.tx,'_atomic',side_effect=AssertionError('unexpected_replay')):
            self.assertEqual(self.run_issuer()['state'],'replacement_policy_unconfirmed')
        self.assert_no_docker_effect()
    def test_reader_policy_drift_is_not_silently_overwritten(self):
        v=m.decode(self.metadata_path.read_bytes());v['body']['source_policy_sha256']='f'*64
        v['sha256']=m.digest(v['body']);self.write(self.metadata_path,v)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assertFalse(self.receipt.exists());self.assertEqual(self.paths.policy.read_bytes(),self.before_raw)
    def test_tampered_receipt_cannot_extend_authority_or_change_consumer(self):
        self.run_issuer();v=m.decode(self.receipt.read_bytes());v['body']['after_policy']['expires_at']=None
        v['sha256']=m.digest(v['body']);self.write(self.receipt,v)
        with self.assertRaises(m.MaintenanceUnavailable):self.run_issuer()
        self.assert_no_docker_effect()
