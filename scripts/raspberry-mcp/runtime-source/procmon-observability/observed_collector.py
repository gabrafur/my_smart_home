"""Observe the unchanged root-sealed collector with a fixed15s wall/I/O envelope.
Original CPU/memory/file limits and handlers remain; original collector bytes
still arm5s. This wrapper explicitly rearms15s after original apply_limits.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import stat
import sys
import time
import types

COLLECTOR = Path('/usr/local/lib/raspberry-procmon/collector.py')
COLLECTOR_SHA = 'd53a173123b0d6d96406e56bd73559fd5fd00d6dd040bf36cf2c21b978e1b277'
WALL_IO_ENVELOPE_SECONDS = 15
REASONS = frozenset(('not_regular','oversize','stat_format','negative','identity_format',
    'boot_format','output_limit','interrupted_scan_limit','unsafe_interrupted_sample',
    'interrupted_archive_full','unsafe_interrupted_archive','interrupted_sample_changed',
    'interrupted_archive_conflict','interrupted_rename_unavailable','collector_mutex_not_held','unexpected_file_count','unexpected_history_entry',
    'unsafe_history','reservation_exceeds_budget','clock_rollback','storage_budget',
    'unsafe_state','disk_pressure','duplicate_sample_no_retry','collection_interrupted'))
KINDS = frozenset(('ValueError','PermissionError','FileNotFoundError','TimeoutError',
                  'MemoryError','OSError','BlockingIOError','JSONDecodeError'))


"""Candidate wrapper-only preservation; no collector replay or evidence deletion."""
import hashlib
import os
from pathlib import Path
import re
import stat

REPEATED_DIRECTORY='interrupted-repeated'
REPEATED_NAME=re.compile(
 r'(?:history--[0-9]{20}-[a-f0-9]{16}\.json|hours--[0-9]{12}\.json|state--last\.json|public--(?:snapshot|health)\.json)'
 r'--[a-f0-9]{64}--d([a-f0-9]{16})-i([a-f0-9]{16})\.tmp')

def _preserve_need(ok,reason):
 if not ok:raise ValueError(reason)
def _preserve_identity(s):
 return (s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink,
         s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def _archive_inventory(mod,directory,repeated=False):
 if not os.path.lexists(directory):return (0,0)
 info=directory.lstat()
 _preserve_need(stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid()
  and stat.S_IMODE(info.st_mode)==0o700,'unsafe_interrupted_archive')
 count=size=0
 with os.scandir(directory) as entries:
  for entry in entries:
   info=entry.stat(follow_symlinks=False)
   match=REPEATED_NAME.fullmatch(entry.name) if repeated else mod.INTERRUPTED_NAME.fullmatch(entry.name)
   _preserve_need(match is not None and stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid()
    and info.st_nlink==1 and info.st_size<=mod.MAX_SAMPLE,'unsafe_interrupted_archive')
   if repeated:
    mode=0o640 if entry.name.startswith('public--') else 0o600
    _preserve_need(stat.S_IMODE(info.st_mode)==mode
     and int(match.group(1),16)==info.st_dev and int(match.group(2),16)==info.st_ino,
     'unsafe_interrupted_archive')
   count+=1;size+=info.st_size
   _preserve_need(count<=mod.INTERRUPTED_COUNT and size<=mod.INTERRUPTED_CAP,'interrupted_archive_full')
 return count,size

def _pending_inventory(mod,state):
 candidates=[]
 for directory,pattern,mode,limit in (
  (state/'history',mod.HISTORY_NAME,0o600,mod.MAX_SAMPLE),
  (state/'hours',mod.HOUR_NAME,0o600,4096),
  (state,re.compile(r'last\.json'),0o600,mod.MAX_SAMPLE),
  (state/'public',re.compile(r'(?:snapshot|health)\.json'),0o640,65536)):
  with os.scandir(directory) as entries:
   for index,entry in enumerate(entries):
    _preserve_need(index<2100,'interrupted_scan_limit')
    if not entry.name.endswith('.tmp') or not pattern.fullmatch(entry.name[:-4]):continue
    info=entry.stat(follow_symlinks=False)
    _preserve_need(stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid() and info.st_nlink==1
     and stat.S_IMODE(info.st_mode)==mode and info.st_size<=limit,'unsafe_interrupted_sample')
    section='state' if directory==state else directory.name
    candidates.append((directory/entry.name,info,section,limit))
    _preserve_need(len(candidates)<=mod.INTERRUPTED_COUNT,'interrupted_archive_full')
 return candidates

def _rename_preserved_no_replace(source,target):
 # Linux/glibc atomic RENAME_NOREPLACE; never check-then-overwrite or copy/unlink.
 import ctypes
 import errno
 libc=ctypes.CDLL(None,use_errno=True)
 try:rename=libc.renameat2
 except AttributeError:raise ValueError('interrupted_rename_unavailable') from None
 rename.argtypes=(ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint)
 rename.restype=ctypes.c_int
 if rename(-100,os.fsencode(source),-100,os.fsencode(target),1)!=0:
  code=ctypes.get_errno()
  if code==errno.EEXIST:raise ValueError('interrupted_archive_conflict')
  if code in (errno.ENOSYS,errno.EINVAL):raise ValueError('interrupted_rename_unavailable')
  raise OSError(code,'interrupted_preservation_unconfirmed')

def _collector_mutex_held(mod,state):
 path=state/'lock';before=path.lstat()
 _preserve_need(stat.S_ISREG(before.st_mode) and before.st_uid==os.geteuid()
  and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1,'collector_mutex_not_held')
 token='%02x:%02x:%d'%(os.major(before.st_dev),os.minor(before.st_dev),before.st_ino)
 kernel=mod.limited_read(Path('/proc/locks'),262144).decode('ascii').splitlines()
 held=False
 for line in kernel:
  parts=line.split()
  if len(parts)>=8 and parts[1:4]==['FLOCK','ADVISORY','WRITE'] and parts[4]==str(os.getpid())    and parts[5]==token and parts[6:]==['0','EOF']:held=True
 _preserve_need(held and _preserve_identity(path.lstat())==_preserve_identity(before),'collector_mutex_not_held')

def preserve_repeated(mod,original,state=None):
 """Called only by cycle while its canonical collector flock remains held.

 Both buckets plus ALL pending writes share the original64/8MiB cap. Original
 collector bytes/regex stay immutable; its original preserve handles all normal
 paths. Only exact repeated-content conflicts receive separate retained names.
 """
 state=Path(mod.STATE if state is None else state)
 _collector_mutex_held(mod,state)
 archive=state/'interrupted';bucket=state/REPEATED_DIRECTORY
 old_count,old_size=_archive_inventory(mod,archive)
 repeated_count,repeated_size=_archive_inventory(mod,bucket,True)
 candidates=_pending_inventory(mod,state)
 _preserve_need(old_count+repeated_count+len(candidates)<=mod.INTERRUPTED_COUNT
  and old_size+repeated_size+sum(row[1].st_size for row in candidates)<=mod.INTERRUPTED_CAP,
  'interrupted_archive_full')
 try:return original(state)
 except ValueError as error:
  if error.args!=('interrupted_archive_conflict',):raise
 # Original preflights ALL targets before its first move. A conflict therefore
 # leaves every candidate intact. Validate every selected repeat before moving.
 moves=[]
 for path,info,section,limit in candidates:
  _preserve_need(_preserve_identity(path.lstat())==_preserve_identity(info),'interrupted_sample_changed')
  body=mod.limited_read(path,limit);digest=hashlib.sha256(body).hexdigest()
  _preserve_need(_preserve_identity(path.lstat())==_preserve_identity(info),'interrupted_sample_changed')
  name=f'{section}--{path.name[:-4]}--{digest}.tmp';prior=archive/name
  if not os.path.lexists(prior):continue
  before=prior.lstat()
  _preserve_need(stat.S_ISREG(before.st_mode) and before.st_uid==os.geteuid() and before.st_nlink==1
   and before.st_size==info.st_size and stat.S_IMODE(before.st_mode)==stat.S_IMODE(info.st_mode)
   and (before.st_dev,before.st_ino)!=(info.st_dev,info.st_ino),'interrupted_archive_conflict')
  _preserve_need(hashlib.sha256(mod.limited_read(prior,limit)).hexdigest()==digest
   and _preserve_identity(prior.lstat())==_preserve_identity(before),'interrupted_archive_conflict')
  _preserve_need(0<=info.st_dev<2**64 and 0<info.st_ino<2**64,'unsafe_interrupted_sample')
  target=bucket/(name[:-4]+f'--d{info.st_dev:016x}-i{info.st_ino:016x}.tmp')
  _preserve_need(not os.path.lexists(target),'interrupted_archive_conflict')
  moves.append((path,info,target,digest))
 _preserve_need(bool(moves),'interrupted_archive_conflict')
 if not os.path.lexists(bucket):
  bucket.mkdir(mode=0o700)
  parent_fd=mod.os.open(state,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:mod.os.fsync(parent_fd)
  finally:mod.os.close(parent_fd)
 _archive_inventory(mod,bucket,True)
 bucket_info=bucket.lstat()
 for path,info,target,digest in moves:
  _preserve_need(_preserve_identity(path.lstat())==_preserve_identity(info)
   and info.st_dev==bucket_info.st_dev,'interrupted_sample_changed')
 # No exception path deletes evidence or retries collection.
 evidence=[]
 for path,info,target,digest in moves:
  _preserve_need(_preserve_identity(path.lstat())==_preserve_identity(info),'interrupted_sample_changed')
  _rename_preserved_no_replace(path,target)
  for folder in (bucket,path.parent):
   fd=mod.os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
   try:mod.os.fsync(fd)
   finally:mod.os.close(fd)
  row={'collection':'interrupted_sample_preserved','source':str(path.relative_to(state)),
       'sha256':digest,'bytes':info.st_size,'promoted_to_observation':False,'repeated_content':True}
  mod.sys.stderr.write(mod.json.dumps(row)+'\n');evidence.append(row)
 return evidence+original(state)


def classification(exc):
    kind = type(exc).__name__
    # Exception text is never included. Only exact fixed producer reason codes.
    reason = exc.args[0] if type(exc) in (ValueError,TimeoutError) and exc.args else None
    return {'exception_kind':kind if kind in KINDS else 'other',
            'reason':reason if isinstance(reason,str) and reason in REASONS else 'unclassified',
            'errno':exc.errno if isinstance(exc,OSError) and isinstance(exc.errno,int)
                    and 0<=exc.errno<=4095 else None}


def load_collector():
    for parent in reversed(COLLECTOR.parents):
        s=parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid or s.st_mode&0o022:
            raise ValueError('unsafe_root_parent')
    fd=os.open(COLLECTOR,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid or s.st_mode&0o022 or s.st_nlink!=1 or s.st_size>65536:
            raise ValueError('unsafe_collector')
        raw=os.read(fd,65537)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest()!=COLLECTOR_SHA:
        raise ValueError('collector_changed')
    spec=importlib.util.spec_from_file_location('sealed_procmon',COLLECTOR)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    return mod


class Observer:
    def __init__(self):
        self.stage='bootstrap';self.first_failure=None
        self.started=time.monotonic();self.usage=resource.getrusage(resource.RUSAGE_SELF)
        self.signal_observations=[];self.signal_count=0
        self.fsync_calls=0;self.fsync_wall_ms=0;self.fsync_max_wall_ms=0
        self.active_io=None;self.first_io_failure=None

    def install(self,mod):
        original_cycle=mod.cycle
        original_atomic=mod.atomic
        original_prune=mod.prune
        original_preserve=mod.preserve_interrupted

        # Isolate adapter attributes: never monkey-patch the process-wide os or
        # signal modules. Handlers stay original; main explicitly rearms the
        # wall/I/O alarm to the fixed15s envelope after original apply_limits.
        original_os=mod.os
        original_signal=mod.signal
        os_adapter=types.SimpleNamespace(**vars(original_os))
        signal_adapter=types.SimpleNamespace(**vars(original_signal))

        def fsync(fd):
            started=time.monotonic()
            kind='fsync_directory' if stat.S_ISDIR(original_os.fstat(fd).st_mode) else 'fsync_regular_file'
            previous=self.active_io
            self.active_io={'operation':kind,'started':started}
            self.fsync_calls+=1
            try:
                return original_os.fsync(fd)
            except BaseException:
                if self.first_io_failure is None:
                    self.first_io_failure={'operation':kind,'phase':self.stage}
                raise
            finally:
                elapsed=max(0,round((time.monotonic()-started)*1000))
                self.fsync_wall_ms+=elapsed
                self.fsync_max_wall_ms=max(self.fsync_max_wall_ms,elapsed)
                self.active_io=previous

        def register_signal(signum,handler):
            if signum in (original_signal.SIGALRM,original_signal.SIGTERM) and callable(handler):
                def observed_signal(received,frame):
                    self.signal_count=min(1000,self.signal_count+1)
                    if len(self.signal_observations)<2:
                        io=self.active_io
                        self.signal_observations.append({
                            'signal':'SIGALRM' if received==original_signal.SIGALRM else 'SIGTERM',
                            'phase':self.stage,
                            'io_operation':io['operation'] if io else None,
                            'io_elapsed_ms':max(0,round((time.monotonic()-io['started'])*1000)) if io else None})
                    return handler(received,frame)
                return original_signal.signal(signum,observed_signal)
            return original_signal.signal(signum,handler)

        os_adapter.fsync=fsync
        signal_adapter.signal=register_signal
        mod.os=os_adapter;mod.signal=signal_adapter

        def atomic(path,value,maximum=mod.MAX_SAMPLE,mode=0o600):
            self.stage=('write_history' if path.parent.name=='history' else
                        'write_hour' if path.parent.name=='hours' else
                        'publish_snapshot' if path.name=='snapshot.json' else
                        'publish_health' if path.name=='health.json' else 'write_last')
            # The original requests an exact mode, then fchmods after open.
            # A signal between those calls can leave an empty 0600 public
            # temporary that the strict 0640 recovery gate correctly rejects.
            # Create with the already-approved mode; preserve all deadlines,
            # original writes, recovery checks and the sealed collector bytes.
            previous_mask=os.umask(0o077)
            try:
                os.umask(previous_mask & ~mode)
                return original_atomic(path,value,maximum,mode)
            finally:
                os.umask(previous_mask)

        def prune(path,*args,**kwargs):
            self.stage='prune_history' if path.name=='history' else 'prune_hours'
            return original_prune(path,*args,**kwargs)

        def preserve(*args,**kwargs):
            self.stage='preserve_interrupted'
            return preserve_repeated(mod,original_preserve,*args,**kwargs)

        def cycle(state=mod.STATE,sampler=mod.collect):
            def observed_sampler():
                self.stage='sample_processes'
                return sampler()
            self.stage='cycle_validation'
            try:
                return original_cycle(state,sampler=observed_sampler)
            except Exception as exc:
                self.first_failure={'phase':self.stage,**classification(exc)}
                raise
        mod.atomic=atomic;mod.prune=prune;mod.preserve_interrupted=preserve;mod.cycle=cycle

    def result(self,exc=None):
        usage=resource.getrusage(resource.RUSAGE_SELF)
        row={'source':'procmon_runtime_v1','schema':1,'observed_at':int(time.time()),
             'monotonic_ms':int(time.monotonic()*1000),
             'status':'failed' if exc else 'completed',
             'wall_ms':max(0,round((time.monotonic()-self.started)*1000)),
             'cpu_us':max(0,round(((usage.ru_utime+usage.ru_stime)-
                                  (self.usage.ru_utime+self.usage.ru_stime))*1e6)),
             'peak_rss_bytes':int(usage.ru_maxrss)*1024,
             'automatic_retry':False,
             'process_total_cpu_us':max(0,round((usage.ru_utime+usage.ru_stime)*1e6)),
             'fsync_observation':{'calls':self.fsync_calls,'sum_wall_ms':self.fsync_wall_ms,
                                  'max_wall_ms':self.fsync_max_wall_ms,
                                  'first_failure':self.first_io_failure},
             'signals_observed':self.signal_observations,'signal_count':self.signal_count}
        if exc:
            row.update(self.first_failure or {'phase':self.stage,**classification(exc)})
        return row

    def emit(self,exc=None):
        raw=(json.dumps(self.result(exc),separators=(',',':'),allow_nan=False)+'\n').encode()
        if len(raw)>768:
            raise ValueError('telemetry_limit')
        os.write(2,raw)


def apply_observed_limits(mod):
    # Fixed wall-clock allowance, not a CPU/memory/cadence or durability waiver.
    if type(WALL_IO_ENVELOPE_SECONDS) is not int or WALL_IO_ENVELOPE_SECONDS != 15:
        raise ValueError('unsupported_wall_io_envelope')
    mod.apply_limits()  # Original CPU/memory/files/handlers and original5s alarm.
    mod.signal.alarm(WALL_IO_ENVELOPE_SECONDS)  # No new handler or retry.


def main():
    observer=Observer()
    try:
        if len(sys.argv)!=1 or os.geteuid()==0:
            raise ValueError('fixed_unprivileged_entrypoint_required')
        mod=load_collector();observer.install(mod)
        # Original non-wall limits, state machine, durability and retention stay.
        # Only the wrapper wall/I/O envelope is explicitly extended from5s to15s.
        try:
            apply_observed_limits(mod);observer.stage='state_validation'
            mod.run_once()
        finally:
            # The collection deadline ends with this invocation, on success or
            # failure. An armed SIGALRM must not outlive collection into telemetry
            # or interpreter shutdown. The outer systemd20s limit remains active.
            mod.signal.alarm(0)
    except Exception as exc:
        observer.emit(exc)
        return 1
    observer.emit()
    return 0


if __name__=='__main__':
    raise SystemExit(main())
