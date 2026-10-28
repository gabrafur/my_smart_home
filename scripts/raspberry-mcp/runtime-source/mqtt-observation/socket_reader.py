"""Unarmed Unix datagram intake; contains no scheduling or house policy.

Kernel credentials and file/clock attestation are required before ledger intake.
Raw data is never logged or persisted here. This stage is not Node-RED delivery.
https://docs.python.org/3/library/socket.html#socket.socket.recvmsg
"""
from pathlib import Path
import array,os,re,socket,stat,struct,time
from protocol import MAX_FRAME_BYTES
from source_binding import Peer,VerifiedBinding,BindingUnavailable

class ReaderUnavailable(RuntimeError):pass
def fail(reason):
    raise ReaderUnavailable(reason)from None

class PacketIntake:
    def __init__(self,ledger,verifier):
        self.ledger=ledger;self.verifier=verifier
    def packet(self,raw,ancillary,flags,arrived_ns):
        credentials=[];invalid=False
        # SCM_RIGHTS installs descriptors even when the message is rejected.
        # Always close every descriptor the kernel actually supplied.
        for level,kind,data in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                fds=array.array('i')
                fds.frombytes(data[:len(data)-len(data)%fds.itemsize])
                for fd in fds:
                    try:os.close(fd)
                    except OSError:pass
                invalid=True
            elif level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS:
                if len(data)!=struct.calcsize('3i'):invalid=True
                else:credentials.append(Peer(*struct.unpack('3i',data)))
            else:invalid=True
        if flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC):
            return {'status':'unknown','report':self.ledger.record_fault('transport_truncated',arrived_ns)}
        if flags&~getattr(socket,'MSG_CMSG_CLOEXEC',0)or invalid or len(credentials)!=1:
            return {'status':'unknown','report':self.ledger.record_fault('transport_ancillary_invalid',arrived_ns)}
        try:
            binding=self.verifier.verify(credentials[0])
            if (type(binding)is not VerifiedBinding or binding.kernel_peer_verified is not True
                or binding.mapped_file_identity_verified is not True or binding.same_clock_domain is not True
                or re.fullmatch('[a-f0-9]{64}',binding.process_epoch)is None
                or binding.clock_domain_id!=self.ledger.body['clock_domain_id']):
                raise BindingUnavailable('source_identity_unknown')
        except BindingUnavailable:
            return {'status':'unknown','report':self.ledger.record_fault('source_identity_lost',arrived_ns)}
        return self.ledger.frame(raw,arrived_ns,source_binding_verified=True)

class SocketReader:
    def __init__(self,path,*,group_gid,intake):
        self.path=Path(path);self.intake=intake;self.sock=None;self.identity=None
        try:
            parent=self.path.parent.lstat()
            if (not self.path.is_absolute()or self.path.parent.resolve()!=self.path.parent
                or not stat.S_ISDIR(parent.st_mode)or parent.st_uid!=os.geteuid()or parent.st_mode&0o022):
                fail('socket_parent_unsafe')
            if type(group_gid)is not int or not 0<=group_gid<2**32:fail('socket_group_invalid')
            self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM|socket.SOCK_CLOEXEC)
            self.sock.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
            self.sock.bind(str(self.path))
            info=self.path.lstat();self.identity=(info.st_dev,info.st_ino)
            if not stat.S_ISSOCK(info.st_mode)or info.st_uid!=os.geteuid():fail('socket_file_unsafe')
            os.chown(self.path,-1,group_gid);os.chmod(self.path,0o620)
            self.sock.setblocking(False)
        except ReaderUnavailable:
            self.close();raise
        except OSError:
            self.close();fail('socket_open_failed')
    def receive(self):
        try:
            raw,ancillary,flags,_=self.sock.recvmsg(MAX_FRAME_BYTES,
                socket.CMSG_SPACE(struct.calcsize('3i'))+socket.CMSG_SPACE(16*array.array('i').itemsize),
                socket.MSG_CMSG_CLOEXEC)
            arrived=time.clock_gettime_ns(time.CLOCK_BOOTTIME)
        except BlockingIOError:return None
        except OSError:fail('socket_receive_failed')
        return self.intake.packet(raw,ancillary,flags,arrived)
    def close(self):
        if self.sock:
            self.sock.close();self.sock=None
        if self.identity is not None:
            try:
                info=self.path.lstat()
                if (info.st_dev,info.st_ino)==self.identity and stat.S_ISSOCK(info.st_mode)and info.st_uid==os.geteuid():
                    self.path.unlink()
            except FileNotFoundError:pass
            self.identity=None
