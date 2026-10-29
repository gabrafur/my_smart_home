import copy,hashlib,json,os,time,unittest
from pathlib import Path
from maintenance_journal import Journal,PHASES,canonical,digest,MaintenanceUnavailable
from maintenance_controller import Controller
from backup_rescue import Rescue,Paths,SCOPE
import maintenance_backend as backend_module
import test_maintenance_backend as fixture
from test_maintenance_journal import facts

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0,'requires isolated Root fixture; ordinary suite never escalates')
class Tests(unittest.TestCase):
    write=fixture.Tests.write
    fake_run=fixture.Tests.fake_run
    def setUp(self):
        fixture.Tests.setUp(self);self.journal=None;self.now=1000;self.fail_start=None
        self.runtime=self.base/'runtime';self.runtime.mkdir(exist_ok=True);self.runtime.chmod(0o755)
        self.plugin=self.base/'plugin.so';self.plugin.write_bytes(b'SYNTHETIC_PLUGIN');self.plugin.chmod(0o444)
        (self.runtime/'authorized').touch();(self.runtime/'authorized').chmod(0o444)
        self.identity['source']['mounts']=[{'Type':'bind','Source':str(self.runtime),
          'Destination':'/run/raspberry-mqtt-observation','RW':False},
          {'Type':'bind','Source':str(self.plugin),'Destination':'/mosquitto/metadata/observer.so','RW':False}]
        self.identity['source']['mounts'].sort(key=lambda m:m['Destination'])
        self.policy['source']['identity_sha256']=digest(self.identity['source'])
        self.policy['source_definition']['plugin_sha256']=hashlib.sha256(self.plugin.read_bytes()).hexdigest()
        self.write(self.paths.policy,self.policy);self.calls=[]
        self.backend=backend_module.Backend(self.paths,run=self.backend_run)
        self.domain=backend_module.local_clock_domain();self.backend.clock=lambda:(str(self.now),self.domain)
        d=self.base/'journal';d.mkdir();d.chmod(0o700)
        self.journal=Journal(d,self.policy['approval_sha256']);self.c=Controller(self.journal,self.backend)
        self.rescue=Rescue(self.c,Paths(self.runtime,self.plugin));self.operation_id='f'*32
        self.profile={'schema_version':1,'scope':SCOPE,'enabled':True,'approval_sha256':self.policy['approval_sha256'],
          'code_manifest_sha256':self.policy['code_manifest_sha256'],'maximum_recovery_ns':'9000','observation_interval_ns':'1'}
        self.write(d/'backup-rescue-policy.json',self.profile);self.to_phase('begin');self.rescue.seal(self.operation_id,'9000')
    def tearDown(self):
        if self.journal:self.journal.close()
        fixture.Tests.tearDown(self)
    def backend_run(self,args,**kwargs):
        if args[:2]==['/usr/bin/docker','start']:
            if self.fail_start=='before':self.calls.append(args);raise TimeoutError('synthetic_lost_response')
            result=fixture.Tests.fake_run(self,args,**kwargs)
            role=next(r for r in self.states if self.policy[r]['container_id']in args)
            self.states[role].update(Pid=123,StartedAt='synthetic-rescue-start')
            if self.fail_start=='after':raise TimeoutError('synthetic_lost_response')
            return result
        return fixture.Tests.fake_run(self,args,**kwargs)
    def op(self):return self.c._operation(self.operation_id)
    def to_phase(self,phase):
        op=self.op();start=0 if op is None else len(op['records'])
        for i in range(start,PHASES.index(phase)+1):
            name=PHASES[i];v=facts(name)
            if name=='begin':v.update(code_manifest_sha256=self.policy['code_manifest_sha256'],
              source_binding_sha256=self.policy['source']['identity_sha256'],
              consumer_binding_sha256=self.policy['consumer']['identity_sha256'])
            op=self.op();self.journal.append(self.operation_id,name,v,at_ns=str(100+i),
              clock_domain_sha256=self.domain,expected_previous_sha256=None if op is None else op['records'][-1]['sha256'])
    def stopped(self):
        for role in self.states:self.states[role].update(Running=False,Pid=0)
    def starts(self):return [a for a in self.calls if a[:2]==['/usr/bin/docker','start']]
    def test_expired_plan_restores_two_original_services_after_disabling_only_metadata(self):
        self.to_phase('consumer_stopped');self.stopped();self.now=10000
        authorization=(self.paths.reader_state/'authorization.json').read_bytes()
        r=self.rescue.run(self.operation_id,sleep=lambda _:None)
        self.assertEqual(r['state'],'backup_rescue_house_running_metadata_disabled');self.assertFalse(r['full24h_proven'])
        self.assertEqual([a[-1]for a in self.starts()],['b'*64,'a'*64]);self.assertTrue((self.runtime/'revoked').exists())
        self.assertFalse((self.runtime/'authorized').exists());self.assertEqual(self.op()['records'][-1]['body']['phase'],'rescued')
        self.assertEqual((self.paths.reader_state/'authorization.json').read_bytes(),authorization)
        self.assertTrue(all(s['Running']for s in self.states.values()))
    def test_source_read_expiry_does_not_block_the_separate_presealed_restore_scope(self):
        self.to_phase('consumer_stopped');self.stopped()
        path=self.paths.reader_state/'authorization.json';v=json.loads(path.read_bytes());v['expires_at']=time.time()-1;self.write(path,v)
        before=path.read_bytes();self.rescue.run(self.operation_id,sleep=lambda _:None);self.assertEqual(path.read_bytes(),before)
        self.assertEqual(len(self.starts()),2)
    def test_metadata_database_or_authorization_file_is_not_needed_to_close_the_observer(self):
        self.to_phase('consumer_stopped');self.stopped();(self.paths.reader_state/'authorization.json').unlink()
        self.rescue.run(self.operation_id,sleep=lambda _:None);self.assertEqual(len(self.starts()),2)
        self.assertFalse((self.paths.reader_state/'authorization.json').exists())
    def test_no_effect_prefix_is_cancelled_without_revocation_or_service_commands(self):
        r=self.rescue.step(self.operation_id);self.assertEqual(r['state'],'backup_rescue_not_required')
        self.assertFalse((self.runtime/'revoked').exists());self.assertEqual(self.starts(),[])
        self.assertEqual(self.op()['records'][-1]['body']['phase'],'cancelled')
    def test_lost_start_response_is_observed_without_a_second_start(self):
        self.to_phase('consumer_stopped');self.stopped();self.fail_start='after'
        self.assertEqual(self.rescue.step(self.operation_id)['state'],'backup_rescue_waiting')
        self.fail_start=None;self.rescue.run(self.operation_id,sleep=lambda _:None)
        self.assertEqual([a[-1]for a in self.starts()],['b'*64,'a'*64])
    def test_unexecuted_start_intent_is_never_reissued(self):
        self.to_phase('consumer_stopped');self.stopped();self.fail_start='before';self.rescue.step(self.operation_id)
        self.fail_start=None
        for _ in range(3):self.assertEqual(self.rescue.step(self.operation_id)['state'],'backup_rescue_waiting')
        self.assertEqual(len(self.starts()),1);self.assertFalse(self.states['consumer']['Running'])
    def test_original_start_intent_is_not_bypassed_by_the_rescue_actor(self):
        self.to_phase('consumer_start_intent');self.stopped()
        self.assertEqual(self.rescue.step(self.operation_id)['state'],'backup_rescue_waiting');self.assertEqual(self.starts(),[])
    def test_unknown_stop_while_still_running_is_not_treated_as_a_confirmed_restart(self):
        self.to_phase('source_stop_intent')
        self.assertEqual(self.rescue.step(self.operation_id)['state'],'backup_rescue_waiting');self.assertEqual(self.starts(),[])
    def test_repeat_after_recovery_only_observes_and_preserves_the_terminal_receipt(self):
        self.to_phase('consumer_stopped');self.stopped();self.rescue.run(self.operation_id,sleep=lambda _:None)
        before=self.journal.status();self.rescue.step(self.operation_id)
        self.assertEqual(len(self.starts()),2);self.assertEqual(self.journal.status(),before)
    def test_master_policy_rotation_profile_change_or_expiry_never_renews_restore_access(self):
        self.to_phase('consumer_stopped');self.stopped();before=self.journal.status()
        self.write(self.paths.policy,{**self.policy,'enabled':False})
        with self.assertRaises(MaintenanceUnavailable):self.rescue.step(self.operation_id)
        self.assertFalse((self.runtime/'revoked').exists());self.assertEqual(self.starts(),[]);self.assertEqual(self.journal.status(),before)
    def test_changed_source_mount_or_plugin_blocks_before_any_privileged_effect(self):
        self.to_phase('consumer_stopped');self.stopped();self.plugin.write_bytes(b'changed')
        with self.assertRaises(MaintenanceUnavailable):self.rescue.step(self.operation_id)
        self.assertFalse((self.runtime/'revoked').exists());self.assertEqual(self.starts(),[])
    def test_restore_scope_respects_its_own_master_expiry_even_when_source_scope_still_active(self):
        self.to_phase('consumer_stopped');self.stopped();self.backend.policy['expires_at']=time.time()-1
        self.write(self.paths.policy,self.backend.policy)
        self.backend.policy_sha=hashlib.sha256(self.paths.policy.read_bytes()).hexdigest()
        with self.assertRaisesRegex(MaintenanceUnavailable,'authorization_closed'):self.rescue.step(self.operation_id)
        self.assertFalse((self.runtime/'revoked').exists());self.assertEqual(self.starts(),[])
    def test_clock_change_or_profile_replacement_cannot_create_a_new_restore_window(self):
        self.to_phase('consumer_stopped');self.stopped();self.domain='e'*64
        with self.assertRaisesRegex(MaintenanceUnavailable,'clock_changed'):self.rescue.step(self.operation_id)
        self.domain=backend_module.local_clock_domain()
        self.profile['maximum_recovery_ns']='18000';self.write(self.base/'journal/backup-rescue-policy.json',self.profile)
        with self.assertRaisesRegex(MaintenanceUnavailable,'binding_changed'):self.rescue.step(self.operation_id)
        self.assertFalse((self.runtime/'revoked').exists());self.assertEqual(self.starts(),[])
    def test_recovery_window_is_fixed_at_initial_seal_and_cannot_be_extended_by_retry(self):
        self.to_phase('consumer_stopped');self.stopped();self.now=20000
        self.assertEqual(self.rescue.step(self.operation_id)['state'],'backup_rescue_deadline_reached')
        old=(self.base/'journal'/('backup-rescue-'+self.operation_id+'.json')).read_bytes()
        self.rescue.seal(self.operation_id,'9000')
        self.assertEqual((self.base/'journal'/('backup-rescue-'+self.operation_id+'.json')).read_bytes(),old)
        self.assertEqual(self.starts(),[])
