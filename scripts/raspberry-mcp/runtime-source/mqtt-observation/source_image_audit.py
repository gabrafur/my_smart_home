"""Execute an isolated native ABI/source audit from one fixed Root job.

No pull, install, residential mount, payload capture or caller-selected target.
The approved updater supplies the job before this actor may create its probe.
"""
from dataclasses import dataclass
from pathlib import Path
import hashlib,io,os,re,selectors,shutil,subprocess,tarfile,time
from maintenance_backend import read,decode,directory
from maintenance_journal import canonical,digest,closed,hex64,uint,MaintenanceUnavailable,validate_operation
from maintenance_controller import dispatch_invariants,facts

SDK_MANIFEST_SHA256='8af44dd14ef742319ababd46908561a404916f55351f502b970722f500393aae'
PROJECT_LICENSE_SHA256='3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'
KINDS={'publish_in','publish_out','connect','disconnect','subscribe','unsubscribe','client_offline'}
@dataclass(frozen=True)
class Paths:
    work:Path=Path('/run/raspberry-mqtt-image-audit')
    plugin:Path=Path('/opt/raspberry-mqtt-observation/native/observer.so')
    notices:Path=Path('/opt/raspberry-mqtt-observation/native/licenses')
    configuration:Path=Path('/etc/raspberry-mqtt-observation/mosquitto.conf')
    production_ipc:Path=Path('/run/raspberry-mqtt-observation')
    docker_config:Path=Path('/etc/raspberry-mqtt-maintenance/docker-cli')

def need(value,reason='image_audit_unconfirmed'):
    if not value:raise MaintenanceUnavailable(reason)

def bounded(args,*,limit=65536,timeout=15):
    """Bound bytes while receiving, including on a failed Docker command."""
    p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
      env={'PATH':'/usr/bin:/bin','LC_ALL':'C','GOMAXPROCS':'1','GOMEMLIMIT':'64MiB'},close_fds=True)
    streams=selectors.DefaultSelector();output={};end=time.monotonic()+timeout
    try:
        for name,pipe in [('stdout',p.stdout),('stderr',p.stderr)]:
            os.set_blocking(pipe.fileno(),False);streams.register(pipe,selectors.EVENT_READ,name);output[name]=bytearray()
        while streams.get_map():
            need(time.monotonic()<end,'image_audit_command_deadline')
            for key,_ in streams.select(min(.1,max(0,end-time.monotonic()))):
                raw=os.read(key.fileobj.fileno(),8192)
                if not raw:streams.unregister(key.fileobj);continue
                output[key.data].extend(raw)
                need(len(output[key.data])<=(limit if key.data=='stdout'else 8192),'image_audit_output_bound')
        p.wait(timeout=max(.01,end-time.monotonic()))
        return p.returncode,bytes(output['stdout']),bytes(output['stderr'])
    finally:
        streams.close()
        if p.poll()is None:p.kill();p.wait(timeout=3)
        p.stdout.close();p.stderr.close()

def binary_digest(raw):
    need(type(raw)is bytes and len(raw)<=16777216,'image_audit_binary_archive_bound')
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as archive:
        members=[]
        for item in archive:
            members.append(item);need(len(members)==1,'image_audit_binary_archive_shape')
        need(len(members)==1,'image_audit_binary_archive_shape');item=members[0]
        need(item.name=='mosquitto'and item.isfile()and 64<=item.size<=8388608,'image_audit_binary_archive_shape')
        data=archive.extractfile(item).read(8388609)
        need(len(data)==item.size and data[:6]==b'\x7fELF\x02\x01'
          and int.from_bytes(data[18:20],'little')==183,'image_audit_binary_architecture')
        return hashlib.sha256(data).hexdigest()

def image_origin(rows,expected):
    need(len(rows)==4 and rows[0]==expected and rows[1:3]==['arm64','linux'],'image_audit_image_identity')
    repos=decode(rows[3].encode());need(type(repos)is list and len(repos)<=16)
    candidates=[v for v in repos if type(v)is str and re.fullmatch(r'(?:docker\.io/library/)?eclipse-mosquitto@sha256:[a-f0-9]{64}',v)]
    need(candidates,'image_audit_image_origin');return sorted(candidates)[0]

CLIENT='''set -eu
ulimit -v 131072
ulimit -t 10
mosquitto_sub -h 127.0.0.1 -c -i synthetic-persistent -t synthetic/allowed/item -U synthetic/unused -q 1 -C 1 -W 8 > /tmp/received &
probe_subscriber_pid=$!
probe_waits=0
while ! grep -q 'Received SUBSCRIBE from synthetic-persistent' /tmp/broker.log; do
 kill -0 "$probe_subscriber_pid"
 probe_waits=$((probe_waits+1)); [ "$probe_waits" -le 200 ] || exit 75
 sleep 0.02
done
mosquitto_pub -h 127.0.0.1 -t synthetic/allowed/item -m SYNTHETIC_PAYLOAD_CANARY -q 1
wait "$probe_subscriber_pid"
[ "$(cat /tmp/received)" = SYNTHETIC_PAYLOAD_CANARY ]
'''

class Producer:
    def __init__(self,tx,backend,op,paths=Paths()):
        validate_operation(op);need(op['records'][-1]['body']['phase']=='consumer_ready')
        dispatch_invariants(op,'start_source');self.tx=tx;self.backend=backend;self.op=op;self.paths=paths
        self.name='image-audit-'+op['operation_id']+'.json';self.receipt=None;self.child=None
        self.fixture=paths.work/('mqtt-image-audit-'+op['operation_id'])
        self.probe='mqtt-image-audit-'+op['operation_id'];self.cid=None;self.stdout_buffer=bytearray()
    def _job(self):
        b=self.backend;raw=read(b.paths.policy.parent/'source-audit-job.json',0,0,0o600,8192);v=decode(raw)
        closed(v,['schema_version','source','operation_id','approval_sha256','journal_head_sha256','clock_domain_sha256',
                  'issued_at_ns','before_policy_sha256','target','image_id','broker_configuration_sha256'])
        need(type(v['schema_version'])is int and v['schema_version']==1 and v['source']=='fixed_Root_mqtt_image_audit_job')
        need(v['operation_id']==self.op['operation_id']and v['approval_sha256']==self.op['approval_sha256']
          and v['journal_head_sha256']==self.op['records'][-1]['sha256']
          and v['clock_domain_sha256']==self.op['records'][0]['body']['clock_domain_sha256'])
        need(all(hex64(v[k])for k in ['approval_sha256','journal_head_sha256','clock_domain_sha256',
                                      'before_policy_sha256','broker_configuration_sha256']))
        now,domain=b.clock();need(domain==v['clock_domain_sha256']and
          uint(self.op['records'][-1]['body']['at_ns'],64)<=uint(v['issued_at_ns'],64)<=uint(now,64))
        need(type(v['image_id'])is str and re.fullmatch('sha256:[a-f0-9]{64}',v['image_id']))
        closed(v['target'],['container_id','identity_sha256']);need(all(hex64(x)for x in v['target'].values()))
        return raw,v
    def _save(self):
        self.tx._anchors();self.tx._atomic(self.tx.state_fd,self.name,
          canonical({'body':self.receipt,'sha256':digest(self.receipt)}),0o600)
    def _load(self,raw):
        self.tx._anchors()
        try:data=self.tx._read(self.tx.state_fd,self.name,0o600)
        except FileNotFoundError:return None
        value=decode(data);closed(value,['body','sha256']);need(value['sha256']==digest(value['body'])and canonical(value)==data)
        r=value['body'];closed(r,['schema_version','operation_id','approval_sha256','journal_head_sha256','job_sha256',
          'phase','probe_name','probe_container_id','effect_intents','proof','candidate','candidate_before_hex','cleanup_confirmed','failure'])
        need(r['schema_version']==1 and type(r['schema_version'])is int
          and r['operation_id']==self.op['operation_id']and r['approval_sha256']==self.op['approval_sha256']
          and r['journal_head_sha256']==self.op['records'][-1]['sha256']
          and r['job_sha256']==hashlib.sha256(raw).hexdigest()and r['probe_name']==self.probe
          and r['phase']in('intent','probe_verified','candidate_write_intent','candidate_written','failed')
          and type(r['cleanup_confirmed'])is bool and type(r['effect_intents'])is list and len(r['effect_intents'])<=8)
        need(r['probe_container_id']is None or hex64(r['probe_container_id']))
        need(all(v in('create','start','exec','stop','rm')for v in r['effect_intents']))
        need(r['failure']is None or type(r['failure'])is str and re.fullmatch('[A-Za-z_]{1,80}',r['failure']))
        if r['candidate']is not None:
            candidate=r['candidate'];need(type(candidate)is dict
              and candidate.get('operation_id')==self.op['operation_id']
              and candidate.get('approval_sha256')==self.op['approval_sha256']
              and candidate.get('journal_head_sha256')==self.op['records'][-1]['sha256'])
        need(r['phase']!='candidate_written'or r['candidate']is not None and r['proof']is not None and r['cleanup_confirmed'])
        return r
    def _docker(self,args,*,limit=65536,timeout=15,check=True):
        result=bounded(['/usr/bin/docker','--config',str(self.paths.docker_config),
          '--host','unix:///var/run/docker.sock',*args],limit=limit,timeout=timeout)
        if check:need(result[0]==0,'image_audit_command_unconfirmed')
        return result
    def _effect(self,kind,args,**options):
        self.backend.authorize(self.op,mutation=True)
        self.receipt['effect_intents'].append(kind);self._save();return self._docker(args,**options)
    def _configuration(self,job):
        raw=read(self.paths.configuration,0,0,0o444,65536)
        need(hashlib.sha256(raw).hexdigest()==job['broker_configuration_sha256'],'image_audit_configuration_changed')
        target=self.backend._inspect_target(job['target']);s=target['state']
        need(target['image_id']==job['image_id']and not any(s[k]for k in ['Running','Paused','Restarting','Dead'])
          and s['Pid']==0 and s['ExitCode']==0,'image_audit_target_changed')
        expected={'/mosquitto/config/mosquitto.conf':self.paths.configuration,
                  '/mosquitto/metadata/observer.so':self.paths.plugin,
                  '/run/raspberry-mqtt-observation':self.paths.production_ipc}
        for destination,source in expected.items():
            mounts=[x for x in target['mounts']if x['Destination']==destination]
            need(len(mounts)==1 and mounts[0]['Type']=='bind'and mounts[0]['RW']is False
              and mounts[0]['Source']==str(source),'image_audit_mount_changed')
    def _notices(self):
        directory(self.paths.notices,0,0,0o755)
        raw=read(self.paths.notices/'sdk-manifest.json',0,0,0o444,65536)
        need(hashlib.sha256(raw).hexdigest()==SDK_MANIFEST_SHA256,'image_audit_sdk_provenance_changed')
        manifest=decode(raw)
        expected={'LICENSE.project':PROJECT_LICENSE_SHA256,
          **{name:next(x['sha256']for x in manifest['files']if x['path']==upstream)
             for name,upstream in [('LICENSE.sdk.txt','LICENSE.txt'),('EDL-v1.0.txt','edl-v10'),('EPL-v2.0.txt','epl-v20')]}}
        for name,value in expected.items():
            need(hashlib.sha256(read(self.paths.notices/name,0,0,0o444,65536)).hexdigest()==value,'image_audit_license_changed')
    def _line(self):
        need(self.child is not None)
        end=time.monotonic()+15
        while time.monotonic()<end:
            if b'\n'in self.stdout_buffer:
                line,_,rest=self.stdout_buffer.partition(b'\n');self.stdout_buffer=bytearray(rest)
                v=decode(line);need(v.get('stage')!='unconfirmed','image_audit_witness_unconfirmed');return v
            if selectors_poll(self.child.stdout,.1):
                raw=os.read(self.child.stdout.fileno(),8192);need(raw,'image_audit_witness_exited')
                self.stdout_buffer.extend(raw);need(len(self.stdout_buffer)<=32768)
            need(self.child.poll()is None,'image_audit_witness_exited')
        raise MaintenanceUnavailable('image_audit_witness_deadline')
    def _cleanup(self,job):
        # Cleanup is limited to a handle returned by this operation's create.
        # A lost create response remains uncertain; no target is guessed by name.
        if self.child is not None and self.child.poll()is None:
            self.child.terminate()
            try:self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=3)
        if self.child is not None:
            self.child.stdout.close();self.child.stderr.close()
        if self.cid is None:
            if 'create'not in self.receipt['effect_intents']:return True
            code,raw,error=self._docker(['inspect','--format',
              '{{.Id}}\n{{.Image}}\n{{index .Config.Labels "org.openai.mqtt.image-audit"}}\n{{json .Mounts}}',self.probe],check=False)
            if code!=0:return b'no such'in error.lower()
            rows=raw.decode().splitlines();need(len(rows)==4 and hex64(rows[0])and rows[1:3]==[job['image_id'],self.op['operation_id']],
                                               'image_audit_owned_handle_changed')
            mounts=decode(rows[3].encode());need(any(x.get('Source')==str(self.fixture/'ipc')
              and x.get('Destination')=='/run/raspberry-mqtt-observation'and x.get('Type')=='bind'
              and x.get('RW')is False for x in mounts),'image_audit_owned_handle_changed')
            self.cid=rows[0];self.receipt['probe_container_id']=self.cid;self._save()
        code,raw,_=self._docker(['inspect','--format','{{.Id}}\n{{.Image}}\n{{json .State.Running}}',self.cid],check=False)
        need(code==0,'image_audit_cleanup_unconfirmed');parts=raw.decode().splitlines()
        need(len(parts)==3 and parts[:2]==[self.cid,job['image_id']],'image_audit_owned_handle_changed')
        if decode(parts[2].encode())is True:
            self.receipt['effect_intents'].append('stop');self._save();self._docker(['stop','--time','3',self.cid],timeout=8)
        self.receipt['effect_intents'].append('rm');self._save();self._docker(['rm','-v',self.cid])
        return True
    def run(self):
        raw,job=self._job();self.receipt=self._load(raw)
        if self.receipt is not None:
            r=self.receipt;confirmed=False
            if r['phase']=='candidate_written'and r['cleanup_confirmed']:
                actual=read(self.backend.paths.policy.parent/'source-candidate.json',0,0,0o600,8192)
                confirmed=actual==canonical(r['candidate'])
            return {'state':'image_audit_verified_candidate_prepared'if confirmed else'image_audit_result_unconfirmed',
              'dispatched':False,'automatic_retry':False,'residential_dispatched':False}
        b=self.backend;b.authorize(self.op,mutation=True)
        need(len(os.fsencode(self.fixture/'ipc/source.sock'))<=107,'image_audit_socket_path_bound')
        need(facts(self.op,'begin')['purpose']=='container_update'and job['before_policy_sha256']==b.policy_sha)
        m,c=b.snapshot();b._check_rebind_context(self.op,m,c)
        need(m['source_policy_sha256']==digest(b.policy['source_definition']))
        directory(self.paths.work,0,0,0o711);directory(self.paths.docker_config,0,0,0o700)
        need(not any(self.paths.docker_config.iterdir()),'image_audit_cli_configuration_not_empty')
        self._notices();self._configuration(job)
        plugin=read(self.paths.plugin,0,0,0o444,8388608);plugin_sha=hashlib.sha256(plugin).hexdigest()
        need(plugin_sha==b.policy['source_definition']['plugin_sha256'],'image_audit_plugin_changed')
        metadata=self._docker(['image','inspect','--format','{{.Id}}\n{{.Architecture}}\n{{.Os}}\n{{json .RepoDigests}}',job['image_id']])[1]
        origin=image_origin(metadata.decode().splitlines(),job['image_id'])
        absent=self._docker(['inspect','--format','{{.Id}}',self.probe],check=False)
        need(absent[0]!=0 and b'no such'in absent[2].lower(),'image_audit_probe_exists')
        candidate_path=b.paths.policy.parent/'source-candidate.json'
        try:old_candidate=read(candidate_path,0,0,0o600,8192)
        except FileNotFoundError:old_candidate=None
        if old_candidate is not None:
            old=decode(old_candidate);value=decode(self.tx._read(self.tx.state_fd,'maintenance.json',0o600))
            need(value['sha256']==digest(value['body']))
            need(any(x['operation_id']==old.get('operation_id')and x['records'][-1]['body']['phase']=='complete'
                     for x in value['body']['operations']),'image_audit_prior_candidate_unresolved')
        self.receipt={'schema_version':1,'operation_id':self.op['operation_id'],'approval_sha256':self.op['approval_sha256'],
          'journal_head_sha256':self.op['records'][-1]['sha256'],'job_sha256':hashlib.sha256(raw).hexdigest(),
          'phase':'intent','probe_name':self.probe,'probe_container_id':None,'effect_intents':[],'proof':None,
          'candidate':None,'candidate_before_hex':None if old_candidate is None else old_candidate.hex(),
          'cleanup_confirmed':False,'failure':None};self._save()
        failure=None
        try:
            self.fixture.mkdir(mode=0o711);self.fixture.chmod(0o711)
            for name,mode in [('ipc',0o755),('state',0o700)]:
                (self.fixture/name).mkdir(mode=mode);(self.fixture/name).chmod(mode)
            config=self.fixture/'mosquitto.conf';config.write_text('listener 1883 127.0.0.1\nallow_anonymous true\npersistence false\nlog_dest file /tmp/broker.log\nlog_type all\nglobal_plugin /mosquitto/metadata/observer.so\n');config.chmod(0o444)
            args=['create','--name',self.probe,'--label','org.openai.mqtt.image-audit='+self.op['operation_id'],
              '--network','none','--read-only','--user','1883:1883','--cpus','.1','--pids-limit','32',
              '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777']
            for source,destination in [(config,'/fixture/mosquitto.conf'),(self.paths.plugin,'/mosquitto/metadata/observer.so'),(self.fixture/'ipc','/run/raspberry-mqtt-observation')]:
                args+=['--mount','type=bind,src='+str(source)+',dst='+destination+',readonly']
            args+=['--entrypoint','/bin/sh',job['image_id'],'-c','ulimit -v 131072; exec /usr/sbin/mosquitto -c /fixture/mosquitto.conf']
            self.cid=self._effect('create',args)[1].decode().strip();need(hex64(self.cid));self.receipt['probe_container_id']=self.cid;self._save()
            binary_sha=binary_digest(self._docker(['cp','-L',self.cid+':/usr/sbin/mosquitto','-'],limit=16777216)[1])
            source_auth=decode(read(b.paths.reader_state/'authorization.json',0,0,0o600,4096))
            expires=min([time.time()+120]+[x for x in [b.policy['expires_at'],source_auth['expires_at']]if x is not None])
            request=self.fixture/'request.json';request.write_bytes(canonical({'container_id':self.cid,'binary_sha256':binary_sha,
              'plugin_sha256':plugin_sha,'approval_sha256':self.op['approval_sha256'],'expires_at':expires}));request.chmod(0o600)
            self.child=subprocess.Popen(['/usr/bin/python3','-I','-S','-B',str(b.paths.root_code/'image_audit_reader.py'),str(self.fixture)],
              stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
            os.set_blocking(self.child.stdout.fileno(),False)
            need(self._line()=={'stage':'ready'});self._effect('start',['start',self.cid]);need(self._line()=={'stage':'live_verified'})
            self._effect('exec',['exec','--user','1883:1883',self.cid,'/bin/sh','-c',CLIENT],timeout=12)
            need(self._line()=={'stage':'seven_classes_observed'});(self.fixture/'pause').touch()
            need(self._line()=={'stage':'intake_paused'});self._effect('stop',['stop','--time','3',self.cid],timeout=8)
            (self.fixture/'broker-exited').touch();proof=self._line();need(proof.get('stage')=='verified')
            need(self.child.wait(timeout=5)==0 and not self.child.stderr.read(8193),'image_audit_witness_failed')
            need(set(proof['seven_classes'])==KINDS and proof['source_closed']is True and proof['sender_pidfd_exited']is True
              and proof['unknown_epoch_tails']=='0'and proof['wire_version']==3)
            self.receipt['proof']={'native':proof,'image_id':job['image_id'],'repository_digest':origin,
              'binary_sha256':binary_sha,'plugin_sha256':plugin_sha,'sdk_manifest_sha256':SDK_MANIFEST_SHA256,
              'broker_configuration_sha256':job['broker_configuration_sha256'],'license_bundle_verified':True}
            self.receipt['phase']='probe_verified';self._save()
        except Exception as exc:
            failure=str(exc)if isinstance(exc,MaintenanceUnavailable)and re.fullmatch('[a-z_]{1,80}',str(exc))else type(exc).__name__
        finally:
            try:self.receipt['cleanup_confirmed']=self._cleanup(job)
            except Exception:failure=failure or'image_audit_cleanup_unconfirmed'
            self.receipt['failure']=failure
            if failure is not None:self.receipt['phase']='failed'
            self._save()
        need(failure is None and self.receipt['cleanup_confirmed'],'image_audit_failed')
        directory(self.fixture,0,0,0o711)
        need(self.fixture.parent==self.paths.work and self.fixture.resolve()==self.fixture)
        shutil.rmtree(self.fixture)
        b.authorize(self.op,mutation=True);self._configuration(job);self._notices()
        need(read(b.paths.policy.parent/'source-audit-job.json',0,0,0o600,8192)==raw,'image_audit_job_changed')
        m,c=b.snapshot();b._check_rebind_context(self.op,m,c)
        candidate={'schema_version':1,'source':'fixed_Root_audited_mqtt_replacement','operation_id':self.op['operation_id'],
          'approval_sha256':self.op['approval_sha256'],'journal_head_sha256':self.op['records'][-1]['sha256'],
          'clock_domain_sha256':job['clock_domain_sha256'],'issued_at_ns':b.clock()[0],'before_policy_sha256':job['before_policy_sha256'],
          'target':job['target'],'source_definition':{**b.policy['source_definition'],'container_id':job['target']['container_id'],
            'binary_sha256':self.receipt['proof']['binary_sha256'],'plugin_sha256':plugin_sha},
          'audit':{'kind':'fixed_mosquitto_replacement_audit_v1','image_id':job['image_id'],
                   'binary_sha256':self.receipt['proof']['binary_sha256'],'plugin_sha256':plugin_sha}}
        self.receipt['candidate']=candidate;self.receipt['phase']='candidate_write_intent';self._save()
        fd=os.open(b.paths.policy.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            directory(b.paths.policy.parent,0,0,0o700);opened=os.fstat(fd);named=b.paths.policy.parent.lstat()
            need((opened.st_dev,opened.st_ino)==(named.st_dev,named.st_ino))
            try:actual=read(candidate_path,0,0,0o600,8192)
            except FileNotFoundError:actual=None
            need(actual==old_candidate,'image_audit_candidate_compare_conflict');b.authorize(self.op,mutation=True)
            self.tx._atomic(fd,'source-candidate.json',canonical(candidate),0o600)
        finally:os.close(fd)
        self.receipt['phase']='candidate_written';self._save()
        return {'state':'image_audit_verified_candidate_prepared','dispatched':True,'native_audit_dispatched':True,
          'configuration_dispatched':True,'residential_dispatched':False,'automatic_retry':False}

def selectors_poll(pipe,timeout):
    with selectors.DefaultSelector()as s:
        s.register(pipe,selectors.EVENT_READ);return bool(s.select(timeout))
