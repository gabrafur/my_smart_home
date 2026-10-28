"""Consume the manager-owned fixed Unix datagram socket without unlinking it."""
from pathlib import Path
import os,socket,stat
from socket_reader import SocketReader,ReaderUnavailable,fail

class ActivatedSocketReader(SocketReader):
    def __init__(self,path,*,fd,intake,group_gid=1883):
        self.path=Path(path);self.intake=intake;self.sock=None;self.identity=None
        copied=None
        try:
            if os.geteuid()!=0 or type(fd)is not int or not 3<=fd<=255 or type(group_gid)is not int or group_gid!=1883:
                fail("activated_socket_role_invalid")
            parent=self.path.parent.lstat()
            if (not self.path.is_absolute()or self.path.parent.resolve()!=self.path.parent
                or not stat.S_ISDIR(parent.st_mode)or parent.st_uid!=0 or parent.st_gid!=0
                or stat.S_IMODE(parent.st_mode)!=0o755):
                fail("activated_socket_parent_invalid")
            info=self.path.lstat()
            if (not stat.S_ISSOCK(info.st_mode)or info.st_uid!=0 or info.st_gid!=group_gid
                or stat.S_IMODE(info.st_mode)!=0o620 or info.st_nlink!=1):
                fail("activated_socket_path_invalid")
            copied=os.dup(fd);self.sock=socket.socket(fileno=copied);copied=None
            if (self.sock.family!=socket.AF_UNIX or self.sock.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)!=socket.SOCK_DGRAM
                or self.sock.getsockname()!=str(self.path)):
                fail("activated_socket_identity_invalid")
            try:self.sock.getpeername()
            except OSError as exc:
                import errno
                if exc.errno!=errno.ENOTCONN:raise
            else:fail("activated_socket_connected")
            if self.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED)!=1:
                fail("activated_socket_credentials_missing")
            if os.get_inheritable(self.sock.fileno()):fail("activated_socket_descriptor_inheritable")
            self.sock.setblocking(False)
            self.identity=(info.st_dev,info.st_ino)
        except ReaderUnavailable:
            self.close();raise
        except OSError:
            self.close();fail("activated_socket_open_failed")
        finally:
            if copied is not None:
                try:os.close(copied)
                except OSError:pass
    def close(self):
        if self.sock is not None:self.sock.close();self.sock=None
        self.identity=None

def from_systemd(path,*,intake,environ=None):
    env=os.environ if environ is None else environ
    if (env.get("LISTEN_PID")!=str(os.getpid())or env.get("LISTEN_FDS")!="1"
        or env.get("LISTEN_FDNAMES")!="source"):
        fail("activated_socket_environment_invalid")
    reader=ActivatedSocketReader(path,fd=3,intake=intake)
    os.close(3)
    for key in ["LISTEN_PID","LISTEN_FDS","LISTEN_FDNAMES"]:env.pop(key,None)
    return reader
