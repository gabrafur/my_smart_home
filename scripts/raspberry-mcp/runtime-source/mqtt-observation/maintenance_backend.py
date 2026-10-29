"""Fixed-container backend; no command, path, target or fact API for a caller.

Inactive until a separately reviewed Root policy and immutable code are
installed. All subprocess output stays internal; errors expose fixed codes.
"""
from dataclasses import dataclass
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,time
from maintenance_journal import canonical,digest,closed,hex64,uint,MaintenanceUnavailable
from maintenance_controller import ObservationUnavailable,BoundaryRejected,dispatch_invariants,records,facts,COMMANDS
from source_binding import ProcHandle,start_ticks,local_clock_domain,credentials_from_status,Peer
from authorization_gate import SCOPE as SOURCE_SCOPE,AuthorizationGate,GateInvalid
from handoff import HEADERS,FAULTS,KINDS,STAT_COLUMNS,validate_totals,add_totals
from receiver_ledger import stringify

SCOPE='mqtt_metadata_maintenance_v1'
@dataclass(frozen=True)
class Paths:
    policy:Path=Path('/etc/raspberry-mqtt-maintenance/policy.json')
    reader_state:Path=Path('/var/lib/raspberry-mqtt-observation')
    root_code:Path=Path('/opt/raspberry-mqtt-observation')
    consumer_code:Path=Path('/opt/raspberry-mqtt-observation/consumer')
    consumer_state:Path=Path('/mnt/data/docker/nodered/.mqtt-source-observer-consumer')
    reader_runtime:Path=Path('/run/raspberry-mqtt-observation')

def need(ok,code='maintenance_backend_unavailable'):
    if not ok:raise MaintenanceUnavailable(code)
def read(path,uid,gid,mode,limit):
    path=Path(path);need(path.is_absolute()and path.resolve()==path)
    parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        for part in path.parent.parts[1:]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            os.close(parent);parent=nxt
        fd=os.open(path.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
    finally:os.close(parent)
    try:
        a=os.fstat(fd);need(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and
          (a.st_uid,a.st_gid,stat.S_IMODE(a.st_mode))==(uid,gid,mode)and a.st_size<=limit)
        raw=os.read(fd,limit+1);b=os.fstat(fd)
        need(len(raw)==a.st_size and(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==
          (b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns));return raw
    finally:os.close(fd)
def decode(raw):
    def pairs(rows):
        d={}
        for k,v in rows:need(k not in d);d[k]=v
        return d
    try:return json.loads(raw,object_pairs_hook=pairs)
    except(ValueError,UnicodeError):raise MaintenanceUnavailable('maintenance_json_invalid')from None
def directory(path,uid,gid,mode):
    path=Path(path);s=path.lstat();need(path.resolve()==path and stat.S_ISDIR(s.st_mode)
      and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(uid,gid,mode))
def counts(value):
    closed(value,set(HEADERS)|{'faults','stats'});closed(value['faults'],FAULTS);closed(value['stats'],KINDS)
    result={k:uint(value[k],128)for k in HEADERS};result['faults']={k:uint(value['faults'][k],128)for k in FAULTS}
    result['stats']={}
    for kind in KINDS:
        closed(value['stats'][kind],STAT_COLUMNS);result['stats'][kind]={k:uint(value['stats'][kind][k],128)for k in STAT_COLUMNS}
    validate_totals(result);return value

def confirmed_cut(metadata,consumer):
    """An exact shared receipt, or its Root-attested one-packet prefix.

    Consumer persistence and Root ACK advance asynchronously. The pending
    packet binds its previous receipt and exact counter delta; its hash must
    equal the packet already acknowledged by Root. No numeric-only subset.
    """
    def reject():raise ObservationUnavailable('final_ACK_cut_unconfirmed')
    try:
        root=metadata['ack_receipt'];closed(root,['bucket_id','packet_sha256','receipt_sha256'])
        need(all(hex64(root[k])for k in ['packet_sha256','receipt_sha256']))
        current=uint(root['bucket_id'],64);old=uint(consumer['last_receipt'],64)
        acked=counts(consumer['acked_counts']);native=counts(metadata['acknowledged_counts'])
        if current==old:
            if root['receipt_sha256']!=consumer['last_receipt_sha']or native!=acked:reject()
            return acked
        packet=consumer['pending']
        if current!=old+1 or packet is None or packet['body']['bucket_id']!=root['bucket_id']:reject()
        if(digest(packet['body'])!=packet['sha256']or packet['sha256']!=root['packet_sha256']
          or digest(packet['body']['previous_ack'])!=consumer['last_receipt_sha']):reject()
        delta=counts(packet['body']['aggregate']['counts'])
        def integers(v):return {k:integers(x)for k,x in v.items()}if type(v)is dict else int(v)
        total=integers(acked);add_totals(total,integers(delta))
        if stringify(total)!=native or counts(consumer['received_counts'])!=native:reject()
        return acked
    except(KeyError,TypeError,ValueError,MaintenanceUnavailable):reject()

class Backend:
    def __init__(self,paths=Paths(),*,run=subprocess.run,audit_paths=None):
        need(os.geteuid()==0 and os.getegid()==0,'maintenance_role_invalid')
        self.paths=paths;self.run=run;self.audit_paths=audit_paths;directory(paths.policy.parent,0,0,0o700)
        raw=read(paths.policy,0,0,0o600,8192);self.policy_sha=hashlib.sha256(raw).hexdigest();p=decode(raw)
        closed(p,['schema_version','scope','enabled','expires_at','approval_sha256','code_manifest_sha256',
                  'source','consumer','source_definition','root_files','consumer_files'])
        need(type(p['schema_version'])is int and p['schema_version']==1 and p['scope']==SCOPE
          and type(p['enabled'])is bool and hex64(p['approval_sha256'])and hex64(p['code_manifest_sha256']))
        need(p['expires_at']is None or type(p['expires_at'])in(int,float)and 0<p['expires_at']<2**53)
        for role in ['source','consumer']:
            closed(p[role],['container_id','identity_sha256']);need(all(hex64(v)for v in p[role].values()))
        need(p['source']['container_id']!=p['consumer']['container_id'])
        definition=p['source_definition'];closed(definition,['schema_version','container_id','binary_sha256','plugin_sha256','approval_id'])
        need(type(definition['schema_version'])is int and definition['schema_version']==1
          and all(hex64(definition[k])for k in definition if k!='schema_version')
          and definition['container_id']==p['source']['container_id']and definition['approval_id']==p['approval_sha256'])
        from deployment_files import CORE,CONSUMER
        need(type(p['root_files'])is dict and set(p['root_files'])==set(CORE))
        need(type(p['consumer_files'])is dict and set(p['consumer_files'])==set(CONSUMER))
        need(all(hex64(v)for group in ['root_files','consumer_files']for v in p[group].values()))
        need(p['code_manifest_sha256']==digest({'root_files':p['root_files'],'consumer_files':p['consumer_files']}))
        self.policy=p
    def clock(self):return str(time.clock_gettime_ns(time.CLOCK_BOOTTIME)),local_clock_domain()
    def authorize(self,op,*,mutation):
        p=self.policy;raw=read(self.paths.policy,0,0,0o600,8192)
        need(hashlib.sha256(raw).hexdigest()==self.policy_sha,'maintenance_policy_changed')
        if mutation or op is None:
            need(p['enabled']and(p['expires_at']is None or time.time()<p['expires_at']),'maintenance_authorization_closed')
            source=decode(read(self.paths.reader_state/'authorization.json',0,0,0o600,4096))
            closed(source,['version','scope','enabled','expires_at','approval_id'])
            need(type(source['version'])is int and source['version']==1 and source['scope']==SOURCE_SCOPE
              and source['enabled']is True and source['approval_id']==p['approval_sha256']
              and(source['expires_at']is None or type(source['expires_at'])in(int,float)and time.time()<source['expires_at']),
              'maintenance_source_authorization_closed')
            self._source_runtime_authority()
        if op is not None:
            need(op['approval_sha256']==p['approval_sha256'],'maintenance_approval_changed')
            need(facts(op,'begin')['code_manifest_sha256']==p['code_manifest_sha256'],'maintenance_code_manifest_changed')
        self.verify_installed_code()
    def _source_runtime_authority(self):
        # Fixed entrypoint binding. A live file grant never overrides the
        # reader's persistent revocation marker; neither is modified here.
        gate=None
        try:
            gate=AuthorizationGate(self.paths.reader_runtime,self.paths.reader_state/'authorization.json')
            gate._runtime_anchor()
            try:info=os.stat('revoked',dir_fd=gate.runtime_fd,follow_symlinks=False)
            except FileNotFoundError:info=None
            gate._runtime_anchor()
            if info is not None:
                need(gate._marker_valid(info),'maintenance_source_revocation_marker_invalid')
                raise MaintenanceUnavailable('maintenance_source_revoked')
        except(GateInvalid,OSError):raise MaintenanceUnavailable('maintenance_source_runtime_unconfirmed')from None
        finally:
            if gate is not None:gate.close()
    def verify_installed_code(self):
        """Integrity only; the closed data-backup profile grants its own scope."""
        p=self.policy
        need(hashlib.sha256(read(self.paths.policy,0,0,0o600,8192)).hexdigest()==self.policy_sha,'maintenance_policy_changed')
        # Paths are fixed by the installed entrypoint, names by this allowlist.
        for group,parent in [('root_files',self.paths.root_code),('consumer_files',self.paths.consumer_code)]:
            directory(parent,0,0,0o755)
            for name,expected in p[group].items():
                need(hashlib.sha256(read(parent/name,0,0,0o644,1048576)).hexdigest()==expected,'maintenance_code_changed')
    def _run(self,args,timeout=8,limit=131072):
        try:r=self.run(['/usr/bin/docker',*args],capture_output=True,timeout=timeout,
          env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
        except (OSError,subprocess.TimeoutExpired):raise ObservationUnavailable('fixed_subprocess_unconfirmed')from None
        if r.returncode or len(r.stdout)>limit or len(r.stderr)>65536:raise ObservationUnavailable('fixed_subprocess_unconfirmed')
        return r.stdout
    def authorize_rescue(self,op):
        # Separate, initially sealed restore scope. It never re-enables the
        # metadata grant and cannot outlive the master maintenance authority.
        self.authorize(op,mutation=False);p=self.policy;b=facts(op,'begin')
        need(p['enabled']and(p['expires_at']is None or time.time()<p['expires_at']),
             'maintenance_authorization_closed')
        need(b['purpose']=='backup_snapshot'and all(p[role]['identity_sha256']==b[role+'_binding_sha256']
             for role in('source','consumer')),'rescue_binding_changed')
    def validate_rescue_duration(self,duration_ns):
        expires=self.policy['expires_at']
        need(expires is None or time.time()+duration_ns/1_000_000_000<expires,
             'rescue_authority_too_short')
    def inspect(self,role):
        need(role in('source','consumer'));target=self.policy[role]
        return self._inspect_target(target)
    def _inspect_target(self,target):
        closed(target,['container_id','identity_sha256']);need(all(hex64(v)for v in target.values()))
        # Never request Config.Env, logs, payloads or arbitrary Docker objects.
        # State.Health.Log contains application log output. Select only the
        # process lifecycle fields in Docker's template, before receiving bytes.
        state='{'+','.join('"'+k+'":{{json .State.'+k+'}}'for k in
          ('Running','Paused','Restarting','Dead','Pid','StartedAt','FinishedAt','ExitCode'))+'}'
        projection='{{json .Id}}\n{{json .Image}}\n{{json .Config.User}}\n'+state+'\n{{json .Mounts}}\n{{json .HostConfig.ReadonlyRootfs}}\n{{json .HostConfig.NetworkMode}}'
        rows=self._run(['inspect','--format',projection,target['container_id']],limit=65536).splitlines()
        need(len(rows)==7);v=[decode(row)for row in rows]
        need(v[0]==target['container_id']and type(v[3])is dict)
        identity={'container_id':v[0],'image_id':v[1],'user':v[2],'mounts':sorted(v[4],key=lambda x:x['Destination']),
          'readonly_rootfs':v[5],'network_mode':v[6]}
        need(digest(identity)==target['identity_sha256'],'maintenance_binding_changed')
        state={key:v[3][key]for key in('Running','Paused','Restarting','Dead','Pid','StartedAt','FinishedAt','ExitCode')}
        need(all(type(state[k])is bool for k in('Running','Paused','Restarting','Dead'))
          and all(type(state[k])is int for k in('Pid','ExitCode'))and all(type(state[k])is str for k in('StartedAt','FinishedAt')))
        return {'binding_sha256':target['identity_sha256'],'state':state,'state_sha256':digest(state),'image_id':v[1],'mounts':v[4]}
    def snapshot(self):
        directory(self.paths.reader_state,0,0,0o700)
        raw=read(self.paths.reader_state/'maintenance-status.json',0,0,0o600,16384);v=decode(raw)
        closed(v,['body','sha256']);need(v['sha256']==digest(v['body'])and raw==canonical(v));m=v['body']
        closed(m,['schema_version','source','reader_pid','reader_start_ticks','source_policy_sha256','reader','accepted_frames','acknowledged_frames',
          'acknowledged_counts','ack_receipt','pending_packet','active_counts_nonempty','unknown_epoch_tails','full24h_proven','effect_executed'])
        need(type(m['schema_version'])is int and m['schema_version']==1 and m['source']=='fixed_live_mqtt_maintenance_facts')
        need(hex64(m['source_policy_sha256']))
        for key in ['accepted_frames','acknowledged_frames','unknown_epoch_tails']:uint(m[key],128)
        counts(m['acknowledged_counts']);need(m['acknowledged_frames']==m['acknowledged_counts']['frames'])
        if m['ack_receipt']is not None:
            closed(m['ack_receipt'],['bucket_id','packet_sha256','receipt_sha256']);uint(m['ack_receipt']['bucket_id'],64)
            need(all(hex64(m['ack_receipt'][k])for k in ['packet_sha256','receipt_sha256']))
        need(m['full24h_proven']is False and m['effect_executed']is False
          and type(m['pending_packet'])is bool and type(m['active_counts_nonempty'])is bool)
        reader=m['reader'];now,domain=self.clock()
        need(reader['schema_version']==2 and reader['source']=='fixed_mqtt_metadata_reader'
          and reader['clock_domain_sha256']==domain
          and uint(reader['reader_observed_boottime_ns'],64)<=uint(now,64),'maintenance_reader_clock_unknown')
        pid=uint(m['reader_pid'],32);need(pid>0)
        process=ProcHandle(pid)
        try:
            credentials_from_status(process.text('status',16384),Peer(pid,0,0))
            need(start_ticks(process.text('stat',8192),pid)==uint(m['reader_start_ticks'],64),'maintenance_reader_process_changed')
            process.alive()
        finally:process.close()
        consumer=self.inspect('consumer')
        if not consumer['state']['Running']:
            directory(self.paths.consumer_state,1000,1000,0o700)
            raw=read(self.paths.consumer_state/'state.json',1000,1000,0o600,131072)
            try:
                value=self.run(['/usr/bin/node','--jitless','--max-old-space-size=64',
                  str(self.paths.consumer_code/'maintenance_checkpoint.mjs')],input=raw,capture_output=True,timeout=6,
                  env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
            except(OSError,subprocess.TimeoutExpired):raise ObservationUnavailable('checkpoint_validation_unconfirmed')from None
            if value.returncode or len(value.stdout)>131072 or len(value.stderr)>4096:
                raise ObservationUnavailable('checkpoint_validation_unconfirmed')
            result=decode(value.stdout)
            if result.get('state')!='validated_stopped_consumer_checkpoint':raise ObservationUnavailable('checkpoint_validation_unconfirmed')
            return m,result['accounting']
        raw=self._run(['exec','--user','1000:1000',self.policy['consumer']['container_id'],
          '/bin/sh','/data/tools/mqtt-source-observation/consumer-command.sh','snapshot'])
        result=decode(raw)
        if result.get('state')!='snapshot'or not result.get('accounting'):raise ObservationUnavailable('consumer_snapshot_unavailable')
        c=result['accounting'];counts(c['acked_counts']);need(c['canvas_checkpoint']['schema_version']==2)
        return m,c
    def _same_context(self,op,m):
        b=facts(op,'begin');r=m['reader'];s=r.get('source_facts')
        if(s is None or r['reader_instance_sha256']!=b['reader_instance_sha256']
          or s['epoch']!=b['source_epoch']or s['instance_sha256']!=b['source_instance_sha256']):
            raise ObservationUnavailable('source_context_unconfirmed')
        return s
    def _check_rebind_context(self,op,m,c):
        dispatch_invariants(op,'start_source');s=self._same_context(op,m);ready=facts(op,'consumer_ready')
        if(m['reader']['clock_domain_sha256']!=op['records'][0]['body']['clock_domain_sha256']
          or uint(m['reader']['reader_observed_boottime_ns'],64)<uint(op['records'][-1]['body']['at_ns'],64)):
            raise ObservationUnavailable('rebind_reader_progress_unconfirmed')
        if(self.inspect('source')['state']['Running']or c is None or not self.inspect('consumer')['state']['Running']
          or not s['closed']or s['identity_state']!='verified_exited'or m['pending_packet']or m['active_counts_nonempty']
          or m['accepted_frames']!=m['acknowledged_frames']or digest(c['acked_counts'])!=ready['protocol_counts_sha256']
          or c['acked_counts']!=m['acknowledged_counts']
          or c['canvas_checkpoint']['reader_observation']['consumer_instance_sha256']!=ready['consumer_instance_sha256']):
            raise ObservationUnavailable('rebind_context_unconfirmed')
    def rebind(self,tx,op):
        from maintenance_rebind import Transaction
        self.authorize(op,mutation=False)
        return Transaction(tx,self,op).run()
    def prepare_replacement(self,tx,op):
        from maintenance_policy import Issuer
        result=Issuer(tx,self,op).run()
        if result['state']=='replacement_policy_ready':
            fresh=Backend(self.paths,run=self.run,audit_paths=self.audit_paths);fresh.authorize(op,mutation=False)
            self.policy,self.policy_sha=fresh.policy,fresh.policy_sha
        return result
    def audit_replacement(self,tx,op):
        from source_image_audit import Producer
        return Producer(tx,self,op,**({'paths':self.audit_paths}if self.audit_paths is not None else{})).run()
    def preflight(self,command,op):
        need(command in COMMANDS,'maintenance_command_invalid')
        dispatch_invariants(op,command);m,c=self.snapshot();s=self._same_context(op,m)
        if(m['reader']['source_authorized']is not True or m['reader']['authorization_state']!='active'
          or uint(m['reader']['reader_observed_boottime_ns'],64)<uint(op['records'][-1]['body']['at_ns'],64)):
            raise ObservationUnavailable('post_stage_reader_progress_unconfirmed')
        if m['source_policy_sha256']!=digest(self.policy['source_definition']):
            raise ObservationUnavailable('loaded_source_binding_unconfirmed')
        source=self.inspect('source');consumer=self.inspect('consumer')
        if command=='stop_source'and(s['closed']or s['identity_state']!='verified_live'):
            raise ObservationUnavailable('live_source_context_unconfirmed')
        if command!='stop_source':
            if(source['state']['Running']or not s['closed']or s['identity_state']!='verified_exited'
              or m['pending_packet']or m['active_counts_nonempty']or m['accepted_frames']!=m['acknowledged_frames']):
                raise ObservationUnavailable('source_quiescence_unconfirmed')
        if command=='start_source':
            ready=facts(op,'consumer_ready')
            if(c is None or c['canvas_checkpoint']['reader_observation']['consumer_instance_sha256']!=ready['consumer_instance_sha256']
               or digest(c['acked_counts'])!=ready['protocol_counts_sha256']):raise ObservationUnavailable('consumer_readiness_changed')
        if command in('stop_consumer','start_consumer'):
            drained=facts(op,'source_drained')
            if digest(m['acknowledged_counts'])!=drained['protocol_counts_sha256']:
                raise ObservationUnavailable('quiescent_protocol_changed')
        role='source'if command in('stop_source','start_source')else'consumer'
        value=source if role=='source'else consumer
        expected=command.startswith('stop_')
        if value['state']['Running']is not expected:raise ObservationUnavailable('fixed_target_state_changed')
        return {'binding_sha256':value['binding_sha256'],'expected_state_sha256':value['state_sha256']}
    def execute(self,command,intent):
        need(command in COMMANDS,'maintenance_command_invalid')
        b=intent['body'];need(intent['sha256']==digest(b)and b['phase']==COMMANDS[command][1]
          and b['approval_sha256']==self.policy['approval_sha256']
          and b['clock_domain_sha256']==local_clock_domain(),'maintenance_intent_invalid')
        role='source'if command in('stop_source','start_source')else'consumer'
        try:self.authorize(None,mutation=True);current=self.inspect(role)
        except(MaintenanceUnavailable,OSError,ObservationUnavailable):raise BoundaryRejected('fixed_boundary_unavailable')from None
        f=intent['body']['facts']
        if current['binding_sha256']!=f['binding_sha256']or current['state_sha256']!=f['expected_state_sha256']:
            raise BoundaryRejected('fixed_boundary_changed')
        # Inspection can block outside this process. Recheck authority and
        # installed code after it, at the final command boundary.
        try:self.authorize(None,mutation=True)
        except(MaintenanceUnavailable,OSError,ObservationUnavailable):raise BoundaryRejected('fixed_boundary_unavailable')from None
        target=self.policy[role]['container_id']
        if command.startswith('stop_'):self._run(['stop','--time','30',target],timeout=40,limit=1024)
        else:self._run(['start',target],timeout=12,limit=1024)
    def facts(self,phase,op,*,purpose=None):
        m,c=self.snapshot();r=m['reader'];s=r.get('source_facts')
        if s is None:raise ObservationUnavailable('source_facts_unavailable')
        checkpoint=None if c is None else c['canvas_checkpoint'];ro=None if checkpoint is None else checkpoint.get('reader_observation')
        sha=None if checkpoint is None else digest(checkpoint)
        if phase=='begin':
            if checkpoint is None or ro is None:raise ObservationUnavailable('consumer_checkpoint_unavailable')
            if(m['source_policy_sha256']!=digest(self.policy['source_definition'])or s['closed']
              or s['identity_state']!='verified_live'or not self.inspect('source')['state']['Running']
              or ro['reader_instance_sha256']!=r['reader_instance_sha256']
              or ro['source_epoch']!=s['epoch']or ro['source_instance_sha256']!=s['instance_sha256']):
                raise ObservationUnavailable('initial_source_context_unconfirmed')
            return {'purpose':purpose,'window_id_sha256':checkpoint['window']['id_sha256'],
              'code_manifest_sha256':self.policy['code_manifest_sha256'],'reader_instance_sha256':r['reader_instance_sha256'],
              'source_epoch':s['epoch'],'source_instance_sha256':s['instance_sha256'],
              'source_binding_sha256':self.inspect('source')['binding_sha256'],'consumer_instance_sha256':ro['consumer_instance_sha256'],
              'consumer_binding_sha256':self.inspect('consumer')['binding_sha256'],'consumer_checkpoint_sequence':checkpoint['sequence'],
              'accepted_frames':m['accepted_frames'],'unknown_epoch_tails':m['unknown_epoch_tails']}
        if phase=='armed':
            if checkpoint is None:raise ObservationUnavailable('consumer_checkpoint_unavailable')
            b=facts(op,'begin')
            if(checkpoint['window']['id_sha256']!=b['window_id_sha256']or
              uint(checkpoint['sequence'],64)<=uint(b['consumer_checkpoint_sequence'],64)):
                raise ObservationUnavailable('new_arm_checkpoint_unavailable')
            return {'window_id_sha256':checkpoint['window']['id_sha256'],'consumer_checkpoint_sha256':sha,'consumer_checkpoint_sequence':checkpoint['sequence']}
        if phase in('source_stopped','consumer_stopped'):
            role='source'if phase=='source_stopped'else'consumer';v=self.inspect(role)
            if v['state']['Running']or v['state']['ExitCode']!=0:raise ObservationUnavailable('target_stop_unconfirmed')
            if role=='source':
                self._same_context(op,m)
                if s['identity_state']!='verified_exited':raise ObservationUnavailable('source_exit_unconfirmed')
                return {'binding_sha256':v['binding_sha256'],'source_epoch':s['epoch'],'source_instance_sha256':s['instance_sha256'],
                  'container_state':'exited','exit_code':0,'sender_pidfd_exited':True}
            if checkpoint is None:raise ObservationUnavailable('stopped_consumer_checkpoint_unconfirmed')
            return {'binding_sha256':v['binding_sha256'],'container_state':'exited','exit_code':0,
              'consumer_checkpoint_sequence':checkpoint['sequence']}
        if phase=='source_drained':
            self._same_context(op,m)
            if checkpoint is None or c['acked_counts']!=m['acknowledged_counts']:raise ObservationUnavailable('ACK_cut_unconfirmed')
            if(s['closed']is not True or s['identity_state']!='verified_exited'or self.inspect('source')['state']['Running']
              or m['pending_packet']or m['active_counts_nonempty']or m['accepted_frames']!=m['acknowledged_frames']):
                raise ObservationUnavailable('closed_source_cut_unconfirmed')
            return {'source_epoch':s['epoch'],'source_instance_sha256':s['instance_sha256'],'source_closed':s['closed'],
              'accepted_frames':m['accepted_frames'],'acknowledged_frames':m['acknowledged_frames'],'pending_packet':m['pending_packet'],
              'active_counts_nonempty':m['active_counts_nonempty'],'unknown_epoch_tails':m['unknown_epoch_tails'],
              'consumer_checkpoint_sha256':sha,'consumer_checkpoint_sequence':checkpoint['sequence'],
              'protocol_counts_sha256':digest(c['acked_counts']),'reader_instance_sha256':r['reader_instance_sha256']}
        if phase in('consumer_started','source_started'):
            role='consumer'if phase=='consumer_started'else'source';v=self.inspect(role)
            if not v['state']['Running']:raise ObservationUnavailable('target_start_unconfirmed')
            intent='consumer_start_intent'if role=='consumer'else'source_start_intent'
            return {'binding_sha256':v['binding_sha256'],'start_boundary_ns':records(op)[intent]['body']['at_ns']}
        if phase=='consumer_ready':
            self._same_context(op,m)
            if ro is None or c['acked_counts']!=m['acknowledged_counts']:raise ObservationUnavailable('consumer_readiness_unconfirmed')
            b=facts(op,'begin');boundary=records(op)['consumer_start_intent']['body']['at_ns']
            if(ro['consumer_instance_sha256']==b['consumer_instance_sha256']or
              ro['reader_instance_sha256']!=b['reader_instance_sha256']or not ro['source_closed']
              or ro['source_identity_state']!='verified_exited'or self.inspect('source')['state']['Running']
              or uint(ro['observed_boottime_ns'],64)<uint(boundary,64)):
                raise ObservationUnavailable('fresh_consumer_readiness_unconfirmed')
            return {'binding_sha256':self.inspect('consumer')['binding_sha256'],'consumer_instance_sha256':ro['consumer_instance_sha256'],
              'consumer_checkpoint_sha256':sha,'consumer_checkpoint_sequence':checkpoint['sequence'],'reader_instance_sha256':ro['reader_instance_sha256'],
              'reader_observed_ns':ro['observed_boottime_ns'],'old_source_epoch':s['epoch'],'old_source_instance_sha256':s['instance_sha256'],
              'source_closed':ro['source_closed'],'source_identity':ro['source_identity_state'],'protocol_counts_sha256':digest(c['acked_counts'])}
        if phase=='new_source_verified':
            if not self.inspect('source')['state']['Running']:raise ObservationUnavailable('new_source_not_running')
            b=facts(op,'begin');boundary=records(op)['source_start_intent']['body']['at_ns']
            if(uint(s['epoch'],128)!=uint(b['source_epoch'],128)+1 or s['instance_sha256']==b['source_instance_sha256']
              or s['closed']or s['identity_state']!='verified_live'or s['started_boottime_ns']is None
              or s['covered_before_ns']is None or uint(s['started_boottime_ns'],64)<uint(boundary,64)
              or r['reader_instance_sha256']!=b['reader_instance_sha256']):
                raise ObservationUnavailable('new_source_frame_unconfirmed')
            return {'source_epoch':s['epoch'],'source_instance_sha256':s['instance_sha256'],'binding_sha256':self.inspect('source')['binding_sha256'],
              'started_ns':s['started_boottime_ns'],'covered_before_ns':s['covered_before_ns'],'accepted_frames':m['accepted_frames'],
              'reader_instance_sha256':r['reader_instance_sha256']}
        if phase=='complete':
            if checkpoint is None:raise ObservationUnavailable('final_ACK_cut_unconfirmed')
            cut=confirmed_cut(m,c)
            new=facts(op,'new_source_verified');ready=facts(op,'consumer_ready')
            if(s['epoch']!=new['source_epoch']or s['instance_sha256']!=new['source_instance_sha256']
              or s['closed']or s['identity_state']!='verified_live'or not self.inspect('source')['state']['Running']
              or uint(cut['frames'],128)<uint(new['accepted_frames'],128)
              or uint(checkpoint['sequence'],64)<=uint(ready['consumer_checkpoint_sequence'],64)):
                raise ObservationUnavailable('new_source_ACK_unconfirmed')
            return {'source_epoch':s['epoch'],'source_instance_sha256':s['instance_sha256'],'binding_sha256':self.inspect('source')['binding_sha256'],
              'acknowledged_frames':cut['frames'],'consumer_checkpoint_sha256':sha,'consumer_checkpoint_sequence':checkpoint['sequence'],
              'protocol_counts_sha256':digest(cut)}
        raise MaintenanceUnavailable('maintenance_fact_phase_invalid')
