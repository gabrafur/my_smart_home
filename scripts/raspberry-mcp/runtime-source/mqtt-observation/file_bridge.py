"""Unarmed fixed-name report/ACK file transport; no policies or house effects.

Production construction must pin the reviewed directories and actual Node-RED
UID/GID. This library is not an arbitrary-filesystem MCP or Root command tool.
"""
from pathlib import Path
import copy,errno,hashlib,json,os,secrets,stat,time
from receiver_ledger import encode,stringify
from source_binding import file_key

REPORT_LIMIT=65536
ACK_LIMIT=4096
class BridgeUnavailable(RuntimeError):pass
class AckChanged(RuntimeError):pass
def fail(reason):
    raise BridgeUnavailable(reason)from None

class FileBridge:
    def __init__(self,report_parent,ack_parent,*,consumer_uid,consumer_gid,clock_ns=None):
        self.report_parent=Path(report_parent);self.ack_parent=Path(ack_parent)
        self.consumer_uid=consumer_uid;self.consumer_gid=consumer_gid
        self.report_fd=None;self.ack_fd=None;self.ack_seen=None
        self.clock_ns=clock_ns or (lambda:time.clock_gettime_ns(time.CLOCK_BOOTTIME))
        if any(type(v)is not int or not 0<=v<2**32 for v in [consumer_uid,consumer_gid]):fail('bridge_role_invalid')
        try:
            self.report_fd=self._directory(self.report_parent,os.geteuid(),consumer_gid,0o750)
            self.ack_fd=self._directory(self.ack_parent,consumer_uid,consumer_gid,0o700)
        except BridgeUnavailable:
            self.close();raise
        except OSError:
            self.close();fail('bridge_open_failed')

    @staticmethod
    def _directory(path,uid,gid,mode):
        if not path.is_absolute()or path.resolve()!=path:fail('bridge_parent_unsafe')
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            if (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(uid,gid,mode):fail('bridge_parent_unsafe')
            return fd
        except BaseException:os.close(fd);raise

    def _parents(self):
        for path,fd,uid,mode in [(self.report_parent,self.report_fd,os.geteuid(),0o750),
                                 (self.ack_parent,self.ack_fd,self.consumer_uid,0o700)]:
            if fd is None:fail('bridge_closed')
            try:
                bound=os.fstat(fd);current=path.lstat()
                if (current.st_dev,current.st_ino)!=(bound.st_dev,bound.st_ino)or not stat.S_ISDIR(current.st_mode):
                    fail('bridge_parent_changed')
                if (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(uid,self.consumer_gid,mode):
                    fail('bridge_parent_changed')
            except OSError:fail('bridge_parent_changed')

    @staticmethod
    def _safe_file(info,uid,gid,mode,limit):
        return (stat.S_ISREG(info.st_mode)and info.st_nlink==1 and info.st_uid==uid
                and info.st_gid==gid and stat.S_IMODE(info.st_mode)==mode and 0<=info.st_size<=limit)

    def _existing_report(self):
        try:fd=os.open('report.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.report_fd)
        except FileNotFoundError:return None
        except OSError:fail('report_file_unsafe')
        try:
            info=os.fstat(fd)
            if not self._safe_file(info,os.geteuid(),self.consumer_gid,0o640,REPORT_LIMIT):fail('report_file_unsafe')
            raw=os.read(fd,REPORT_LIMIT+1)
            if len(raw)>REPORT_LIMIT or file_key(os.fstat(fd))!=file_key(info):fail('report_file_changed')
            return raw
        finally:os.close(fd)

    def publish(self,ledger,at_ns):
        self._parents()
        packet=ledger.publish(at_ns)
        state=ledger.body['handoff']
        body={'packet':packet,'last_ack':stringify(copy.deepcopy(state['last_ack'])),
              'acked_buckets':str(state['acked_buckets']),'acked_counts':stringify(copy.deepcopy(state['acked_counts'])),
              'source_clock_domain_id':ledger.body['clock_domain_id']}
        envelope={'schema_version':1,'body':body,'sha256':hashlib.sha256(encode(body).encode('ascii')).hexdigest()}
        raw=encode(envelope).encode('ascii')
        if len(raw)>REPORT_LIMIT:fail('report_capacity_reached')
        if self._existing_report()==raw:
            # Also resolves an earlier rename whose directory fsync failed.
            try:os.fsync(self.report_fd)
            except OSError:fail('report_write_failed')
            return {'written':False,'envelope':envelope}
        name='.report-'+secrets.token_hex(12)+'.tmp';fd=None;identity=None;renamed=False
        try:
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o640,dir_fd=self.report_fd)
            identity=os.fstat(fd);os.fchown(fd,-1,self.consumer_gid);os.fchmod(fd,0o640)
            offset=0
            while offset<len(raw):
                written=os.write(fd,raw[offset:])
                if written<=0:fail('report_write_failed')
                offset+=written
            os.fsync(fd);os.close(fd);fd=None
            self._parents()
            os.replace(name,'report.json',src_dir_fd=self.report_fd,dst_dir_fd=self.report_fd);renamed=True
            os.fsync(self.report_fd)
        except BridgeUnavailable:raise
        except OSError:fail('report_write_failed')
        finally:
            if fd is not None:os.close(fd)
            if not renamed and identity is not None:
                try:
                    remaining=os.stat(name,dir_fd=self.report_fd,follow_symlinks=False)
                    if (remaining.st_dev,remaining.st_ino)==(identity.st_dev,identity.st_ino):
                        os.unlink(name,dir_fd=self.report_fd)
                except FileNotFoundError:pass
        return {'written':True,'envelope':envelope}

    def poll_ack(self,ledger):
        self._parents()
        try:info=os.stat('ack.json',dir_fd=self.ack_fd,follow_symlinks=False)
        except FileNotFoundError:return {'status':'absent'}
        except OSError:fail('ack_metadata_unavailable')
        identity=file_key(info)
        if self.ack_seen==identity:return {'status':'unchanged'}
        parsed={}
        if self._safe_file(info,self.consumer_uid,self.consumer_gid,0o600,ACK_LIMIT):
            fd=None
            try:
                fd=os.open('ack.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.ack_fd)
                before=os.fstat(fd)
                if file_key(before)!=identity:raise AckChanged()
                chunks=[];size=0
                while True:
                    chunk=os.read(fd,min(1024,ACK_LIMIT+1-size))
                    if not chunk:break
                    size+=len(chunk)
                    if size>ACK_LIMIT:raise AckChanged()
                    chunks.append(chunk)
                if file_key(os.fstat(fd))!=identity:raise AckChanged()
                raw=b''.join(chunks)
                value=json.loads(raw.decode('ascii'))
                # Producer/consumer use canonical ASCII JSON; reject duplicate
                # keys, ambiguous whitespace and unsupported number spellings.
                if encode(value).encode('ascii')==raw:parsed=value
            except (UnicodeError,ValueError,TypeError,RecursionError):
                parsed={}
            except AckChanged:return {'status':'changed_retry'}
            except OSError as exc:
                if exc.errno in (errno.ENOENT,errno.ELOOP):return {'status':'changed_retry'}
                fail('ack_read_failed')
            finally:
                if fd is not None:os.close(fd)
        result=ledger.acknowledge(parsed,self.clock_ns())
        self.ack_seen=identity
        return result

    def close(self):
        for key in ['report_fd','ack_fd']:
            fd=getattr(self,key,None)
            if fd is not None:os.close(fd);setattr(self,key,None)
