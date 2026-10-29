"""Fixed Node child and private admission channel; no CLI or service control.

Only the launcher's own child can request the one remote intent. A lost result
never starts another child. Timeout closes the channel without killing a worker
that may be finishing an already-authorized request. Reports remain unverified.
"""
from contextlib import contextmanager
from pathlib import Path
import array,os,resource,select,socket,stat,struct,subprocess,time,sys
if __name__=='__main__':
    # Isolated Python excludes the script directory; accept only the sealed install.
    entry=Path(__file__)
    if os.geteuid()!=0 or os.getegid()!=0 or len(sys.argv)!=1 or entry.resolve()!=Path('/opt/raspberry-mqtt-observation/bootstrap_launcher.py'):
        print('{"state":"bootstrap_launcher_closed","automatic_retry":false}');raise SystemExit(1)
    info=entry.lstat()
    if not stat.S_ISREG(info.st_mode)or(info.st_uid,info.st_gid)!=(0,0)or stat.S_IMODE(info.st_mode)!=0o644 or info.st_nlink!=1:
        print('{"state":"bootstrap_launcher_closed","automatic_retry":false}');raise SystemExit(1)
    sys.path.insert(0,str(entry.parent))
from bootstrap_dispatch import BootstrapDispatch,Paths as WorkerPaths,need
from maintenance_backend import Backend,start_ticks,decode
from maintenance_journal import Journal,canonical,closed,digest

STATE=Path('/var/lib/raspberry-mqtt-maintenance')
LIMIT=4096
# HTTP can initialize Wasm before the first request. Inline bounds checks avoid
# its large virtual-memory cage while retaining the fixed RLIMIT_AS below.
FLAGS=('--no-addons','--no-global-search-paths','--max-old-space-size=64','--disable-wasm-trap-handler')

def proc_read(pid,name,limit):
    fd=os.open(f'/proc/{pid}/{name}',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        raw=os.read(fd,limit+1);need(len(raw)<=limit,'bootstrap_process_unconfirmed');return raw
    finally:os.close(fd)

class Child:
    """Native birth/exec witness for exactly one Popen created here."""
    def __init__(self,paths,profile):
        self.paths=paths;self.profile=profile;self.process=None;self.pidfd=None;self.channel=None
        self.argv=[str(paths.interpreter),*FLAGS,str(paths.worker/'worker.mjs')]
        self.executable=paths.interpreter.stat();self.birth=None;self.eof=False
        paths_to_seal={paths.worker,paths.interpreter}
        for name in profile['worker_files']:
            path=paths.worker/name;paths_to_seal.add(path)
            while path.parent!=paths.worker:path=path.parent;paths_to_seal.add(path)
        self.seals={p:self.signature(p)for p in paths_to_seal}
    @staticmethod
    def signature(path):
        s=path.lstat();need(not stat.S_ISLNK(s.st_mode),'bootstrap_worker_files_changed')
        return(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    def start(self):
        parent,child=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
        parent.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1);self.channel=parent
        def limits():
            os.umask(0o077);os.nice(10)
            for key,maximum in [(resource.RLIMIT_AS,2*1024**3),(resource.RLIMIT_CPU,20),(resource.RLIMIT_CORE,0)]:
                _,hard=resource.getrlimit(key);value=maximum if hard==resource.RLIM_INFINITY else min(maximum,hard)
                resource.setrlimit(key,(value,value))
        try:
            self.process=subprocess.Popen(self.argv,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL,cwd=self.paths.worker,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','TZ':'UTC',
              'WS_NO_BUFFER_UTIL':'1','WS_NO_UTF_8_VALIDATE':'1',
              'EVA_BOOTSTRAP_FD':str(child.fileno()),'EVA_BOOTSTRAP_OPERATION_ID':self.profile['operation_id']},
              user=self.paths.worker_uid,group=self.paths.worker_gid,
              extra_groups=[],pass_fds=(child.fileno(),),close_fds=True,preexec_fn=limits)
            self.pidfd=os.pidfd_open(self.process.pid,0)
            self.birth=start_ticks(proc_read(self.process.pid,'stat',8192).decode(),self.process.pid)
            return self.witness()
        finally:child.close()

    def witness(self):
        need(all(self.signature(p)==value for p,value in self.seals.items()),'bootstrap_worker_files_changed')
        need(self.process is not None and self.pidfd is not None
          and not select.select([self.pidfd],[],[],0)[0],'bootstrap_worker_exited')
        pid=self.process.pid;before=start_ticks(proc_read(pid,'stat',8192).decode(),pid)
        status=proc_read(pid,'status',16384).decode()
        fields=dict(line.split(':',1)for line in status.splitlines()if':'in line)
        need(fields['Uid'].split()==[str(self.paths.worker_uid)]*4
          and fields['Gid'].split()==[str(self.paths.worker_gid)]*4,'bootstrap_worker_role_changed')
        expected=b'\0'.join(s.encode()for s in self.argv)+b'\0'
        need(proc_read(pid,'cmdline',16384)==expected,'bootstrap_worker_command_changed')
        mapped=Path(f'/proc/{pid}/exe').stat();after=start_ticks(proc_read(pid,'stat',8192).decode(),pid)
        need(before==after==self.birth and(mapped.st_dev,mapped.st_ino)==(self.executable.st_dev,self.executable.st_ino)
          and stat.S_ISREG(mapped.st_mode),'bootstrap_worker_exec_changed')
        return {'pid':str(pid),'start_ticks':str(self.birth),'interpreter_dev':str(mapped.st_dev),
          'interpreter_ino':str(mapped.st_ino),'interpreter_sha256':self.profile['interpreter_sha256'],
          'command_sha256':digest(self.argv),'worker_manifest_sha256':digest(self.profile['worker_files'])}
    def receive(self,timeout):
        ready=select.select(([self.channel]if not self.eof else[])+[self.pidfd],[],[],timeout)[0]
        if self.channel not in ready:return None
        try:raw,ancillary,flags,_=self.channel.recvmsg(LIMIT+1,socket.CMSG_SPACE(struct.calcsize('3i')))
        except ConnectionResetError:
            # A worker may exit with our reply still unread. Reset supplies no
            # frame or permission; retain only already journaled report data.
            self.eof=True;return b''
        if not raw:self.eof=True;return b''
        for level,kind,data in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                received=array.array('i');received.frombytes(data[:len(data)//received.itemsize*received.itemsize])
                for fd in received:os.close(fd)
        need(len(raw)<=LIMIT and not flags,'bootstrap_channel_invalid')
        credentials=[struct.unpack('3i',data)for level,kind,data in ancillary
          if level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS and len(data)==struct.calcsize('3i')]
        need(len(ancillary)==1 and credentials==[(self.process.pid,self.paths.worker_uid,self.paths.worker_gid)],'bootstrap_channel_sender_unconfirmed')
        return raw
    def close(self):
        if self.channel is not None:self.channel.close();self.channel=None
        if self.pidfd is not None:os.close(self.pidfd);self.pidfd=None
        # Closing a pidfd never signals or terminates the child.

class Launcher:
    def __init__(self,state=STATE,backend=None,paths=WorkerPaths(),*,wall=time.time):
        need(os.geteuid()==0 and os.getegid()==0,'bootstrap_dispatch_role_invalid')
        self.state=state;self.backend=backend or Backend();self.paths=paths;self.wall=wall;self.child=None
        self.boottime_ns=lambda:time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    @contextmanager
    def guard(self):
        j=Journal(self.state,self.backend.policy['approval_sha256'])
        try:yield BootstrapDispatch(j,self.backend,self.paths,wall=self.wall)
        finally:j.close()
    def run(self):
        with self.guard()as guard:
            admitted=guard.begin();identity=admitted['operation_id']
            need(admitted['newly_recorded'],'bootstrap_launch_consumed')
            profile=guard.profile();op=guard._live(identity)
            deadline=int(op['records'][0]['body']['facts']['deadline_ns'])
        child=Child(self.paths,profile);self.child=child;buffer=b'';requests=0;report=False
        try:
            witness=child.start()
            with self.guard()as guard:guard.bind_worker(identity,witness)
            while self.boottime_ns()<deadline:
                raw=child.receive(0.1)
                if raw:
                    buffer+=raw;need(len(buffer)<=LIMIT,'bootstrap_channel_invalid')
                    while b'\n'in buffer:
                        line,buffer=buffer.split(b'\n',1);requests+=1
                        need(requests<=2 and not report,'bootstrap_channel_consumed')
                        value=decode(line);need(type(value)is dict,'bootstrap_channel_invalid')
                        with self.guard()as guard:
                            if value.get('action')=='admit_remote':
                                child.witness()
                                closed(value,['action','bundle_sha256','request_sha256'])
                                result=guard.admit_remote(identity,bundle_sha256=value['bundle_sha256'],request_sha256=value['request_sha256'])
                                result.update(action='admit_remote',expires_at=profile['expires_at'],deadline_ns=str(deadline))
                            elif value.get('action')=='record_report':
                                closed(value,['action','report_sha256'])
                                result=guard.record_report(identity,value['report_sha256']);result['action']='record_report';report=True
                            else:need(False,'bootstrap_channel_action_invalid')
                        if not report:child.witness()
                        try:child.channel.sendall(canonical(result)+b'\n')
                        except (BrokenPipeError,ConnectionResetError):
                            if not report:raise
                if child.process.poll()is not None:
                    need(not buffer,'bootstrap_channel_partial')
                    return {'operation_id':identity,'state':'worker_exited_report_unverified'if report else'worker_exited_without_report',
                      'exit_code':child.process.returncode,'automatic_retry':False,'independent_acceptance':False,
                      'remote_effect_proven':False,'policy_promoted':False}
                if raw==b'':
                    # EOF is not proof of process completion; keep the native handle.
                    time.sleep(0.01)
            return {'operation_id':identity,'state':'worker_deadline_result_unknown','worker_still_running':child.process.poll()is None,
              'automatic_retry':False,'independent_acceptance':False,'remote_effect_proven':False,'policy_promoted':False}
        finally:child.close()

if __name__=='__main__':
    try:
        _,hard=resource.getrlimit(resource.RLIMIT_AS)
        bound=2*1024**3 if hard==resource.RLIM_INFINITY else min(hard,2*1024**3)
        resource.setrlimit(resource.RLIMIT_AS,(min(256*1024**2,bound),bound))
        _,hard=resource.getrlimit(resource.RLIMIT_CPU)
        cpu=80 if hard==resource.RLIM_INFINITY else min(hard,80)
        resource.setrlimit(resource.RLIMIT_CPU,(cpu,cpu));resource.setrlimit(resource.RLIMIT_CORE,(0,0))
        result=Launcher().run();print(canonical(result).decode('ascii'))
        raise SystemExit(0 if result.get('exit_code')==0 else 1)
    except Exception:
        print('{"state":"bootstrap_launcher_unconfirmed","automatic_retry":false,"details_withheld":true}');raise SystemExit(1)
