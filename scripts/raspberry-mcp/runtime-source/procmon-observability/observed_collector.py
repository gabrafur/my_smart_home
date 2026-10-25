"""Metadata-only observation around the unchanged, root-sealed collector."""
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
REASONS = frozenset(('not_regular','oversize','stat_format','negative','identity_format',
    'boot_format','output_limit','interrupted_scan_limit','unsafe_interrupted_sample',
    'interrupted_archive_full','unsafe_interrupted_archive','interrupted_sample_changed',
    'interrupted_archive_conflict','unexpected_file_count','unexpected_history_entry',
    'unsafe_history','reservation_exceeds_budget','clock_rollback','storage_budget',
    'unsafe_state','disk_pressure','duplicate_sample_no_retry','collection_interrupted'))
KINDS = frozenset(('ValueError','PermissionError','FileNotFoundError','TimeoutError',
                  'MemoryError','OSError','BlockingIOError','JSONDecodeError'))


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
        # signal modules, nor change the original alarm or handler semantics.
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
            return original_preserve(*args,**kwargs)

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


def main():
    observer=Observer()
    try:
        if len(sys.argv)!=1 or os.geteuid()==0:
            raise ValueError('fixed_unprivileged_entrypoint_required')
        mod=load_collector();observer.install(mod)
        # Original limits, alarm, state machine and history retention are unchanged.
        mod.apply_limits();observer.stage='state_validation'
        mod.run_once()
    except Exception as exc:
        observer.emit(exc)
        return 1
    observer.emit()
    return 0


if __name__=='__main__':
    raise SystemExit(main())
