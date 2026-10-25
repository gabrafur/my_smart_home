"""Fixed metadata-only collector. No shell, sockets, credentials or process control."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import sys
import time

STATE = Path('/var/lib/raspberry-procmon')
LABELS = frozenset(('systemd','node','python3','docker','dockerd','containerd','tailscaled',
 'dropbear','cron','mosquitto','bash','sh','sshd','agetty','dbus-daemon','systemd-journal',
 'systemd-udevd','systemd-resolve','systemd-timesyn','code','codex','other'))
MAX_PIDS = 4096
MAX_SAMPLE = 1048576
HISTORY_CAP = 128 * 1048576
AGGREGATE_CAP = 8 * 1048576
AS_LIMIT = 64 * 1048576
ROW_KEYS = ('pid','ppid','uid','euid','gid','start_ticks','cpu_user_ticks','cpu_system_ticks','rss_bytes','threads')
HISTORY_NAME = re.compile(r'[0-9]{20}-[a-f0-9]{16}\.json')
HOUR_NAME = re.compile(r'[0-9]{12}\.json')
INTERRUPTED_CAP = 8 * 1048576
INTERRUPTED_COUNT = 64
INTERRUPTED_NAME = re.compile(r'(?:history--[0-9]{20}-[a-f0-9]{16}\.json|hours--[0-9]{12}\.json|state--last\.json|public--(?:snapshot|health)\.json)--[a-f0-9]{64}\.tmp')


def limited_read(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('not_regular')
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(fd, min(16384, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > maximum:
            raise ValueError('oversize')
        return bytes(data)
    finally:
        os.close(fd)


def parse_stat(raw):
    end = raw.rfind(b')')
    if end < 0:
        raise ValueError('stat_format')
    parts = raw[end + 2:].split()
    label = raw[raw.find(b'(')+1:end].decode('utf-8', 'replace')
    values = {key: int(parts[index]) for key,index in
              (('ppid',1),('start_ticks',19),('cpu_user_ticks',11),
               ('cpu_system_ticks',12),('rss_pages',21),('threads',17))}
    if any(value < 0 for value in values.values()):
        raise ValueError('negative')
    return {**values, 'label':label if label in LABELS else 'other',
            'state':parts[0].decode() if parts[0] in (b'R',b'S',b'D',b'Z',b'T',b't',b'X',b'x',b'K',b'W',b'P',b'I') else 'unknown'}


SERVICE_LABELS = frozenset(('cron.service', 'docker.service', 'containerd.service',
    'ssh.service', 'sshd.service', 'dropbear.service', 'tailscaled.service',
    'raspberry-mcp-collect.service', 'raspberry-procmon.service',
    'systemd-journald.service', 'systemd-udevd.service', 'dbus.service'))


def cgroup_identity(raw):
    # Never retain arbitrary cgroup paths or transient unit names.
    text = raw.decode('ascii', 'replace')
    container = re.search(r'(?:docker[-/])([a-f0-9]{64})(?:[./\n]|$)', text)
    services = re.findall(r'([^/\n:]+\.service)(?:/|$)', text, re.M)
    return {'service': next((s for s in services if s in SERVICE_LABELS), None),
            'container_id': container.group(1)[:12] if container else None,
            'attribution_error': None if container or any(s in SERVICE_LABELS for s in services) else 'not_allowlisted_or_unattributed'}


def collect(proc=Path('/proc'), read=limited_read, clock=time.monotonic, wall=time.time):
    started = clock()
    counts = {key:0 for key in ('enumerated','records','inaccessible','vanished','invalid','pid_reused','pid_limit','deadline')}
    pids = []
    with os.scandir(proc) as entries:
        for entry in entries:
            if entry.name.isascii() and entry.name.isdecimal():
                counts['enumerated'] += 1
                if len(pids) < MAX_PIDS:
                    pids.append(int(entry.name))
                else:
                    counts['pid_limit'] += 1
            if clock() - started > 2:
                counts['deadline'] = 1
                break
    stat_text = read(proc / 'stat', 131072)
    boot_time = int(re.search(rb'^btime ([0-9]+)$', stat_text, re.M).group(1))
    rows = []
    for pid in sorted(pids):
        if clock() - started > 2:
            counts['deadline'] = 1
            break
        try:
            # Open one proc directory: subsequent reads cannot switch to a reused PID.
            directory = os.open(proc / str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                prefix = Path('/proc/self/fd') / str(directory)
                first = parse_stat(read(prefix / 'stat', 8192))
                selected = {}
                for line in read(prefix / 'status', 65536).splitlines():
                    key, _, value = line.partition(b':')
                    if key in (b'Uid',b'Gid'):
                        values = [int(item) for item in value.split()]
                        if len(values) != 4 or any(x < 0 for x in values):
                            raise ValueError('identity_format')
                        selected[key] = values
                try:
                    attribution = cgroup_identity(read(prefix / 'cgroup', 8192))
                except (OSError, ValueError):
                    attribution = {'service': None, 'container_id': None, 'attribution_error': 'cgroup_unreadable'}
                last = parse_stat(read(prefix / 'stat', 8192))
                if first['start_ticks'] != last['start_ticks']:
                    counts['pid_reused'] += 1
                    continue
                rows.append({key:value for key,value in first.items() if key != 'rss_pages'} |
                            {'pid':pid,'uid':selected[b'Uid'][0],'euid':selected[b'Uid'][1],
                             'gid':selected[b'Gid'][0],'rss_bytes':first['rss_pages']*os.sysconf('SC_PAGE_SIZE'),
                             'started_at': round(boot_time + first['start_ticks']/os.sysconf('SC_CLK_TCK'), 3),
                             **attribution})
            finally:
                os.close(directory)
        except FileNotFoundError:
            counts['vanished'] += 1
        except PermissionError:
            counts['inaccessible'] += 1
        except (OSError,ValueError,IndexError,KeyError,UnicodeError):
            counts['invalid'] += 1
    counts['records'] = len(rows)
    boot = read(proc / 'sys/kernel/random/boot_id', 64).strip()
    if not re.fullmatch(rb'[a-f0-9-]{36}', boot):
        raise ValueError('boot_format')
    return {'schema':1,'observed_at':int(wall()),'monotonic':clock(),
            'boot':hashlib.sha256(boot).hexdigest()[:16],
            'clock_ticks':os.sysconf('SC_CLK_TCK'),'coverage':counts,'records':rows,
            'source':'proc_stat_status_cgroup','collection_error':None,
            'coverage_limits':['visible_pid_namespace_only','transients_between_samples_may_be_missed',
                               'uid_is_user_identity','service_names_allowlisted','rss_shared_pages_can_repeat']}


def encode(value, maximum):
    data = (json.dumps(value, separators=(',', ':'), allow_nan=False)+'\n').encode()
    if len(data) > maximum:
        raise ValueError('output_limit')
    return data


def atomic(path, value, maximum=MAX_SAMPLE, mode=0o600):
    data = encode(value, maximum)
    temporary = path.with_name(path.name+'.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),mode)
            stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
        directory=os.open(path.parent,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def preserve_interrupted(state):
    """Under the collector lock, archive only its own unfinished atomic writes.

    Never promote old/partial JSON to an observation, overwrite an archive, or
    delete evidence to make room. Capacity exhaustion needs explicit maintenance.
    """
    candidates = []
    for directory, pattern, mode, limit in (
        (state/'history', HISTORY_NAME, 0o600, MAX_SAMPLE),
        (state/'hours', HOUR_NAME, 0o600, 4096),
        (state, re.compile(r'last\.json'), 0o600, MAX_SAMPLE),
        (state/'public', re.compile(r'(?:snapshot|health)\.json'), 0o640, 65536),
    ):
        with os.scandir(directory) as entries:
            for count, item in enumerate(entries):
                if count >= 2100:
                    raise ValueError('interrupted_scan_limit')
                if not item.name.endswith('.tmp') or not pattern.fullmatch(item.name[:-4]):
                    continue
                info = item.stat(follow_symlinks=False)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1
                    or info.st_size > limit):
                    raise ValueError('unsafe_interrupted_sample')
                path = directory/item.name
                digest = hashlib.sha256(limited_read(path, limit)).hexdigest()
                section = 'state' if directory == state else directory.name
                name = f'{section}--{item.name[:-4]}--{digest}.tmp'
                candidates.append((path, info, name, digest))
                if len(candidates) > INTERRUPTED_COUNT:
                    raise ValueError('interrupted_archive_full')
    if not candidates:
        return []
    archive = state/'interrupted'
    try:
        archive.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = archive.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('unsafe_interrupted_archive')
    size = count = 0
    with os.scandir(archive) as entries:
        for item in entries:
            info = item.stat(follow_symlinks=False)
            if (not INTERRUPTED_NAME.fullmatch(item.name) or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_size > MAX_SAMPLE):
                raise ValueError('unsafe_interrupted_archive')
            size += info.st_size; count += 1
            if count > INTERRUPTED_COUNT or size > INTERRUPTED_CAP:
                raise ValueError('interrupted_archive_full')
    if count+len(candidates) > INTERRUPTED_COUNT or size+sum(row[1].st_size for row in candidates) > INTERRUPTED_CAP:
        raise ValueError('interrupted_archive_full')
    # Validate all destinations and identities before moving the first item.
    for path, info, name, digest in candidates:
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise ValueError('interrupted_sample_changed')
        if os.path.lexists(archive/name):
            raise ValueError('interrupted_archive_conflict')
    evidence = []
    for path, info, name, digest in candidates:
        os.rename(path, archive/name)
        for directory in (archive, path.parent):
            fd = os.open(directory, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        row = {'collection':'interrupted_sample_preserved','source':str(path.relative_to(state)),
               'sha256':digest,'bytes':info.st_size,'promoted_to_observation':False}
        sys.stderr.write(json.dumps(row)+'\n')
        evidence.append(row)
    return evidence


def prune(directory, now, age, cap, reserved=0, pattern=HISTORY_NAME):
    entries = []
    with os.scandir(directory) as files:
        for item in files:
            if len(entries) >= 2000:
                raise ValueError('unexpected_file_count')
            if not pattern.fullmatch(item.name):
                raise ValueError('unexpected_history_entry')
            info=item.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('unsafe_history')
            entries.append((info.st_mtime,item.name,info.st_size))
    if reserved > cap:
        raise ValueError('reservation_exceeds_budget')
    if any(row[0] > now+5 for row in entries):
        raise ValueError('clock_rollback')
    total=sum(row[2] for row in entries)
    for modified,name,size in sorted(entries):
        if modified > now+5:
            raise ValueError('clock_rollback')
        if now-modified >= age or total+reserved > cap:
            (directory/name).unlink();total-=size
    if total+reserved > cap:
        raise ValueError('storage_budget')


def summarize(sample, previous):
    now=sample['observed_at'];elapsed=sample['monotonic']-(previous or {}).get('monotonic',sample['monotonic'])
    comparable=bool(previous and previous.get('boot')==sample['boot'] and 0<elapsed<=180)
    prior={(r['pid'],r['start_ticks']):r for r in (previous or {}).get('records',[])} if comparable else {}
    rows=[]
    for record in sample['records']:
        row=dict(record);old=prior.get((row['pid'],row['start_ticks']))
        delta=sum(row[k]-old[k] for k in ('cpu_user_ticks','cpu_system_ticks')) if old else -1
        row['cpu_percent_one_core']=round(100*delta/sample['clock_ticks']/elapsed,2) if delta>=0 and comparable else None
        rows.append(row)
    cpu=[r['cpu_percent_one_core'] for r in rows if r['cpu_percent_one_core'] is not None]
    return {'schema':1,'source':sample.get('source','proc_metadata'),'observed_at':now,
            'age_seconds':0,'collection_error':None,'coverage_limits':sample.get('coverage_limits',[]),
            'boot':sample['boot'],'coverage':sample['coverage'],
            'cpu_delta_available':comparable,'sum_rss_bytes':sum(r['rss_bytes'] for r in rows),
            'sum_cpu_percent_one_core':round(sum(cpu),2) if cpu else None,
            'top_memory':sorted(rows,key=lambda r:(-r['rss_bytes'],r['pid']))[:20],
            'top_cpu':sorted(rows,key=lambda r:(-(r['cpu_percent_one_core'] or 0),r['pid']))[:20]}


def cycle(state=STATE, sampler=collect, wall=time.time):
    state=Path(state)
    for directory in (state,state/'history',state/'hours',state/'public'):
        info=directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid():
            raise ValueError('unsafe_state')
    lock=os.open(state/'lock',os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
        disk=os.statvfs(state)
        if disk.f_bavail*disk.f_frsize < 2*1024**3 or (disk.f_blocks-disk.f_bavail)/max(1,disk.f_blocks) > 0.85:
            raise ValueError('disk_pressure')
        preserve_interrupted(state)
        previous=None
        try:previous=json.loads(limited_read(state/'last.json',MAX_SAMPLE))
        except FileNotFoundError:pass
        sample=sampler();now=sample['observed_at']
        if previous and now < previous['observed_at']:
            raise ValueError('clock_rollback')
        raw_size=len(encode(sample,MAX_SAMPLE))
        summary=summarize(sample,previous)
        prune(state/'history',now,86400,HISTORY_CAP,raw_size)
        prune(state/'hours',now,7*86400,AGGREGATE_CAP,4096,HOUR_NAME)
        name=f"{now:020d}-{sample['boot']}.json"
        if os.path.lexists(state/'history'/name):
            raise ValueError('duplicate_sample_no_retry')
        hour=state/'hours'/f'{now//3600:012d}.json'
        try:aggregate=json.loads(limited_read(hour,4096))
        except FileNotFoundError:aggregate={'hour':now//3600,'samples':0,'max_processes':0,'max_sum_rss_bytes':0,'partial_samples':0}
        aggregate['samples']+=1
        aggregate['max_processes']=max(aggregate['max_processes'],len(sample['records']))
        aggregate['max_sum_rss_bytes']=max(aggregate['max_sum_rss_bytes'],summary['sum_rss_bytes'])
        aggregate['partial_samples']+=int(any(sample['coverage'][k] for k in ('inaccessible','vanished','invalid','pid_reused','pid_limit','deadline')))
        atomic(state/'history'/name,sample)
        atomic(hour,aggregate,4096)
        atomic(state/'last.json',sample)
        # Publish only after durable history. Failed/incomplete cycles leave the old snapshot stale.
        atomic(state/'public/snapshot.json',summary,65536,0o640)
        return {'collection':'completed','records':len(sample['records'])}
    finally:os.close(lock)


def apply_limits():
    for item,value in ((resource.RLIMIT_AS,AS_LIMIT),(resource.RLIMIT_CPU,2),
                       (resource.RLIMIT_FSIZE,MAX_SAMPLE),(resource.RLIMIT_NOFILE,32)):
        current=resource.getrlimit(item)[1]
        limit=min(value,current) if current!=resource.RLIM_INFINITY else value
        resource.setrlimit(item,(limit,limit))
    # Let finally blocks close/unlink this invocation's temporary files. SIGKILL
    # or power loss can still leave a file; the next cycle preserves it first.
    def interrupted(signum, frame):
        raise TimeoutError('collection_interrupted')
    signal.signal(signal.SIGALRM,interrupted)
    signal.signal(signal.SIGTERM,interrupted)
    signal.alarm(5)


def run_once(state=STATE, sampler=collect):
    state = Path(state)
    for directory in (state, state/'history', state/'hours', state/'public'):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError('unsafe_state')
    try:
        result = cycle(state, sampler=sampler)
    except Exception:
        atomic(state/'public/health.json', {'schema':1,'status':'failed','observed_at':int(time.time()),
               'reason':'collection_failed','service_state':'unknown'},4096,0o640)
        raise
    atomic(state/'public/health.json', {'schema':1,'status':'completed','observed_at':int(time.time()),
           'service_state':'unknown'},4096,0o640)
    return result


def main():
    if len(sys.argv)!=1 or os.geteuid()==0:
        raise ValueError('fixed_unprivileged_entrypoint_required')
    apply_limits()
    try:
        run_once()
    except Exception:
        # No exception messages, process data or input are logged.
        sys.stderr.write('{"collection":"failed","automatic_retry":false}\n')
        return 1
    return 0


if __name__=='__main__':
    sys.exit(main())
