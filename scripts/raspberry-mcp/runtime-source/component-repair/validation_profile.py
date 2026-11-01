"""Fixed isolated validation invocation and immutable harness receipt checks."""
import base64,hashlib,json,os,re,shutil,stat,subprocess,time,selectors,fcntl,contextlib
from pathlib import Path
from source_writer import need,read,raw,sha,write_new,protected_dir,SourceWriter,source_set
LIB=Path('/usr/local/lib/raspberry-component-repair');STATE=Path('/var/lib/raspberry-component-repair')
def bounded(command,stdout_limit,stderr_limit,seconds,env,unit=None):
 process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
 selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ,'stdout');selector.register(process.stderr,selectors.EVENT_READ,'stderr')
 buffers={'stdout':bytearray(),'stderr':bytearray()};limits={'stdout':stdout_limit,'stderr':stderr_limit};over=False;deadline=time.monotonic()+seconds;live=None;live_at=None;next_observation=0
 try:
  while selector.get_map():
   if unit is not None and live is None and time.monotonic()>=next_observation:
    next_observation=time.monotonic()+.2
    query=subprocess.run(['/usr/bin/systemctl','show',unit,'--property=LoadState,InvocationID,MainPID,ExecStart,CPUQuotaPerSecUSec,RuntimeMaxUSec,MemorySwapMax,BindPaths,BindReadOnlyPaths,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NoNewPrivileges,PrivateNetwork,PrivateDevices,ProtectSystem,User,Group,MemoryMax,TasksMax,CapabilityBoundingSet,RestrictAddressFamilies,InaccessiblePaths,TemporaryFileSystem,LimitFSIZE,RootDirectory'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=2,env=env)
    if query.returncode==0 and len(query.stdout)<=32768 and len(query.stderr)<=4096:
     values=dict(line.split('=',1)for line in query.stdout.decode().splitlines()if'='in line)
     if values.get('LoadState')=='loaded'and values.get('MainPID','0').isdigit()and int(values['MainPID'])>0 and values.get('ActiveState')in('active','activating')and re.fullmatch('[a-f0-9]{32}',values.get('InvocationID','')):
      live=query.stdout;live_at=time.time()
   if time.monotonic()>deadline:return {'returncode':None,'stdout':bytes(buffers['stdout']),'stderr':bytes(buffers['stderr']),'output_limit':over,'deadline_exceeded':True,'launcher_pid':process.pid,'live_properties':live,'live_observed_at':live_at}
   for key,_ in selector.select(.2):
    chunk=os.read(key.fd,16384)
    if not chunk:selector.unregister(key.fileobj);continue
    name=key.data;room=max(0,limits[name]-len(buffers[name]));buffers[name].extend(chunk[:room]);over=over or len(chunk)>room
  return {'returncode':process.wait(timeout=2),'stdout':bytes(buffers['stdout']),'stderr':bytes(buffers['stderr']),'output_limit':over,'deadline_exceeded':False,'launcher_pid':process.pid,'live_properties':live,'live_observed_at':live_at}
 finally:
  selector.close();process.stdout.close();process.stderr.close()
@contextlib.contextmanager
def validation_mutex(expected):
 p=Path('/tmp/my-smart-home-public-validation.lock');need(not p.is_symlink(),'validation_mutex_symlink')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);actual={'device':before.st_dev,'inode':before.st_ino,'uid':before.st_uid,'gid':before.st_gid,'mode':stat.S_IMODE(before.st_mode)}
  need(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_size==0 and actual==expected,'canonical_validation_mutex_identity')
  try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise ValueError('another_canonical_validation_active')
  need((p.lstat().st_dev,p.lstat().st_ino)==(before.st_dev,before.st_ino),'validation_mutex_replaced');yield
  need((p.lstat().st_dev,p.lstat().st_ino)==(before.st_dev,before.st_ino),'validation_mutex_replaced')
 finally:os.close(fd)
class Validator:
 def __init__(self,profile,repository=Path('/mnt/data/docker'),state_root=STATE,clock=time.time):self.profile=profile;self.repo=Path(repository);self.state=Path(state_root);self.clock=clock
 def trusted(self):
  parent=LIB/'profiles/observacao_host';protected_dir(parent);folder=parent/'runtime'
  need(folder.is_dir()and not folder.is_symlink()and folder.stat().st_uid==0 and stat.S_IMODE(folder.stat().st_mode)==0o555,'unsafe_harness_runtime_directory')
  for p,h in self.profile['harness_hashes'].items():need(sha(read(folder/p,0,0o444,limit=8*1024*1024))==h,'immutable_validation_harness_changed')
  return folder
 def run(self,op,folder,attempt_id=None):
  need(attempt_id is None or re.fullmatch('[a-f0-9]{32}',attempt_id),'validation_attempt_id_refused')
  with validation_mutex(self.profile['validation_lock']):return self._run(op,folder,attempt_id)
 def _run(self,op,folder,attempt_id=None):
  need(os.geteuid()==0 and re.fullmatch('[a-f0-9]{32}',op),'root_validator_operation_required');trusted=self.trusted();profile_sha=sha(raw(self.profile))
  memory=dict(line.split(':',1)for line in Path('/proc/meminfo').read_text().splitlines());need(int(memory['MemAvailable'].split()[0])>=2097152,'less_than_two_GiB_available')
  disk=shutil.disk_usage(self.repo);need(disk.used/disk.total<.85,'repository_filesystem_above_limit');need(os.getloadavg()[0]<=(os.cpu_count()or 1),'host_CPU_pressure')
  sandbox=folder/'sandbox';need(not sandbox.exists(),'existing_validation_requires_inspection');sandbox.mkdir(mode=0o700)
  root=sandbox/'root';root.mkdir(mode=0o755);root.chmod(0o755)
  for p in ['usr','workspace','baseline','trusted','out','tmp','dev','proc']:
   (root/p).mkdir(mode=0o755);(root/p).chmod(0o755)
  # Resolve the existing public awk alternatives link inside the isolated root.
  # No host /etc mount or configuration is admitted.
  (root/'etc').mkdir(mode=0o755);(root/'etc').chmod(0o755);(root/'etc/alternatives').mkdir(mode=0o755);(root/'etc/alternatives').chmod(0o755)
  awk=read('/usr/bin/mawk',0,0o755,limit=1048576);need(awk[:4]==b'\x7fELF','public_awk_binary_unconfirmed');write_new(root/'etc/alternatives/awk',awk);(root/'etc/alternatives/awk').chmod(0o755)
  for link,target in [('bin','usr/bin'),('sbin','usr/sbin'),('lib','usr/lib')]:os.symlink(target,root/link)
  if Path('/lib64').exists():os.symlink('usr/lib64',root/'lib64')
  out=sandbox/'out';out.mkdir(mode=0o700);os.chown(out,65534,65534)
  base=folder/'public-snapshot';overlay=folder/'candidate-sources';before=folder/'validation-before-flow.json'
  _,bundle,_,expected_sources=SourceWriter(self.profile,self.state,self.repo,self.clock).bundle(op)
  need(all(sha(read(overlay/p,0,0o444))==sha(data)for p,data in expected_sources.items()),'candidate_sources_before_changed')
  bindings=['/usr:/usr',str(base)+':/workspace',str(base)+':/baseline',str(trusted)+':/trusted']
  rw=[str(overlay/'nodered/flows.json')+':/workspace/nodered/flows.json']
  for name in self.profile['editable_sources']:bindings.append(str(overlay/name)+':/workspace/'+name)
  unit='raspberry-component-validate-'+op+('-'+attempt_id if attempt_id is not None else'')
  properties={'RootDirectory':str(root),'User':'65534','Group':'65534','SupplementaryGroups':'','NoNewPrivileges':'yes','PrivateNetwork':'yes','PrivateDevices':'yes','PrivateTmp':'yes','ProtectSystem':'strict','ProtectHome':'yes','ProtectKernelTunables':'yes','ProtectKernelModules':'yes','ProtectControlGroups':'yes','RestrictSUIDSGID':'yes','RestrictRealtime':'yes','RestrictNamespaces':'yes','LockPersonality':'yes','CapabilityBoundingSet':'','AmbientCapabilities':'','RestrictAddressFamilies':'AF_UNIX','InaccessiblePaths':'+/proc','Nice':'15','IOSchedulingClass':'idle','CPUQuota':'50%','MemoryMax':'536870912','MemorySwapMax':'0','TasksMax':'64','RuntimeMaxSec':'180','TimeoutStopSec':'5','KillMode':'control-group','UMask':'0077','WorkingDirectory':'/workspace','BindReadOnlyPaths':' '.join(bindings),'BindPaths':' '.join(rw),'ReadWritePaths':'/out /tmp /workspace/nodered/flows.json','TemporaryFileSystem':'/tmp:rw,nodev,nosuid,size=16M,mode=1777 /out:rw,nodev,nosuid,size=16M,mode=0700,uid=65534,gid=65534','LimitFSIZE':'8388608','SystemCallFilter':'~@debug @mount @reboot @raw-io @privileged kill tkill tgkill pidfd_send_signal'}
  command=['/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit='+unit]
  for k,v in properties.items():command+=['--property='+k+'='+v]
  command+=['/usr/bin/python3','-I','-S','-B','/trusted/sandbox_probe.py']
  write_new(folder/'validator-intent.json',raw({'unit':unit,'profile_sha256':profile_sha,'properties':properties,'command':command,'attempt_id':attempt_id,'observed_at':self.clock(),'automatic_retry':False}))
  # systemd enforces the process-group deadline; do not kill/retry an uncertain invocation.
  result=bounded(command,4*1024*1024,65536,200,{'PATH':'/usr/bin:/bin','LC_ALL':'C'},unit=unit)
  native=bounded(['/usr/bin/systemctl','show',unit,'--property=LoadState,InvocationID,ActiveState,Result,ExecMainCode,ExecMainStatus,NoNewPrivileges,PrivateNetwork,PrivateDevices,ProtectSystem,User,Group,MemoryMax,TasksMax,CapabilityBoundingSet,RestrictAddressFamilies,InaccessiblePaths,TemporaryFileSystem,LimitFSIZE,RootDirectory'],32768,4096,10,{'PATH':'/usr/bin:/bin','LC_ALL':'C'})
  post=dict(line.split('=',1)for line in native['stdout'].decode().splitlines()if'='in line)
  live=result.get('live_properties');need(type(live)is bytes and len(live)<=32768,'validator_live_properties_not_observed');observed=dict(line.split('=',1)for line in live.decode().splitlines()if'='in line)
  write_new(folder/'validator-native-receipt.json',raw({'unit':unit,'returncode':result['returncode'],'stdout_sha256':sha(result['stdout']),'stderr_sha256':sha(result['stderr']),'output_limit':result['output_limit'],'deadline_exceeded':result['deadline_exceeded'],'launcher_pid':result['launcher_pid'],'unit_terminal':result['returncode']is not None and post.get('ActiveState')in('inactive','failed'),'systemd_returncode':native['returncode'],'systemd_properties':live.decode(),'post_exit_systemd_properties':native['stdout'].decode(),'live_observed_at':result['live_observed_at'],'exit_source':'same_unique_unit_systemd_run_wait','observed_at':self.clock(),'automatic_retry':False}))
  need(result['returncode']==0 and native['returncode']==0 and not result['output_limit']and not result['deadline_exceeded']and not native['output_limit']and not native['deadline_exceeded'],'validator_native_run_failed')
  need(post.get('ActiveState')in('inactive','failed')and result['returncode']==0 and(post.get('LoadState')=='not-found'or post.get('InvocationID')==observed.get('InvocationID')),'validator_process_exit_not_proved')
  need('path=/usr/bin/python3'in observed.get('ExecStart','')and 'argv[]=/usr/bin/python3 -I -S -B /trusted/sandbox_probe.py'in observed['ExecStart'],'validator_native_command_not_proved')
  need(all(observed.get(k)==v for k,v in {'NoNewPrivileges':'yes','PrivateNetwork':'yes','PrivateDevices':'yes','ProtectSystem':'strict','User':'65534','Group':'65534','MemoryMax':'536870912','MemorySwapMax':'0','CPUQuotaPerSecUSec':'500ms','RuntimeMaxUSec':'3min','TasksMax':'64','CapabilityBoundingSet':'','RootDirectory':str(root)}.items()),'validator_native_properties_not_proved')
  lines=result['stdout'].splitlines();need(len(lines)==2,'validator_trusted_output_shape');probe=json.loads(lines[0]);proof=json.loads(lines[1]);need(probe.get('sandbox_probe')=='passed'and all(probe.get(k)is True for k in ['no_new_privileges','inet_denied','proc_hidden','trusted_readonly']),'validator_negative_probes_not_proved')
  self.trusted();need(all(sha(read(overlay/p,0,0o444))==sha(data)for p,data in expected_sources.items()),'candidate_sources_after_changed')
  need(sha(read(overlay/'nodered/flows.json',limit=8*1024*1024))==proof.get('generated_flow_sha256'),'actual_generated_flow_changed')
  need(proof.get('schema_version')==1 and proof.get('native_effects')==0 and proof.get('network_allowed')is False,'validator_result_shape')
  need(observed.get('LimitFSIZE')=='8388608'and '/out'in observed.get('TemporaryFileSystem','')and '/tmp'in observed.get('TemporaryFileSystem','')and any(x in observed['TemporaryFileSystem']for x in ['size=16M','size=16777216']),'sandbox_storage_limits_not_proved')
  svg=base64.b64decode(proof.pop('render_svg_base64'),validate=True);png=base64.b64decode(proof.pop('render_png_base64'),validate=True)
  need(0<len(svg)<=1048576 and 0<len(png)<=1048576 and sha(svg)==proof['render_sha256']and sha(png)==proof['render_png_sha256'],'render_payload_not_bound')
  write_new(folder/'validator-result.json',raw(proof));write_new(folder/'render.svg',svg);write_new(folder/'render.png',png)
  need(sha(read(folder/'render.svg'))==proof['render_sha256'],'render_result_hash_changed');return proof
