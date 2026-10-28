import copy,json,os,stat,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import maintenance_backend as m
from maintenance_controller import BoundaryRejected
from maintenance_journal import record_body
from deployment_files import CORE
from receiver_ledger import stringify
from handoff import totals

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0,'requires isolated Root fixture; ordinary suite never escalates')
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        paths=[]
        for name,mode in [('policy',0o700),('reader',0o700),('code',0o755),('consumer-code',0o755),('consumer',0o700)]:
            p=self.base/name;p.mkdir();p.chmod(mode);paths.append(p)
        os.chown(paths[-1],1000,1000)
        self.paths=m.Paths(paths[0]/'policy.json',paths[1],paths[2],paths[3],paths[4]);self.calls=[]
        self.identity={};self.states={}
        for role,letter,user in [('source','a','1883:1883'),('consumer','b','1000:1000')]:
            self.identity[role]={'container_id':letter*64,'image_id':'sha256:'+'d'*64,'user':user,'mounts':[],
              'readonly_rootfs':True,'network_mode':'none'}
            self.states[role]={'Running':True,'Paused':False,'Restarting':False,'Dead':False,'Pid':123,
              'StartedAt':'synthetic-start','FinishedAt':'synthetic-finish','ExitCode':0}
        names=['canvas_checkpoint.mjs','consumer_protocol.mjs','handoff_schema.json','consumer_state.mjs',
          'consumer_store.mjs','consumer_cli.mjs','consumer-command.sh','reader_status.mjs','maintenance_checkpoint.mjs']
        self.code={'root_files':{},'consumer_files':{}}
        for group,parent,names in [('root_files',self.paths.root_code,CORE),('consumer_files',self.paths.consumer_code,names)]:
            for name in names:
                p=parent/name;p.write_bytes(b'synthetic-code\n');p.chmod(0o644)
                self.code[group][name]=__import__('hashlib').sha256(p.read_bytes()).hexdigest()
        self.policy={'schema_version':1,'scope':m.SCOPE,'enabled':True,'expires_at':time.time()+3600,
          'approval_sha256':'c'*64,'code_manifest_sha256':m.digest(self.code),**self.code,
          **{role:{'container_id':v['container_id'],'identity_sha256':m.digest(v)}for role,v in self.identity.items()}}
        self.policy['source_definition']={'schema_version':1,'container_id':'a'*64,'binary_sha256':'1'*64,
          'plugin_sha256':'2'*64,'approval_id':'c'*64}
        self.write(self.paths.policy,self.policy)
        self.write(self.paths.reader_state/'authorization.json',{'version':1,'scope':m.SOURCE_SCOPE,'enabled':True,
          'expires_at':time.time()+3600,'approval_id':'c'*64})
        reader={'schema_version':2,'source':'fixed_mqtt_metadata_reader','clock_domain_sha256':m.local_clock_domain(),
          'reader_observed_boottime_ns':str(time.clock_gettime_ns(time.CLOCK_BOOTTIME)),
          'reader_instance_sha256':'d'*64,'source_authorized':True,'authorization_state':'active',
          'source_facts':{'epoch':'1','instance_sha256':'e'*64,'closed':False,'identity_state':'verified_live',
            'started_boottime_ns':'1','covered_before_ns':'2'}}
        cs=stringify(totals());cs['frames']='4'
        body={'schema_version':1,'source':'fixed_live_mqtt_maintenance_facts','reader_pid':str(os.getpid()),
          'reader_start_ticks':str(m.start_ticks(Path('/proc/self/stat').read_text(),os.getpid())),
          'source_policy_sha256':m.digest(self.policy['source_definition']),
          'reader':reader,'accepted_frames':'4','acknowledged_frames':'4','acknowledged_counts':cs,'ack_receipt':None,
          'pending_packet':False,'active_counts_nonempty':False,'unknown_epoch_tails':'0','full24h_proven':False,'effect_executed':False}
        self.write(self.paths.reader_state/'maintenance-status.json',{'body':body,'sha256':m.digest(body)})
        self.consumer={'acked_counts':cs,'canvas_checkpoint':{'schema_version':2,'sequence':'7',
          'window':{'id_sha256':'f'*64},'reader_observation':None}}
        self.backend=m.Backend(self.paths,run=self.fake_run)
    def tearDown(self):self.temp.cleanup()
    def write(self,path,v):path.write_bytes(m.canonical(v));path.chmod(0o600)
    def fake_run(self,args,**kwargs):
        self.calls.append(args)
        if args[0]=='/usr/bin/node':
            return SimpleNamespace(returncode=0,stdout=json.dumps({'state':'validated_stopped_consumer_checkpoint','accounting':self.consumer}).encode(),stderr=b'')
        assert args[0]=='/usr/bin/docker'
        role=next(role for role in self.identity if self.policy[role]['container_id']in args)
        v=self.identity[role]
        if args[1]=='inspect':
            assert '.Config.Env'not in args[3]and '{{json .State}}'not in args[3]and '.Health'not in args[3]
            state={k:self.states[role][k]for k in ('Running','Paused','Restarting','Dead','Pid','StartedAt','FinishedAt','ExitCode')}
            rows=[v['container_id'],v['image_id'],v['user'],state,v['mounts'],v['readonly_rootfs'],v['network_mode']]
            return SimpleNamespace(returncode=0,stdout=b'\n'.join(json.dumps(x).encode()for x in rows)+b'\n',stderr=b'')
        if args[1]=='exec':
            assert args[-1]=='snapshot'and args[2:4]==['--user','1000:1000']
            return SimpleNamespace(returncode=0,stdout=json.dumps({'state':'snapshot','accounting':self.consumer}).encode(),stderr=b'')
        assert args[1]in('stop','start');self.states[role]['Running']=args[1]=='start'
        return SimpleNamespace(returncode=0,stdout=(v['container_id']+'\n').encode(),stderr=b'')
    def intent(self,command):
        role='source'if command in('stop_source','start_source')else'consumer';v=self.backend.inspect(role)
        body=record_body('f'*32,'c'*64,m.COMMANDS[command][1],{'binding_sha256':v['binding_sha256'],
          'expected_state_sha256':v['state_sha256']},self.backend.clock()[0],m.local_clock_domain(),3,'d'*64)
        return {'body':body,'sha256':m.digest(body)}
    def test_fixed_command_uses_only_the_sealed_container(self):
        intent=self.intent('stop_source');self.backend.execute('stop_source',intent)
        self.assertEqual([a for a in self.calls if a[1]in('stop','start')],
          [['/usr/bin/docker','stop','--time','30','a'*64]])
    def test_revocation_after_intent_stops_before_command(self):
        intent=self.intent('stop_source');self.write(self.paths.policy,{**self.policy,'enabled':False})
        with self.assertRaises(BoundaryRejected):self.backend.execute('stop_source',intent)
        self.assertFalse(any(a[1]in('stop','start')for a in self.calls))
    def test_process_change_after_preflight_cannot_apply_old_intent(self):
        intent=self.intent('stop_source');self.states['source']['Pid']+=1
        with self.assertRaises(BoundaryRejected):self.backend.execute('stop_source',intent)
        self.assertFalse(any(a[1]in('stop','start')for a in self.calls))
    def test_health_log_updates_are_not_captured_or_part_of_process_identity(self):
        before=self.backend.inspect('source')['state_sha256'];self.states['source']['Health']={'Log':['PRIVATE_CANARY']}
        self.assertEqual(self.backend.inspect('source')['state_sha256'],before)
        self.assertNotIn('PRIVATE_CANARY',str(self.calls))
    def test_code_drift_is_rejected_before_effect(self):
        intent=self.intent('stop_source');(self.paths.root_code/'worker.py').write_bytes(b'synthetic-drift')
        with self.assertRaises(BoundaryRejected):self.backend.execute('stop_source',intent)
    def test_reader_snapshot_requires_live_exact_process_start(self):
        m_,c=self.backend.snapshot();self.assertEqual(c,self.consumer);self.assertEqual(m_['accepted_frames'],'4')
        p=self.paths.reader_state/'maintenance-status.json';v=m.decode(p.read_bytes());v['body']['reader_start_ticks']='1';v['sha256']=m.digest(v['body']);self.write(p,v)
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.snapshot()
    def test_reader_snapshot_does_not_trust_forged_envelope(self):
        p=self.paths.reader_state/'maintenance-status.json';v=m.decode(p.read_bytes());v['sha256']='0'*64;self.write(p,v)
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.snapshot()
    def test_stopped_consumer_is_validated_from_fixed_disk_without_starting_it(self):
        self.states['consumer']['Running']=False;p=self.paths.consumer_state/'state.json'
        p.write_bytes(b'synthetic-state');p.chmod(0o600);os.chown(p,1000,1000)
        _,c=self.backend.snapshot();self.assertEqual(c,self.consumer)
        self.assertTrue(any(a[0]=='/usr/bin/node'for a in self.calls));self.assertFalse(any(a[1]in('start','stop')for a in self.calls))
    def test_unknown_commands_never_reach_docker(self):
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.execute('restart_host',{})
        self.assertEqual(self.calls,[])
    def test_changed_container_binding_or_wide_policy_file_is_rejected(self):
        self.identity['source']['container_id']='f'*64
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.inspect('source')
        self.paths.policy.chmod(0o644)
        with self.assertRaises(m.MaintenanceUnavailable):m.Backend(self.paths,run=self.fake_run)
    def test_symlinks_hardlinks_and_world_readable_private_facts_are_refused(self):
        p=self.paths.reader_state/'maintenance-status.json';original=p.read_bytes()
        p.chmod(0o644)
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.snapshot()
        p.chmod(0o600);link=p.with_name('hardlink');os.link(p,link)
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.snapshot()
        link.unlink();p.rename(link);p.symlink_to(link)
        with self.assertRaises(m.MaintenanceUnavailable):self.backend.snapshot()
        self.assertEqual(link.read_bytes(),original)
if __name__=='__main__':unittest.main()
