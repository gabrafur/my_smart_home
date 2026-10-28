"""Unarmed Linux peer/code/clock verifier for the fixed metadata source.

Reads bounded proc metadata and hashes executable files, never process memory,
environ, cmdline, configuration, topics or payloads. No Docker socket is used.
Kernel proc documentation: https://docs.kernel.org/filesystems/proc.html
"""
from dataclasses import dataclass
import hashlib,json,os,re,select,stat

class BindingUnavailable(RuntimeError):pass
def reject(reason):
    raise BindingUnavailable(reason)from None

@dataclass(frozen=True)
class Peer:
    pid:int
    uid:int
    gid:int

@dataclass(frozen=True)
class SourcePolicy:
    container_id:str
    peer_uid:int
    peer_gid:int
    binary_sha256:str
    plugin_sha256:str
    plugin_path:str
    plugin_owner_uid:int

    def __post_init__(self):
        for value in [self.container_id,self.binary_sha256,self.plugin_sha256]:
            if type(value)is not str or re.fullmatch('[a-f0-9]{64}',value)is None:reject('source_policy_invalid')
        for value in [self.peer_uid,self.peer_gid,self.plugin_owner_uid]:
            if type(value)is not int or not 0<=value<2**32:reject('source_policy_invalid')
        path=self.plugin_path
        if type(path)is not str or not re.fullmatch(r'/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.so',path)or any(x in ('.','..')for x in path.split('/')):reject('source_policy_invalid')

@dataclass(frozen=True)
class VerifiedBinding:
    process_epoch:str
    clock_domain_id:str
    kernel_peer_verified:bool=True
    mapped_file_identity_verified:bool=True
    same_clock_domain:bool=True

def start_ticks(raw,pid):
    prefix=str(pid)+' ('
    end=raw.rfind(')')
    if not raw.startswith(prefix)or end<len(prefix):reject('source_process_invalid')
    fields=raw[end+1:].split()
    if len(fields)<20 or fields[0]in ('Z','X','x')or re.fullmatch('[0-9]+',fields[19])is None:reject('source_process_invalid')
    return int(fields[19])

def credentials_from_status(raw,peer):
    rows={}
    for line in raw.splitlines():
        if line.startswith(('Uid:','Gid:')):
            key,values=line.split(':',1)
            if key in rows:reject('source_credentials_invalid')
            parts=values.split()
            if len(parts)!=4 or any(re.fullmatch('[0-9]+',x)is None for x in parts):reject('source_credentials_invalid')
            rows[key]=tuple(int(x)for x in parts)
    if rows!={'Uid':(peer.uid,)*4,'Gid':(peer.gid,)*4}:reject('source_credentials_invalid')

def cgroup_bound(raw,cid):
    lines=raw.splitlines()
    if len(lines)!=1 or not lines[0].startswith('0::/'):reject('source_cgroup_invalid')
    path=lines[0][3:]
    if path not in ('/system.slice/docker-'+cid+'.scope','/docker/'+cid):reject('source_cgroup_invalid')

def zero_offsets(raw):
    rows={}
    for line in raw.splitlines():
        parts=line.split()
        if len(parts)!=3 or parts[0]in rows:reject('source_clock_domain_invalid')
        try:rows[parts[0]]=(int(parts[1]),int(parts[2]))
        except ValueError:reject('source_clock_domain_invalid')
    if rows!={'monotonic':(0,0),'boottime':(0,0)}:reject('source_clock_domain_invalid')

def boot_domain(raw):
    if re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\n?',raw)is None:reject('source_clock_domain_invalid')
    return hashlib.sha256(raw.strip().encode('ascii')).hexdigest()

def file_key(info):
    return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,
            info.st_mode,info.st_uid,info.st_gid,info.st_nlink)

def mapped_executable(raw,info,path=None):
    found=False
    for line in raw.splitlines():
        parts=line.split(None,5)
        if len(parts)<5:reject('source_mapping_invalid')
        address,permissions,offset,device,inode=parts[:5]
        if not re.fullmatch('[a-f0-9]+-[a-f0-9]+',address)or not re.fullmatch('[r-][w-][x-][ps]',permissions):reject('source_mapping_invalid')
        if re.fullmatch('[a-f0-9]+:[a-f0-9]+',device)is None or re.fullmatch('[0-9]+',inode)is None:reject('source_mapping_invalid')
        major,minor=(int(x,16)for x in device.split(':'))
        name=parts[5]if len(parts)==6 else ''
        same=(major==os.major(info.st_dev)and minor==os.minor(info.st_dev)and int(inode)==info.st_ino)
        if same and 'x'in permissions and (path is None or name==path):found=True
        if path is not None and name==path and not same:reject('source_mapping_invalid')
    if not found:reject('source_mapping_invalid')

class ProcHandle:
    def __init__(self,pid):
        self.fd=None;self.pidfd=None
        try:
            self.pidfd=os.pidfd_open(pid,0)
            self.fd=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
            self.alive()
        except BaseException:
            self.close();raise
    def alive(self):
        poll=select.poll();poll.register(self.pidfd,select.POLLIN|select.POLLHUP|select.POLLERR)
        if poll.poll(0):reject('source_process_gone')
    def open(self,name):
        return os.open(name,os.O_RDONLY|os.O_CLOEXEC,dir_fd=self.fd)
    def text(self,name,limit):
        fd=self.open(name)
        try:
            chunks=[];size=0
            while True:
                chunk=os.read(fd,min(8192,limit+1-size))
                if not chunk:break
                size+=len(chunk)
                if size>limit:reject('source_metadata_limit')
                chunks.append(chunk)
            return b''.join(chunks).decode('ascii')
        finally:os.close(fd)
    def close(self):
        for key in ['fd','pidfd']:
            value=getattr(self,key,None)
            if value is not None:os.close(value);setattr(self,key,None)

def local_clock_domain():
    with open('/proc/self/timens_offsets',encoding='ascii')as f:zero_offsets(f.read(1024))
    with open('/proc/sys/kernel/random/boot_id',encoding='ascii')as f:return boot_domain(f.read(128))

class SourceVerifier:
    def __init__(self,policy):
        if type(policy)is not SourcePolicy:reject('source_policy_invalid')
        self.policy=policy;self.cache={}

    def _code(self,proc,name,expected_hash,owner,limit):
        fd=proc.open(name)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode)or before.st_nlink!=1 or before.st_uid!=owner or before.st_mode&0o022 or not 0<before.st_size<=limit:reject('source_code_unsafe')
            key=file_key(before)
            if self.cache.get(name)!=(key,expected_hash):
                h=hashlib.sha256();size=0
                while True:
                    chunk=os.read(fd,65536)
                    if not chunk:break
                    size+=len(chunk)
                    if size>limit:reject('source_code_limit')
                    h.update(chunk)
                if size!=before.st_size or h.hexdigest()!=expected_hash:reject('source_code_mismatch')
                self.cache[name]=(key,expected_hash)
            if file_key(os.fstat(fd))!=key:reject('source_code_changed')
            return before
        finally:os.close(fd)

    def verify(self,peer):
        p=self.policy
        if type(peer)is not Peer or type(peer.pid)is not int or not 0<peer.pid<2**31 or type(peer.uid)is not int or type(peer.gid)is not int or (peer.uid,peer.gid)!=(p.peer_uid,p.peer_gid):reject('source_peer_mismatch')
        proc=None
        try:
            proc=ProcHandle(peer.pid)
            start=start_ticks(proc.text('stat',8192),peer.pid)
            if proc.text('comm',128)!='mosquitto\n':reject('source_process_invalid')
            credentials_from_status(proc.text('status',32768),peer)
            cgroup_bound(proc.text('cgroup',8192),p.container_id)
            zero_offsets(proc.text('timens_offsets',1024))
            domain=local_clock_domain()
            if boot_domain(proc.text('root/proc/sys/kernel/random/boot_id',128))!=domain:reject('source_clock_domain_invalid')
            binary=self._code(proc,'exe',p.binary_sha256,0,8388608)
            plugin=self._code(proc,'root'+p.plugin_path,p.plugin_sha256,p.plugin_owner_uid,1048576)
            maps=proc.text('maps',262144)
            mapped_executable(maps,binary)
            mapped_executable(maps,plugin,p.plugin_path)
            if start_ticks(proc.text('stat',8192),peer.pid)!=start:reject('source_process_changed')
            # Reopen current objects to reject rename/exec between hash and maps.
            for name,info in [('exe',binary),('root'+p.plugin_path,plugin)]:
                fd=proc.open(name)
                try:
                    if file_key(os.fstat(fd))!=file_key(info):reject('source_code_changed')
                finally:os.close(fd)
            proc.alive()
            identity={'pid':str(peer.pid),'start_ticks':str(start),'domain':domain,
                      'binary':list(map(str,file_key(binary))),'plugin':list(map(str,file_key(plugin)))}
            epoch=hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
            return VerifiedBinding(epoch,domain)
        except BindingUnavailable:raise
        except (OSError,UnicodeError,ValueError,OverflowError):
            reject('source_identity_unknown')
        finally:
            if proc:proc.close()
