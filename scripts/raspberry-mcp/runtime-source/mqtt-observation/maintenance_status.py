"""Private atomic facts from the running reader, never caller attestations.

The privileged maintenance actor reads this snapshot. The Node-RED consumer
continues to use the unchanged public reader-status schema.
"""
import hashlib,json,os,secrets,stat
from pathlib import Path
from handoff import nonempty
from worker_config import policy_document

LIMIT=16384
class StatusUnavailable(RuntimeError):pass
def need(ok):
    if not ok:raise StatusUnavailable('maintenance_status_unavailable')
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
def digest(v):return hashlib.sha256(canonical(v)).hexdigest()

def facts(worker,reader_status):
    body=worker.ledger.body;handoff=body['handoff'];state=body['state']
    counts=worker.ledger.report()['accounting']['handoff']['acked_counts']
    value={'schema_version':1,'source':'fixed_live_mqtt_maintenance_facts',
      'reader_pid':str(worker.pid),'reader_start_ticks':str(worker.process_start_ticks),
      'source_policy_sha256':digest(policy_document(worker.source_verifier.policy,worker.approval_id)),
      'reader':reader_status,'accepted_frames':str(body['accepted_frames']),
      'acknowledged_frames':counts['frames'],'acknowledged_counts':counts,
      'pending_packet':handoff['published']is not None,'active_counts_nonempty':nonempty(handoff['active']),
      'unknown_epoch_tails':str(state['unknown_epoch_tails'])if state is not None else'0',
      'full24h_proven':False,'effect_executed':False}
    return {'body':value,'sha256':digest(value)}

class Writer:
    def __init__(self,directory):
        self.path=Path(directory);self.fd=None
        need(os.geteuid()==0 and os.getegid()==0 and self.path.is_absolute()and self.path.resolve()==self.path)
        try:
            self.fd=os.open(self.path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            self._anchor()
        except BaseException:self.close();raise
    def _anchor(self):
        need(self.fd is not None);a=os.fstat(self.fd);b=self.path.lstat()
        need((a.st_dev,a.st_ino)==(b.st_dev,b.st_ino)and stat.S_ISDIR(b.st_mode)
             and(b.st_uid,b.st_gid,stat.S_IMODE(b.st_mode))==(0,0,0o700))
    def write(self,value):
        raw=canonical(value);need(len(raw)<=LIMIT);self._anchor()
        try:old=os.stat('maintenance-status.json',dir_fd=self.fd,follow_symlinks=False)
        except FileNotFoundError:old=None
        if old is not None:
            need(stat.S_ISREG(old.st_mode)and old.st_nlink==1
                 and(old.st_uid,old.st_gid,stat.S_IMODE(old.st_mode))==(0,0,0o600))
        name='.maintenance-status-'+secrets.token_hex(12)+'.tmp';fd=None
        try:
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd)
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb')as f:fd=None;f.write(raw);f.flush();os.fsync(f.fileno())
            self._anchor();os.replace(name,'maintenance-status.json',src_dir_fd=self.fd,dst_dir_fd=self.fd);os.fsync(self.fd)
        except OSError:raise StatusUnavailable('maintenance_status_write_failed')from None
        finally:
            if fd is not None:os.close(fd)
            try:os.unlink(name,dir_fd=self.fd)
            except FileNotFoundError:pass
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
