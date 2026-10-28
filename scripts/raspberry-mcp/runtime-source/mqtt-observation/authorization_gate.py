"""Default-deny Root authorization gate for metadata-only observation.

No CLI or MCP takes arbitrary paths. The fixed-path worker will construct this
class. Normal worker close preserves an approved runtime marker; revocation is
driven by the durable policy, so a reader restart never silently resets scope.
"""
from pathlib import Path
import hashlib,json,math,os,re,stat,time

SCOPE="mqtt_metadata_seven_classes_v1"
class GateInvalid(Exception):pass
def require(ok,reason):
    if not ok:raise GateInvalid(reason)
def identity(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def pairs(rows):
    value={}
    for k,v in rows:
        require(k not in value,"policy_invalid")
        value[k]=v
    return value
def parse_policy(raw):
    try:
        require(len(raw)<=4096,"policy_invalid")
        p=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(GateInvalid("policy_invalid")))
        require(isinstance(p,dict)and set(p)=={"version","scope","enabled","expires_at","approval_id"},"policy_invalid")
        require(type(p["version"])is int and p["version"]==1 and p["scope"]==SCOPE,"policy_invalid")
        require(type(p["enabled"])is bool,"policy_invalid")
        require(p["expires_at"]is None or(type(p["expires_at"])is int and 0<=p["expires_at"]<2**53),"policy_invalid")
        require(isinstance(p["approval_id"],str)and re.fullmatch("[a-f0-9]{64}",p["approval_id"])is not None,"policy_invalid")
        return p
    except(UnicodeError,ValueError,TypeError):raise GateInvalid("policy_invalid")from None

class AuthorizationGate:
    def __init__(self,runtime_directory,policy_path):
        self.runtime=Path(runtime_directory);self.policy=Path(policy_path)
        self.runtime_fd=None;self.policy_fd=None
        try:
            self.runtime_fd=self._directory(self.runtime,0o755)
            require(self.policy.name=="authorization.json","policy_path_invalid")
            self.policy_fd=self._directory(self.policy.parent,0o700)
        except:
            self.close();raise
    def _directory(self,path,mode):
        require(path.is_absolute()and path.resolve()==path,"directory_invalid")
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        s=os.fstat(fd)
        if not(stat.S_ISDIR(s.st_mode)and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==mode):
            os.close(fd);raise GateInvalid("directory_invalid")
        return fd
    def _anchor(self,path,fd,mode):
        require(fd is not None,"gate_closed")
        bound=os.fstat(fd);named=os.lstat(path)
        require((bound.st_dev,bound.st_ino)==(named.st_dev,named.st_ino)
                and stat.S_ISDIR(named.st_mode)and named.st_uid==named.st_gid==0
                and stat.S_IMODE(named.st_mode)==mode,"directory_changed")
    def _runtime_anchor(self):
        self._anchor(self.runtime,self.runtime_fd,0o755)
    @staticmethod
    def _marker_valid(s):
        return stat.S_ISREG(s.st_mode)and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o444 and s.st_nlink==1 and s.st_size==0
    def _remove_marker(self):
        self._runtime_anchor()
        try:s=os.stat("authorized",dir_fd=self.runtime_fd,follow_symlinks=False)
        except FileNotFoundError:return False
        require(self._marker_valid(s),"runtime_marker_invalid")
        os.unlink("authorized",dir_fd=self.runtime_fd);os.fsync(self.runtime_fd)
        return True
    def _ensure_marker(self):
        self._runtime_anchor()
        try:
            s=os.stat("authorized",dir_fd=self.runtime_fd,follow_symlinks=False)
        except FileNotFoundError:s=None
        if s is not None:
            require(self._marker_valid(s),"runtime_marker_invalid")
            return False
        fd=os.open("authorized",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o444,dir_fd=self.runtime_fd)
        try:
            os.fchmod(fd,0o444);require(self._marker_valid(os.fstat(fd)),"runtime_marker_invalid");os.fsync(fd)
        finally:os.close(fd)
        os.fsync(self.runtime_fd);return True
    def _read(self):
        self._anchor(self.policy.parent,self.policy_fd,0o700)
        fd=os.open(self.policy.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.policy_fd)
        try:
            before=os.fstat(fd)
            require(stat.S_ISREG(before.st_mode)and before.st_uid==before.st_gid==0
                    and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1
                    and before.st_size<=4096,"policy_metadata_invalid")
            raw=os.read(fd,4097)
            require(identity(os.fstat(fd))==identity(before),"policy_changed")
            return parse_policy(raw),hashlib.sha256(raw).hexdigest()
        finally:os.close(fd)
    def refresh(self,now=None):
        policy_sha=None
        try:
            p,policy_sha=self._read()
            now=time.time()if now is None else now
            require(type(now)in(int,float)and math.isfinite(now)and now>=0,"clock_invalid")
            state="active"
            if not p["enabled"]:state="disabled"
            elif p["expires_at"]is not None and now>=p["expires_at"]:state="expired"
            self._runtime_anchor()
            try:os.stat("revoked",dir_fd=self.runtime_fd,follow_symlinks=False);state="revoked"
            except FileNotFoundError:pass
            if state=="active":
                changed=self._ensure_marker()
                return {"state":state,"source_authorized":True,"policy_sha256":policy_sha,"runtime_marker_changed":changed}
            changed=self._remove_marker()
            return {"state":state,"source_authorized":False,"policy_sha256":policy_sha,"runtime_marker_changed":changed}
        except(GateInvalid,OSError)as exc:
            reason=exc.args[0]if isinstance(exc,GateInvalid)else"authorization_io_failed"
            try:changed=self._remove_marker();authorized=False
            except(GateInvalid,OSError):changed=False;authorized=None
            return {"state":"invalid","source_authorized":authorized,"policy_sha256":policy_sha,
                    "runtime_marker_changed":changed,"collection_error":reason}
    def close(self):
        for name in ["runtime_fd","policy_fd"]:
            fd=getattr(self,name,None)
            if fd is not None:os.close(fd);setattr(self,name,None)
