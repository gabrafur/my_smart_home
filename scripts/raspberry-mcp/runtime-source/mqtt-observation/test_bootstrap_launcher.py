"""Actual Node/PID/Unix credential fixtures, isolated from residential services."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import hashlib,json,os,shutil,socket,subprocess,tempfile,time,unittest
import bootstrap_launcher as module
from bootstrap_dispatch import Paths
from maintenance_journal import Journal,canonical,MaintenanceUnavailable

H='a'*64
ID='c'*32
NODE=shutil.which('node')
CHANNEL=Path(__file__).resolve().parents[3]/'offsite-bootstrap-channel.mjs'
PROJECT=CHANNEL.parent.parent
UPLOAD_SOURCES=('offsite-bootstrap-upload.mjs','offsite-backup.mjs','offsite-bootstrap-state.mjs',
 'restore.mjs','container-readiness.mjs','mqtt-maintenance-backup.mjs','mqtt-backup-snapshot.mjs')

class ChannelEnd(unittest.TestCase):
    def test_reset_is_EOF_without_an_authenticated_frame(self):
        child=module.Child.__new__(module.Child);child.eof=False;child.pidfd=123
        child.channel=SimpleNamespace(recvmsg=lambda *_:(_ for _ in()).throw(ConnectionResetError()))
        with patch.object(module.select,'select',return_value=([child.channel],[],[])):
            self.assertEqual(child.receive(0),b'')
        self.assertTrue(child.eof)
    def test_other_read_errors_are_not_silently_treated_as_EOF(self):
        child=module.Child.__new__(module.Child);child.eof=False;child.pidfd=123
        child.channel=SimpleNamespace(recvmsg=lambda *_:(_ for _ in()).throw(PermissionError()))
        with patch.object(module.select,'select',return_value=([child.channel],[],[])),self.assertRaises(PermissionError):
            child.receive(0)
        self.assertFalse(child.eof)

@unittest.skipUnless(os.geteuid()==os.getegid()==0 and NODE and CHANNEL.is_file(),
 'isolated Root plus Node and public channel source required; ordinary tests never escalate')
class Native(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.base.chmod(0o755)
        self.state=self.base/'state';self.state.mkdir(mode=0o700)
        self.worker=self.base/'worker';self.worker.mkdir(mode=0o755)
        self.data=self.base/'data';self.data.mkdir(mode=0o700);os.chown(self.data,1000,1000)
        self.policy=self.data/'policy.json';self.policy.write_bytes(b'{"synthetic":true}');self.policy.chmod(0o600);os.chown(self.policy,1000,1000)
        self.manifest=self.data/'manifest.json';self.manifest.write_bytes(b'{"synthetic_manifest":true}');self.manifest.chmod(0o644);os.chown(self.manifest,1000,1000)
        self.paths=Paths(self.worker,Path(NODE).resolve(),self.policy,self.manifest,1000,1000)
        shutil.copyfile(CHANNEL,self.worker/CHANNEL.name);(self.worker/CHANNEL.name).chmod(0o644)
        self.backend=SimpleNamespace(policy={'approval_sha256':H,'code_manifest_sha256':H},
          verify_installed_code=lambda:None,clock=lambda:(str(time.clock_gettime_ns(time.CLOCK_BOOTTIME)),H))
        self.launcher=None;self.server=None
    def tearDown(self):
        # Test cleanup affects only the exact synthetic child/server created here.
        if self.launcher and self.launcher.child and self.launcher.child.process:
            p=self.launcher.child.process
            if p.poll()is None:p.terminate()
            p.wait(timeout=5)
        if self.server:
            if self.server.poll()is None:self.server.terminate()
            self.server.wait(timeout=5)
        self.temp.cleanup()
    def sha(self,p):
        value=hashlib.sha256()
        with p.open('rb')as f:
            for raw in iter(lambda:f.read(65536),b''):value.update(raw)
        return value.hexdigest()
    def install(self,body):
        source="import {connectBootstrapChannel} from './offsite-bootstrap-channel.mjs';\n"
        source+="const channel=connectBootstrapChannel(Number(process.env.EVA_BOOTSTRAP_FD),{operationId:process.env.EVA_BOOTSTRAP_OPERATION_ID});\n"
        source+="import fixtureFs from 'node:fs';let fixtureError=null;\n"
        source+=f"process.on('uncaughtException',e=>{{fixtureError??={{name:e.name,code:e.code,message:e.message}};channel.close();process.exitCode=1}});\n"
        source+=f"process.on('exit',code=>fixtureFs.writeFileSync({json.dumps(str(self.data/'child-exit.json'))},JSON.stringify({{code,error:fixtureError}})));\n"
        (self.worker/'worker.mjs').write_text(source+body);(self.worker/'worker.mjs').chmod(0o644)
        now=time.time();p={'schema_version':1,'scope':'mqtt_metadata_first_backup_dispatch_v1','enabled':True,
          'issued_at':now-1,'expires_at':now+300,'approval_sha256':'d'*64,'code_manifest_sha256':H,
          'operation_id':ID,'snapshot_operation_id':'e'*32,'maximum_duration_ns':str(120*10**9),
          'baseline_policy_sha256':self.sha(self.policy),'baseline_manifest_sha256':self.sha(self.manifest),
          'worker_files':{str(f.relative_to(self.worker)):self.sha(f)for f in self.worker.rglob('*')if f.is_file()},'interpreter_sha256':self.sha(Path(NODE).resolve())}
        path=self.state/'first-backup-policy.json';path.write_bytes(canonical(p));path.chmod(0o600)
        self.launcher=module.Launcher(self.state,self.backend,self.paths);return self.launcher
    def operation(self):
        j=Journal(self.state,H,read_only=True)
        try:return j.find(ID)
        finally:j.close()
    def server_once(self):
        server=socket.socket();server.bind(('127.0.0.1',0));server.listen(1);port=server.getsockname()[1]
        target=self.base/'http-counter.json'
        code="""import socket,sys,json,pathlib
s=socket.socket(fileno=int(sys.argv[1]));s.settimeout(90);c,_=s.accept();c.settimeout(5);raw=b''
while b'\\r\\n\\r\\n'not in raw:
 raw+=c.recv(4096)
 if len(raw)>4096:raise RuntimeError('fixture request too large')
pathlib.Path(sys.argv[2]).write_text(json.dumps({'requests':1,'method':raw.split(b' ',1)[0].decode()}))
c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}');c.close();s.close()
"""
        self.server=subprocess.Popen([shutil.which('python3'),'-I','-S','-B','-c',code,str(server.fileno()),str(target)],
          pass_fds=(server.fileno(),),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        server.close();return port,target
    def test_actual_Node_child_native_credentials_and_one_owned_HTTP_request(self):
        port,counter=self.server_once()
        self.install("import http from 'node:http';\n"
          "if(!/^Max address space +2147483648 +2147483648 +bytes *$/m.test(fixtureFs.readFileSync('/proc/self/limits','utf8')))throw Error('worker address-space limit changed');\n"
          "const memory=new WebAssembly.Memory({initial:1,maximum:1});if(memory.buffer.byteLength!==65536)throw Error('bounded Wasm unavailable');\n"+f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});\n"
          f"await new Promise((resolve,reject)=>{{const r=http.request('http://127.0.0.1:{port}/isolated-test',{{method:'POST'}},s=>{{s.resume();s.once('end',resolve)}});r.on('error',reject);r.end()}});\n"
          f"await channel.recordReport('{H}');\n")
        try:result=self.launcher.run()
        except Exception as error:
            debug=self.data/'child-exit.json';pid=self.launcher.child.process
            self.fail(f'{type(error).__name__}: {error}; child_exit={pid.poll()}; phases={[r["body"]["phase"]for r in self.operation()["records"]]}; fixture_exit={debug.read_text()if debug.exists()else"not_recorded"}')
        self.assertEqual(result['exit_code'],0,(result,(self.data/'child-exit.json').read_text()))
        self.assertEqual(result['state'],'worker_exited_report_unverified');self.assertFalse(result['remote_effect_proven'])
        self.server.wait(timeout=5);self.assertEqual(json.loads(counter.read_text()),{'requests':1,'method':'POST'})
        rows=self.operation()['records'];self.assertEqual([r['body']['phase']for r in rows],
          ['bootstrap_begin','bootstrap_worker_bound','bootstrap_remote_intent','bootstrap_report_recorded'])
        witness=rows[1]['body']['facts'];self.assertEqual(witness['pid'],str(self.launcher.child.process.pid))
        self.assertGreater(int(witness['start_ticks']),0)
        with self.assertRaisesRegex(MaintenanceUnavailable,'launch_consumed'):self.launcher.run()
        self.assertEqual(json.loads(counter.read_text())['requests'],1)
    def test_child_cannot_repeat_the_private_admission_and_environment_is_clean(self):
        self.install(f"if(process.env.NODE_OPTIONS||process.env.NODE_PATH)throw Error('inherited environment');\n"
          +"if(process.env.WS_NO_BUFFER_UTIL!=='1'||process.env.WS_NO_UTF_8_VALIDATE!=='1')throw Error('optional module search enabled');\n"
          f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});\n"
          f"let denied=false;try{{await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}})}}catch{{denied=true}}\n"
          f"if(!denied)throw Error('duplicate admitted');await channel.recordReport('{H}');\n")
        with patch.dict(os.environ,{'NODE_OPTIONS':'--require /not/approved','NODE_PATH':'/not/approved'}):result=self.launcher.run()
        self.assertEqual(result['exit_code'],0,result)
        self.assertEqual(sum(r['body']['phase']=='bootstrap_remote_intent'for r in self.operation()['records']),1)
    def test_lock_is_released_before_spawning_the_worker(self):
        self.install(f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});await channel.recordReport('{H}');")
        original=module.Child.start
        def checked(child):
            j=Journal(self.state,H);j.close();return original(child)
        with patch.object(module.Child,'start',checked):result=self.launcher.run()
        self.assertEqual(result['exit_code'],0,result)
    def test_spawn_failure_consumes_the_operation_and_never_restarts_it(self):
        self.install('channel.close();')
        with patch.object(module.subprocess,'Popen',side_effect=OSError('synthetic launch failure')):
            with self.assertRaises(OSError):self.launcher.run()
        self.assertEqual(self.operation()['records'][-1]['body']['phase'],'bootstrap_begin')
        with self.assertRaisesRegex(MaintenanceUnavailable,'launch_consumed'):self.launcher.run()
    def test_unknown_deadline_keeps_the_launched_child_alive_without_relaunch(self):
        self.install('await new Promise(resolve=>setTimeout(resolve,30000));channel.close();')
        self.launcher.boottime_ns=lambda:2**64-1
        result=self.launcher.run();self.assertEqual(result['state'],'worker_deadline_result_unknown')
        self.assertIsNone(self.launcher.child.process.poll())
        self.assertEqual(self.operation()['records'][-1]['body']['phase'],'bootstrap_worker_bound')
        with self.assertRaisesRegex(MaintenanceUnavailable,'launch_consumed'):self.launcher.run()
    def test_baseline_changed_by_child_before_remote_boundary_blocks_dispatch(self):
        self.install("import fs from 'node:fs';\n"+f"fs.writeFileSync({json.dumps(str(self.policy))},'changed');\n"
          f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});\n")
        with self.assertRaisesRegex(MaintenanceUnavailable,'baseline_changed'):self.launcher.run()
        self.assertFalse(any(r['body']['phase']=='bootstrap_remote_intent'for r in self.operation()['records']))
    @unittest.skipUnless((PROJECT/'nodered/node_modules/ws/package.json').is_file()and
      all((CHANNEL.parent/name).is_file()for name in UPLOAD_SOURCES),
      'public upload modules and existing ws fixture dependency required')
    def test_native_Root_channel_and_one_owned_automatic_settings_generation(self):
        scripts=self.worker/'scripts';scripts.mkdir(mode=0o755)
        for name in UPLOAD_SOURCES:
            shutil.copyfile(CHANNEL.parent/name,scripts/name);(scripts/name).chmod(0o644)
        vendor=self.worker/'nodered/node_modules/ws';vendor.parent.mkdir(parents=True,mode=0o755)
        shutil.copytree(PROJECT/'nodered/node_modules/ws',vendor)
        for path in vendor.rglob('*'):
            path.chmod(0o755 if path.is_dir()else 0o644)
        restore=self.worker/'restore';restore.mkdir(mode=0o755)
        shutil.copyfile(PROJECT/'restore/mqtt-observation-private-state.json',restore/'mqtt-observation-private-state.json')
        (restore/'mqtt-observation-private-state.json').chmod(0o644)
        portfile=self.base/'port.json';counter=self.base/'generation.json'
        serverfile=self.base/'server.cjs'
        serverfile.write_text("const fs=require('node:fs');const {WebSocketServer}=require("+json.dumps(str(vendor))+ ");\n"
          +"const s=new WebSocketServer({host:'127.0.0.1',port:0});const requests=[];\n"
          +f"s.on('listening',()=>fs.writeFileSync({json.dumps(str(portfile))},JSON.stringify({{port:s.address().port}})));\n"
          +"s.on('connection',c=>{c.send(JSON.stringify({type:'auth_required'}));c.on('message',raw=>{const m=JSON.parse(raw);"
          +"if(m.type==='auth'){c.send(JSON.stringify({type:'auth_ok'}));return}requests.push(m.type);"
          +"if(m.type==='backup/info'){c.send(JSON.stringify({id:m.id,type:'result',success:true,result:{state:'idle',backups:[],agent_errors:{}}}));return}"
          +"if(m.type!=='backup/generate_with_automatic_settings'||Object.keys(m).sort().join()!=='id,type')process.exit(2);"
          +f"fs.writeFileSync({json.dumps(str(counter))},JSON.stringify({{requests,generation_requests:requests.filter(t=>t==='backup/generate_with_automatic_settings').length}}));"
          +"c.send(JSON.stringify({id:m.id,type:'result',success:true,result:{backup_job_id:'fixture_job'}}));});});\n")
        self.server=subprocess.Popen([NODE,*module.FLAGS,str(serverfile)],stdin=subprocess.DEVNULL,
          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
          env={'PATH':'/usr/bin:/bin','WS_NO_BUFFER_UTIL':'1','WS_NO_UTF_8_VALIDATE':'1'})
        deadline=time.monotonic()+10
        while not portfile.exists()and time.monotonic()<deadline:
            self.assertIsNone(self.server.poll());time.sleep(0.01)
        self.assertTrue(portfile.exists());port=json.loads(portfile.read_text())['port']
        local=self.data/'upload.json'
        saved_profile={'schema_version':1,'scope':'ha_saved_backup_profile_v1','agent_id':'onedrive.fixture',
          'password_configured':True,'provider_protected':True,'include_database':False,'include_all_addons':False,
          'include_addons':[],'include_folders':[],'delete_permanently':False,
          'native_retention':{'all_agents_covered':True,'global':{'copies':None,'days':None},
            'agents':[{'agent_id':'onedrive.fixture','copies':None,'days':None}]}}
        self.install("import{prepareBootstrapUpload,savedBackupProfileSha256}from './scripts/offsite-bootstrap-upload.mjs';\n"
          +f"const savedProfile={json.dumps(saved_profile)};\n"
          +"import{createRequire}from 'node:module';const WS=createRequire(import.meta.url)('./nodered/node_modules/ws');\n"
          +f"class OwnedSocket extends WS{{constructor(url){{if(url!=='ws://127.0.0.1:8123/api/websocket')throw Error('endpoint changed');super('ws://127.0.0.1:{port}')}}}}\n"
          +f"const upload=prepareBootstrapUpload({{channel,bundleSha256:'{H}',token:'synthetic-only',WebSocket:OwnedSocket,readSavedProfile:()=>savedProfile,expectedProfileSha256:savedBackupProfileSha256(savedProfile),timeoutMs:15000,readinessTimeoutMs:10000,pollIntervalMs:100,validateSource:()=>true,recordLocalReport:async value=>{{const fd=fixtureFs.openSync({json.dumps(str(local))},'wx',0o600);try{{fixtureFs.writeFileSync(fd,JSON.stringify(value));fixtureFs.fsyncSync(fd)}}finally{{fixtureFs.closeSync(fd)}}return true}}}});\n"
          +"await upload.run();let denied=false;try{await upload.run()}catch{denied=true}if(!denied)throw Error('duplicate worker run');channel.close();\n")
        result=self.launcher.run();self.assertEqual(result['exit_code'],0,(result,(self.data/'child-exit.json').read_text()))
        self.assertEqual(result['state'],'worker_exited_report_unverified');self.assertFalse(result['remote_effect_proven'])
        self.assertEqual(json.loads(counter.read_text()),{'requests':['backup/info','backup/generate_with_automatic_settings'],'generation_requests':1})
        saved=json.loads(local.read_text());self.assertEqual(saved['jobId'],'fixture_job')
        self.assertFalse(saved['report']['independent_acceptance']);self.assertFalse(saved['report']['policy_promoted'])
        records=self.operation()['records'];self.assertEqual([r['body']['phase']for r in records],
          ['bootstrap_begin','bootstrap_worker_bound','bootstrap_remote_intent','bootstrap_report_recorded'])
        report_hash=hashlib.sha256(json.dumps(saved['report'],separators=(',',':')).encode()).hexdigest()
        self.assertEqual(records[-1]['body']['facts']['report_sha256'],report_hash)
        with self.assertRaisesRegex(MaintenanceUnavailable,'launch_consumed'):self.launcher.run()
        self.assertEqual(json.loads(counter.read_text())['generation_requests'],1)
    def test_kernel_credentials_reject_a_descendant_using_the_inherited_socket(self):
        payload=f"import net from 'node:net';const s=new net.Socket({{fd:3,readable:true,writable:true}});s.on('error',()=>{{}});s.end(JSON.stringify({{action:'admit_remote',bundle_sha256:'{H}',request_sha256:'{H}'}})+'\\n');"
        self.install("import {spawn}from 'node:child_process';import{once}from 'node:events';\n"
          +f"const p=spawn(process.execPath,['--input-type=module','-e',{json.dumps(payload)}],{{stdio:['ignore','ignore','ignore',Number(process.env.EVA_BOOTSTRAP_FD)]}});\n"
          +"p.on('error',()=>{});await once(p,'exit');channel.close();")
        with self.assertRaisesRegex(MaintenanceUnavailable,'channel_sender_unconfirmed'):self.launcher.run()
        self.assertFalse(any(r['body']['phase']=='bootstrap_remote_intent'for r in self.operation()['records']))
    def test_entry_file_identity_change_after_exec_blocks_admission_even_with_identical_bytes(self):
        self.install(f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});")
        original=module.Child.start
        def changed(child):
            result=original(child);p=self.worker/'worker.mjs';p.touch();return result
        with patch.object(module.Child,'start',changed),self.assertRaisesRegex(MaintenanceUnavailable,'worker_files_changed'):
            self.launcher.run()
        self.assertFalse(any(r['body']['phase']=='bootstrap_remote_intent'for r in self.operation()['records']))
    def test_queued_report_after_worker_exit_is_data_only_without_any_new_permission(self):
        self.install("import fs from 'node:fs';\n"+f"await channel.admitRemote({{bundleSha256:'{H}',requestSha256:'{H}'}});\n"
          +f"fs.writeSync(Number(process.env.EVA_BOOTSTRAP_FD),JSON.stringify({{action:'record_report',report_sha256:'{H}'}})+'\\n');process.exit(0);")
        result=self.launcher.run();self.assertEqual(result['exit_code'],0,result)
        self.assertFalse(result['independent_acceptance']);self.assertFalse(result['remote_effect_proven'])
        self.assertEqual(self.operation()['records'][-1]['body']['phase'],'bootstrap_report_recorded')
