import copy,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from maintenance_journal import Journal,canonical,digest,MaintenanceUnavailable
from maintenance_controller import Controller,records
from maintenance_plan import BackupPlan,SCOPE
from test_maintenance_controller import Backend
from test_maintenance_journal import H,OP

class LiveClockBackend(Backend):
    def facts(self,phase,op,**kwargs):
        v=super().facts(phase,op,**kwargs)
        if phase in('consumer_started','source_started'):
            intent='consumer_start_intent'if phase=='consumer_started'else'source_start_intent'
            v['start_boundary_ns']=records(op)[intent]['body']['at_ns']
        if phase=='consumer_ready':v['reader_observed_ns']=str(self.now)
        if phase=='new_source_verified':v.update(started_ns=str(self.now),covered_before_ns=str(self.now))
        return v

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.path.chmod(0o700)
        self.j=Journal(self.path,H,uid=os.geteuid(),gid=os.getegid());self.b=LiveClockBackend(self.j)
        self.c=Controller(self.j,self.b);self.plan=BackupPlan(self.c)
        self.c.observe(OP,'begin',None,purpose='backup_snapshot')
        self.profile={'schema_version':1,'scope':SCOPE,'enabled':True,'approval_sha256':H,
          'code_manifest_sha256':self.op()['records'][0]['body']['facts']['code_manifest_sha256'],
          'maximum_duration_ns':'10000','observation_interval_ns':'1'}
        self.write('backup-plan-policy.json',self.profile)
    def tearDown(self):self.j.close();self.temp.cleanup()
    def op(self):return self.j.status()['body']['operations'][0]
    def write(self,name,value):
        p=self.path/name;p.write_bytes(canonical(value));p.chmod(0o600)
    def seal(self):return self.plan.seal(OP,self.op()['records'][-1]['sha256'])
    def prepare(self):self.seal();return self.plan.run(OP,'prepare',sleep=lambda _:None)
    def test_independent_worker_stops_source_drains_then_stops_consumer_before_capture(self):
        self.assertEqual(self.prepare()['state'],'backup_plan_capture_ready')
        self.assertEqual(self.b.effects,['stop_source','stop_consumer'])
        capture_phase=self.op()['records'][-1]['body']['phase'];self.assertEqual(capture_phase,'consumer_stopped')
        result=self.plan.run(OP,'resume',sleep=lambda _:None)
        self.assertEqual(result['state'],'backup_plan_complete');self.assertFalse(result['full24h_proven'])
        self.assertEqual(self.b.effects,['stop_source','stop_consumer','start_consumer','start_source'])
        self.assertTrue(all(self.c._result(self.op(),'checked')['comparisons'].values()))
    def test_reopen_after_consumer_stop_resumes_same_plan_without_repeating_effect(self):
        self.prepare();old=(self.path/('backup-plan-'+OP+'.json')).read_bytes()
        self.j.close();self.j=Journal(self.path,H,uid=os.geteuid(),gid=os.getegid());self.b.journal=self.j
        self.c=Controller(self.j,self.b);self.plan=BackupPlan(self.c)
        self.assertEqual(self.plan.run(OP,'resume',sleep=lambda _:None)['state'],'backup_plan_complete')
        self.assertEqual((self.path/('backup-plan-'+OP+'.json')).read_bytes(),old)
        self.assertEqual(self.b.effects,['stop_source','stop_consumer','start_consumer','start_source'])
    def test_lost_effect_response_is_observed_and_never_reissued(self):
        self.b.error='after';self.prepare();self.plan.run(OP,'resume',sleep=lambda _:None)
        self.assertEqual(self.b.effects,['stop_source','stop_consumer','start_consumer','start_source'])
    def test_unexecuted_intent_reaches_fixed_deadline_without_retry_or_new_plan(self):
        self.profile['maximum_duration_ns']='40';self.write('backup-plan-policy.json',self.profile)
        self.seal();self.b.error='before';result=self.plan.run(OP,'prepare',sleep=lambda _:None)
        self.assertEqual(result['state'],'backup_plan_deadline_reached');self.assertEqual(self.b.effects,[])
        self.assertEqual(self.op()['records'][-1]['body']['phase'],'source_stop_intent')
        old=(self.path/('backup-plan-'+OP+'.json')).read_bytes()
        self.assertEqual(self.seal()['state'],'backup_plan_deadline_reached')
        self.assertEqual((self.path/('backup-plan-'+OP+'.json')).read_bytes(),old)
    def test_profile_drift_blocks_even_when_prior_plan_is_well_formed(self):
        self.seal();self.profile['maximum_duration_ns']='20000';self.write('backup-plan-policy.json',self.profile)
        with self.assertRaisesRegex(MaintenanceUnavailable,'binding_changed'):self.plan.step(OP,'prepare')
        self.assertEqual(self.b.effects,[])
    def test_no_unsealed_or_foreign_operation_can_stop_anything(self):
        for operation in [OP,'e'*32,'../']:
            with self.assertRaises((MaintenanceUnavailable,FileNotFoundError)):self.plan.step(operation,'prepare')
        self.assertEqual(self.b.effects,[])
    def test_profile_is_closed_and_has_no_unreviewed_timing_defaults(self):
        for delta in [{'enabled':False},{'approval_sha256':'e'*64},{'command':'restart_host'},
                      {'observation_interval_ns':'0'},{'maximum_duration_ns':'0'}]:
            self.write('backup-plan-policy.json',{**self.profile,**delta})
            with self.assertRaises(MaintenanceUnavailable):self.seal()
        self.assertEqual(self.b.effects,[])
    def test_plan_cannot_be_sealed_after_effects_or_for_container_update(self):
        self.c.observe(OP,'armed',self.op()['records'][-1]['sha256'])
        with self.assertRaisesRegex(MaintenanceUnavailable,'seal_boundary'):self.seal()
        altered=copy.deepcopy(self.op());altered['records'][0]['body']['facts']['purpose']='container_update'
        with patch.object(self.c,'_operation',return_value=altered):
            with self.assertRaisesRegex(MaintenanceUnavailable,'purpose_changed'):self.plan.seal(OP,'0'*64)
        self.assertEqual(self.b.effects,[])
    def test_manual_resume_cannot_skip_prepare_and_capture_cannot_run_after_restart(self):
        self.seal();self.assertEqual(self.plan.step(OP,'resume')['state'],'backup_plan_phase_not_allowed')
        self.plan.run(OP,'prepare',sleep=lambda _:None);self.plan.step(OP,'resume')
        self.assertEqual(self.plan.step(OP,'prepare')['state'],'backup_plan_phase_not_allowed')
    def test_revocation_before_effect_preserves_intent_history_and_does_not_act(self):
        self.seal();self.plan.step(OP,'prepare');before=self.j.status();self.b.permitted=False
        with self.assertRaisesRegex(MaintenanceUnavailable,'authorization_closed'):self.plan.step(OP,'prepare')
        self.assertEqual(self.j.status(),before);self.assertEqual(self.b.effects,[])
    def test_clock_domain_change_cannot_restart_the_duration_budget(self):
        self.seal();before=self.j.status();self.b.domain='f'*64
        with self.assertRaisesRegex(MaintenanceUnavailable,'clock_changed'):self.plan.step(OP,'prepare')
        self.assertEqual(self.j.status(),before);self.assertEqual(self.b.effects,[])
    def test_complete_is_observation_only_and_never_replays_a_backup(self):
        self.prepare();self.plan.run(OP,'resume',sleep=lambda _:None);before=self.j.status()
        for action in ['prepare','resume']:
            self.assertEqual(self.plan.run(OP,action,sleep=lambda _:None)['state'],'backup_plan_complete')
        self.assertEqual(self.j.status(),before);self.assertEqual(len(self.b.effects),4)
    def test_helper_rejects_free_paths_commands_and_malformed_requests_without_backend_access(self):
        helper=Path(__file__).with_name('backup_cli.py')
        for args in [('restart_host',OP),('prepare','../unsafe'),('prepare',OP,'extra')]:
            r=subprocess.run([sys.executable,'-I','-S','-B',str(helper),*args],capture_output=True,timeout=3)
            self.assertEqual(r.returncode,1);self.assertEqual(r.stderr,b'')
            self.assertEqual(json.loads(r.stdout),{'state':'backup_plan_unconfirmed','automatic_retry':False})
