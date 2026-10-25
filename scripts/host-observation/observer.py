"""Fixed read-only host facts. No commands, credentials, repairs or public listener."""
import collections
import datetime
import hashlib
import http.client
import json
import os
from pathlib import Path
import resource
import socket
import stat
import subprocess
import threading
import time
import urllib.parse

DESTINATION = Path('/mnt/data/docker/nodered/.host-health-observer')
SERVICES = frozenset(('homeassistant', 'nodered', 'mosquitto', 'portainer',
    'appdaemon', 'matter_server', 'zigbee2mqtt', 'ai-bridge',
    'docs-review-scheduler', 'kia-uvo-codex-merge'))
UNITS = {'docker.service': 'docker', 'raspberry-procmon.service': 'procmon',
    'raspberry-mcp-collect.service': 'mcp_collection',
    'raspberry-host-heartbeat.service': 'external_heartbeat',
    'raspberry-mcp-events.service': 'events',
    'raspberry-ha-notices.service': 'ha_notices',
    'raspberry-host-observation.service': 'host_observation'}
JOBS = {'39f53479d3a045ac8e11786248231fbf': 'started',
    '9d1aaa27d60140bd96365438aad20286': 'stopped',
    'be02cf6855d2428ba40df7e9d022f03d': 'failed'}
DOCKER_ACTIONS = frozenset(('start', 'die', 'restart', 'destroy',
    'health_status: healthy', 'health_status: unhealthy', 'health_status: starting'))


def iso(value=None):
    return datetime.datetime.fromtimestamp(time.time() if value is None else value,
        datetime.timezone.utc).isoformat(timespec='milliseconds')


def docker_event(value, now):
    if not isinstance(value, dict) or value.get('Type') != 'container':
        return None
    actor = value.get('Actor')
    if not isinstance(actor, dict) or not isinstance(actor.get('Attributes'), dict):
        return None
    attrs = actor['Attributes']
    service, action, nano = attrs.get('com.docker.compose.service'), value.get('Action'), value.get('timeNano')
    if (attrs.get('com.docker.compose.project') != 'docker' or service not in SERVICES
            or action not in DOCKER_ACTIONS or type(nano) is not int or nano <= 0):
        return None
    occurred = nano / 1_000_000_000
    if occurred > now + 1 or now - occurred > 60:
        raise ValueError('source_clock_or_replay_window')
    identity = hashlib.sha256(json.dumps(['docker', actor.get('ID'), service,
        action, nano], separators=(',', ':')).encode()).hexdigest()
    return {'id': identity, 'source': 'docker', 'service': service,
        'action': action, 'occurred_at': iso(occurred), 'observed_at': iso(now),
        'source_to_observer_ms': round(max(0, now - occurred) * 1000, 3)}


def journal_event(value, now):
    if not isinstance(value, dict):
        return None
    service, action = UNITS.get(value.get('UNIT')), JOBS.get(value.get('MESSAGE_ID'))
    if not service or not action:
        return None
    try:
        occurred = int(value['__REALTIME_TIMESTAMP']) / 1_000_000
    except (KeyError, TypeError, ValueError):
        raise ValueError('missing_source_time') from None
    if occurred > now + 1 or now - occurred > 60:
        raise ValueError('source_clock_or_replay_window')
    identity = hashlib.sha256(json.dumps(['systemd', value.get('__CURSOR'), service,
        action, value['__REALTIME_TIMESTAMP']], separators=(',', ':')).encode()).hexdigest()
    return {'id': identity, 'source': 'systemd', 'service': service, 'action': action,
        'occurred_at': iso(occurred), 'observed_at': iso(now),
        'source_to_observer_ms': round(max(0, now - occurred) * 1000, 3)}


def resource_sample(previous=None):
    errors, data = [], {}
    def read(label, fn):
        try:
            data[label] = fn()
        except (OSError, ValueError, KeyError, ZeroDivisionError, StopIteration, OverflowError):
            data[label] = None
            errors.append(label)
    read('memory_available_bytes', lambda: int(next(line.split()[1] for line in
        Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) * 1024)
    read('memory_total_bytes', lambda: int(next(line.split()[1] for line in
        Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) * 1024)
    read('disk_used_percent', lambda: round(100 * (1 - os.statvfs('/').f_bavail / os.statvfs('/').f_blocks), 3))
    read('inodes_used_percent', lambda: round(100 * (1 - os.statvfs('/').f_favail / os.statvfs('/').f_files), 3))
    read('temperature_celsius', lambda: int(Path('/sys/class/thermal/thermal_zone0/temp').read_text()) / 1000)
    read('oom_kill_count', lambda: int(next(line.split()[1] for line in
        Path('/proc/vmstat').read_text().splitlines() if line.startswith('oom_kill '))))
    read('cpu_ticks', lambda: [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]])
    ticks = data.pop('cpu_ticks')
    data['cpu_busy_percent'] = None
    if ticks and previous and len(previous) == len(ticks):
        delta = [a - b for a, b in zip(ticks, previous)]
        if min(delta) >= 0 and sum(delta) > 0:
            data['cpu_busy_percent'] = round(100 * (1 - (delta[3] + delta[4]) / sum(delta)), 3)
    return {'observed_at': iso(), 'data': data, 'collection_errors': errors}, ticks


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=3)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/run/docker.sock')


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.events = collections.deque(maxlen=64)
        self.seen = collections.deque(maxlen=256)
        self.sources = {key: {'state': 'unknown', 'collection_error': 'starting'} for key in ('docker', 'systemd')}
        self.sequence, self.dropped, self.generation = 0, 0, 0

    def health(self, source, state, error=None):
        with self.lock:
            value = {'state': state, 'collection_error': error}
            if self.sources[source] != value:
                self.sources[source] = value
                self.generation += 1

    def add(self, event):
        if event is None:
            return
        with self.lock:
            if event['id'] in self.seen:
                return
            self.seen.append(event['id'])
            self.sequence += 1
            if len(self.events) == self.events.maxlen:
                self.dropped += 1
            self.events.append({**event, 'sequence': self.sequence})
            self.generation += 1


def docker_watch(state):
    filters = urllib.parse.quote(json.dumps({'type': ['container'],
        'label': ['com.docker.compose.project=docker']}), safe='')
    while True:
        connection = DockerConnection()
        try:
            connection.request('GET', '/events?since=' + str(int(time.time()) - 2) + '&filters=' + filters)
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError('docker_response')
            connection.sock.settimeout(None)
            state.health('docker', 'connected')
            while True:
                line = response.readline(65537)
                if not line or len(line) > 65536:
                    raise ValueError('docker_stream')
                state.add(docker_event(json.loads(line), time.time()))
        except Exception:
            state.health('docker', 'unknown', 'stream_unavailable_or_invalid')
        finally:
            connection.close()
        time.sleep(3)


def journal_watch(state):
    command = ['/usr/bin/prlimit', '--as=536870912', '/usr/bin/journalctl',
        '--follow', '--no-pager', '--output=json', '--since=now', '_PID=1',
        '--output-fields=__REALTIME_TIMESTAMP,__CURSOR,UNIT,MESSAGE_ID']
    while True:
        child = None
        try:
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            state.health('systemd', 'connected')
            while True:
                line = child.stdout.readline(8193)
                if not line or len(line) > 8192:
                    raise ValueError('journal_stream')
                state.add(journal_event(json.loads(line), time.time()))
        except Exception:
            state.health('systemd', 'unknown', 'stream_unavailable_or_invalid')
        finally:
            if child is not None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
                child.stdout.close()
        time.sleep(3)


def atomic_report(directory, value):
    raw = (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode()
    if len(raw) > 65536:
        raise ValueError('report_limit')
    fd = os.open('report.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
        0o644, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0:
            raise ValueError('unsafe_report')
        os.fchmod(fd, 0o644)
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename('report.json.tmp', 'report.json', src_dir_fd=directory, dst_dir_fd=directory)
    os.fsync(directory)
    return len(raw)


def main():
    if os.geteuid() != 0:
        raise ValueError('fixed_root_service_required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1048576, 512 * 1048576))
    directory = os.open(DESTINATION, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(directory)
    if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
        raise ValueError('unsafe_report_directory')
    boot = hashlib.sha256(Path('/proc/sys/kernel/random/boot_id').read_bytes()).hexdigest()
    state, previous, metrics, total_bytes = State(), None, None, 0
    instance = hashlib.sha256(os.urandom(32)).hexdigest()
    for function in (docker_watch, journal_watch):
        threading.Thread(target=function, args=(state,), daemon=True).start()
    last_sample, last_write, generation = 0, 0, -1
    while True:
        monotonic = time.monotonic()
        if monotonic - last_sample >= 20:
            metrics, previous = resource_sample(previous)
            last_sample = monotonic
        with state.lock:
            changed = generation != state.generation
            if monotonic - last_write >= 10 or changed and monotonic - last_write >= .25:
                report = {'schema_version': 1, 'source': 'fixed_readonly_host_observer',
                    'observed_at': iso(), 'boot_id_sha256': boot, 'instance_id': instance,
                    'sequence': state.sequence, 'evicted_event_records': state.dropped,
                    'sources': dict(state.sources), 'events': list(state.events),
                    'resources': metrics, 'bytes_written_before_report': total_bytes,
                    'producer_cost': {'self_cpu_seconds': round(resource.getrusage(resource.RUSAGE_SELF).ru_utime +
                        resource.getrusage(resource.RUSAGE_SELF).ru_stime, 6),
                        'self_peak_rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                        'scope': 'producer_self_only_not_journal_child_or_24h'},
                    'full_latency_acceptance': False, 'assistant_execution_proven': False,
                    'coverage': ['allowlisted_project_container_transitions',
                        'allowlisted_system_manager_unit_transitions', 'host_resource_samples',
                        'no_private_messages_logs_or_credentials', 'no_repairs_or_notifications',
                        'ring_not_a_durable_event_archive', 'no_PC_off_or_24h_acceptance']}
                generation = state.generation
            else:
                report = None
        if report is not None:
            total_bytes += atomic_report(directory, report)
            last_write = monotonic
        time.sleep(.1)


if __name__ == '__main__':
    main()
