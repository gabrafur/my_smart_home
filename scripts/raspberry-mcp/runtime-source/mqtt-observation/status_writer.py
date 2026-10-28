"""Atomic bounded reader status, separately from immutable handoff packets."""
import json,os,secrets
from file_bridge import BridgeUnavailable
class StatusWriter:
    def __init__(self,bridge):self.bridge=bridge
    def write(self,value):
        b=self.bridge;b._parents()
        raw=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode("ascii")
        if len(raw)>8192:raise BridgeUnavailable("reader_status_capacity")
        try:old=os.stat("reader-status.json",dir_fd=b.report_fd,follow_symlinks=False)
        except FileNotFoundError:old=None
        if old is not None and not b._safe_file(old,0,b.consumer_gid,0o640,8192):
            raise BridgeUnavailable("reader_status_file_unsafe")
        name=".reader-"+secrets.token_hex(12)+".tmp";fd=None;renamed=False
        try:
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o640,dir_fd=b.report_fd)
            os.fchown(fd,0,b.consumer_gid);os.fchmod(fd,0o640)
            with os.fdopen(fd,"wb",closefd=True)as file:
                fd=None;file.write(raw);file.flush();os.fsync(file.fileno())
            b._parents();os.replace(name,"reader-status.json",src_dir_fd=b.report_fd,dst_dir_fd=b.report_fd);renamed=True
            os.fsync(b.report_fd)
        except OSError:raise BridgeUnavailable("reader_status_write_failed")from None
        finally:
            if fd is not None:os.close(fd)
            if not renamed:
                try:os.unlink(name,dir_fd=b.report_fd)
                except FileNotFoundError:pass
