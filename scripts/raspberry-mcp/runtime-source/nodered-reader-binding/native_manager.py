"""UNINSTALLED fixed native adapter. Importing never runs a command or writes.

Only Controller is intended to call this adapter, under the protected Store.
The proposed authority follows the fixed Compose service, listener and network;
container/image changes require a new preview, never reuse an old operation.
No request field selects binaries, arguments, paths, addresses or identities.
The runtime systemd write requires a separately reviewed deployment approval.
"""
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import selectors
import socket
import stat
import subprocess
import time

UNIT = 'raspberry-nodered-diagnostics.service'
FRAGMENT = '/etc/systemd/system/' + UNIT
DROPIN = '/run/systemd/system.control/' + UNIT + '.d/50-IPAddressAllow.conf'
SIDECAR = '/usr/local/lib/raspberry-nodered-diagnostics/sidecar.cjs'
SNAPSHOT = '/usr/local/lib/raspberry-nodered-diagnostics/root_snapshot.py'
SYSTEMCTL = '/usr/bin/systemctl'
WAIT_SECONDS = 30
WAIT_MAX_POLLS = 16
DOCKER_SOCKET = '/run/raspberry-nodered-binding-inputs/docker.sock'
DOCKER_REQUEST = b'GET /containers/nodered/json HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n'
COMPOSE_LABELS = {'com.docker.compose.project': 'docker',
    'com.docker.compose.service': 'nodered',
    'com.docker.compose.project.working_dir': '/mnt/data/docker',
    'com.docker.compose.project.config_files': '/mnt/data/docker/docker-compose.yml'}
PROPERTIES = ('FragmentPath', 'DropInPaths', 'ActiveState', 'MainPID',
              'IPAddressAllow', 'IPAddressDeny', 'LoadState', 'Transient')


class Refused(ValueError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def root_file(path, maximum=65536, executable=False):
    """Read only metadata/code, pinned by no-follow root-owned ancestors."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = Path(path).parts
        need(parts[0] == '/' and '..' not in parts, 'fixed_absolute_file_required')
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            s = os.fstat(fd)
            need(s.st_uid == s.st_gid == 0 and not s.st_mode & 0o022,
                 'root_file_ancestor_changed')
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    try:
        s = os.fstat(child)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == s.st_gid == 0
             and stat.S_IMODE(s.st_mode) == (0o755 if executable else 0o644)
             and 0 < s.st_size <= maximum, 'root_file_identity_changed')
        digest = hashlib.sha256()
        raw = bytearray()
        count = 0
        while count <= maximum:
            chunk = os.read(child, min(1048576, maximum + 1 - count))
            if not chunk:
                break
            digest.update(chunk)
            count += len(chunk)
            if not executable:
                raw.extend(chunk)
        after = os.fstat(child)
        fields = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        need(fields(s) == fields(after) and count == s.st_size, 'root_file_changed_during_read')
        return digest.hexdigest(), bytes(raw), fields(s)
    finally:
        os.close(child)


class PinnedRunner:
    """No shell; bounded stdout; no inherited credentials/configuration env.

    This helper is internal. Its caller constructs the two fixed command
    shapes below; it is never exposed as an RPC or arbitrary command service.
    """
    def __init__(self, hashes):
        need(set(hashes) == {SYSTEMCTL}, 'fixed_native_binaries_required')
        self.hashes = dict(hashes)
        self.identities = {}

    def run(self, argv, *, read_deadline_seconds=2):
        need(type(argv) is list and all(type(x) is str for x in argv), 'fixed_native_argv_required')
        allowed = argv == [SYSTEMCTL, '--no-pager', 'show', UNIT,
                           *['--property=' + p for p in PROPERTIES]]
        need(type(read_deadline_seconds) in (int, float) and math.isfinite(read_deadline_seconds)
             and 0 < read_deadline_seconds <= 2, 'native_read_deadline_refused')
        is_show = allowed
        if argv[:5] == [SYSTEMCTL, '--no-ask-password', '--runtime', 'set-property', UNIT]:
            # One message: clear previous prefixes, then ONLY four canonical
            # reviewed/derived entries. The manager independently checks scope.
            need(len(argv) == 10 and argv[5] == 'IPAddressAllow=', 'fixed_property_write_required')
            values = [v.removeprefix('IPAddressAllow=') for v in argv[6:]]
            need(all(v.startswith('IPAddressAllow=') for v in argv[6:]) and
                 all(str(ipaddress.ip_network(v, strict=True)) == v for v in values),
                 'canonical_network_values_required')
            allowed = True
        need(allowed, 'native_command_scope_refused')
        need(is_show or read_deadline_seconds == 2, 'native_write_deadline_override_refused')
        binary = argv[0]
        cached = self.identities.get(binary)
        if cached is None:
            digest, _, identity = root_file(binary, maximum=134217728, executable=True)
            need(digest == self.hashes[binary], 'native_binary_hash_changed')
            self.identities[binary] = identity
        else:
            s = os.stat(binary, follow_symlinks=False)
            need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) == cached,
                 'native_binary_identity_changed')
        # Pin the verified inode across exec; a path swap cannot replace it.
        fd = os.open(binary, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            s = os.fstat(fd)
            need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) == self.identities[binary],
                 'native_binary_identity_changed')
            with subprocess.Popen(argv, executable='/proc/self/fd/' + str(fd), pass_fds=(fd,),
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, close_fds=True,
                                  env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                                  start_new_session=True) as process:
                raw = bytearray()
                deadline = time.monotonic() + (read_deadline_seconds if is_show else 4)
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        while True:
                            remaining = deadline - time.monotonic()
                            need(remaining > 0, 'native_command_deadline_outcome_unconfirmed')
                            events = selector.select(remaining)
                            need(events, 'native_command_deadline_outcome_unconfirmed')
                            chunk = os.read(process.stdout.fileno(), 4096)
                            if not chunk:
                                break
                            raw.extend(chunk)
                            need(len(raw) <= 32768, 'native_command_output_limit')
                    returncode = process.wait(timeout=max(.001, deadline - time.monotonic()))
                    need(returncode == 0, 'native_command_result_unconfirmed')
                except BaseException:
                    # Kill only our CLI child. This neither cancels nor retries
                    # a systemd operation; Controller retains outcome_unknown.
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
                    raise
        finally:
            os.close(fd)
        return bytes(raw).decode('utf-8', errors='strict')

    def inspect_container(self):
        return container_metadata()


def container_metadata(socket_factory=None):
    """One literal GET; no URL, method, socket or host supplied by an RPC.

    The private alias must be explicitly approved/mounted during deployment.
    A read-only bind of a Unix socket does NOT restrict Docker API methods;
    the sealed code is the method/path boundary. Never claim kernel API ACLs.
    """
    factory = socket.socket if socket_factory is None else socket_factory
    raw = bytearray()
    deadline = time.monotonic() + 2
    with factory(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(2)
        peer.connect(DOCKER_SOCKET)
        peer.sendall(DOCKER_REQUEST)
        peer.setblocking(False)
        with selectors.DefaultSelector() as selector:
            selector.register(peer, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                need(remaining > 0, 'fixed_Docker_metadata_deadline')
                need(selector.select(remaining), 'fixed_Docker_metadata_deadline')
                part = peer.recv(8192)
                if not part:
                    break
                raw.extend(part)
                need(len(raw) <= 262144, 'fixed_Docker_metadata_size_limit')
    header, sep, body = bytes(raw).partition(b'\r\n\r\n')
    need(sep and len(header) <= 8192, 'fixed_Docker_response_unconfirmed')
    lines = header.split(b'\r\n')
    status = lines[0].split(b' ', 2)
    need(len(status) >= 2 and status[:2] in ([b'HTTP/1.0', b'200'], [b'HTTP/1.1', b'200']),
         'fixed_Docker_response_not_success')
    headers = {}
    for line in lines[1:]:
        key, colon, val = line.partition(b':')
        key = key.strip().lower()
        need(colon and key not in headers, 'fixed_Docker_response_header_refused')
        headers[key] = val.strip()
    need(b'transfer-encoding' not in headers, 'fixed_Docker_transfer_framing_refused')
    length = headers.get(b'content-length')
    need(length is None or length.isdigit() and int(length) == len(body),
         'fixed_Docker_response_length_unconfirmed')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'duplicate_Docker_metadata_key')
            result[key] = value
        return result
    value = json.loads(body, object_pairs_hook=unique)
    need(type(value) is dict and type(value.get('State')) is dict and
         type(value.get('NetworkSettings')) is dict, 'fixed_Docker_metadata_schema_refused')
    networks = value['NetworkSettings'].get('Networks')
    need(type(networks) is dict and set(networks) == {'docker_default'} and
         type(networks['docker_default']) is dict, 'fixed_container_network_changed')
    network = networks['docker_default']
    config = value.get('Config')
    labels = config.get('Labels') if type(config) is dict else None
    logical = value.get('Name') == '/nodered' and type(labels) is dict and \
        all(labels.get(k) == wanted for k, wanted in COMPOSE_LABELS.items())
    ports = value['NetworkSettings'].get('Ports')
    bindings = ports.get('1880/tcp') if type(ports) is dict else None
    bindings = ([{'host_ip': v.get('HostIp'), 'host_port': v.get('HostPort')}
                 for v in bindings if type(v) is dict]
                if type(bindings) is list and len(bindings) <= 4 else None)
    # All remaining response fields, including Config/Env, are discarded and
    # are never logged, persisted, returned by the manager or exported to MCP.
    return {'container_id': value.get('Id'), 'image_id': value.get('Image'),
            'running': value['State'].get('Running'),
            'network_id': network.get('NetworkID'), 'peer_ipv4': network.get('IPAddress'),
            'compose_service_verified': logical, 'published_bindings': bindings}


def canonical(values):
    need(type(values) is list and len(values) == 4 and len(set(values)) == 4,
         'four_fixed_network_entries_required')
    result = sorted(str(ipaddress.ip_network(v, strict=True)) for v in values)
    need(set(result) >= {'127.0.0.0/8', '::1/128'}, 'loopback_entries_required')
    return result


def property_values(raw):
    lines = raw.strip().splitlines()
    result = {}
    for line in lines:
        need('=' in line, 'unit_properties_unconfirmed')
        key, value = line.split('=', 1)
        need(key in PROPERTIES and key not in result, 'unit_properties_unconfirmed')
        result[key] = value
    need(set(result) == set(PROPERTIES), 'unit_properties_unconfirmed')
    return result


def validate_dropin(raw, allowed):
    lines = [line.strip() for line in raw.decode('utf-8').splitlines()
             if line.strip() and not line.startswith('#')]
    need(lines[:2] == ['[Service]', 'IPAddressAllow='] and len(lines) == 6,
         'foreign_unit_dropin_refused')
    need(all(line.startswith('IPAddressAllow=') for line in lines[2:]),
         'foreign_unit_dropin_refused')
    need(canonical([v.split('=', 1)[1] for v in lines[2:]]) == allowed,
         'runtime_dropin_and_manager_disagree')


class Manager:
    def __init__(self, policy, runner, store, dependency_hashes, reader=root_file):
        need(set(dependency_hashes) == {SIDECAR, SNAPSHOT}, 'fixed_reader_dependencies_required')
        self.policy = dict(policy)
        self.runner = runner
        self.store = store
        self.dependencies = dict(dependency_hashes)
        self.reader = reader

    def wait_inactive(self):
        """Observe only the fixed unit; never stop, restart or change it."""
        self.store.assert_locked()
        deadline = time.monotonic() + WAIT_SECONDS
        for attempt in range(WAIT_MAX_POLLS):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            started = time.monotonic()
            props = property_values(self.runner.run([SYSTEMCTL, '--no-pager', 'show', UNIT,
                                                     *['--property=' + p for p in PROPERTIES]],
                                                    read_deadline_seconds=min(2, remaining)))
            if time.monotonic() > deadline:
                break
            if props['ActiveState'] == 'inactive' and props['MainPID'] == '0':
                return
            if attempt < WAIT_MAX_POLLS - 1:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(max(0, min(2 - (time.monotonic() - started), remaining - 0.5)))
        raise Refused('reader_active_no_effect_performed')

    def headroom(self):
        try:
            memory = Path('/proc/meminfo').read_text()
            available = next(int(line.split()[1]) for line in memory.splitlines()
                             if line.startswith('MemAvailable:'))
            disk = os.statvfs('/run/raspberry-storage-inputs/metrics')
            used = 1 - disk.f_bavail / disk.f_blocks
            return available >= 2097152 and used < .85 and os.getloadavg()[0] <= (os.cpu_count() or 1)
        except (OSError, ValueError, StopIteration, ZeroDivisionError):
            return False

    def inspect(self):
        for path, expected in self.dependencies.items():
            need(self.reader(path)[0] == expected, 'reader_dependency_hash_changed')
        digest, _, _ = self.reader(FRAGMENT)
        need(digest in self.policy['unit_hashes'], 'reader_unit_hash_changed')
        container = self.runner.inspect_container()
        need(type(container) is dict and set(container) == {'container_id', 'image_id',
             'running', 'network_id', 'peer_ipv4', 'compose_service_verified', 'published_bindings'} and all(type(container[k]) is str for k in
             ('container_id', 'image_id', 'network_id', 'peer_ipv4')) and
             type(container['running']) is bool, 'fixed_container_metadata_unconfirmed')
        listeners = [ipaddress.ip_network(v, strict=True) for v in self.policy['base_allow']
                     if ipaddress.ip_network(v).version == 4 and ipaddress.ip_network(v).prefixlen == 32]
        need(len(listeners) == 1, 'fixed_existing_listener_required')
        logical = container['compose_service_verified'] is True and container['published_bindings'] == \
            [{'host_ip': str(listeners[0].network_address), 'host_port': '1880'}]
        props = property_values(self.runner.run([SYSTEMCTL, '--no-pager', 'show', UNIT,
                                                *['--property=' + p for p in PROPERTIES]]))
        need(props['FragmentPath'] == FRAGMENT and props['LoadState'] == 'loaded' and
             props['Transient'] == 'no' and props['IPAddressDeny'].split() == ['0.0.0.0/0', '::/0'],
             'fixed_reader_effective_unit_changed')
        allowed = canonical(props['IPAddressAllow'].split())
        dropins = props['DropInPaths'].split()
        need(dropins in ([], [DROPIN]), 'foreign_unit_dropin_refused')
        if dropins:
            validate_dropin(self.reader(DROPIN, maximum=4096)[1], allowed)
        if props['ActiveState'] == 'inactive':
            need(props['MainPID'] == '0', 'reader_inactive_state_unconfirmed')
        return {'container_id': container['container_id'], 'image_id': container['image_id'].removeprefix('sha256:'),
                'network_id': container['network_id'], 'network_name': 'docker_default',
                'peer_ipv4': container['peer_ipv4'], 'running': container['running'],
                'unit_sha256': digest, 'unit_active': props['ActiveState'],
                'deny_all': True, 'allowed': allowed, 'logical_service_verified': logical}

    def set_allow(self, expected, wanted):
        self.store.assert_locked()
        need(not self.store.revoked() and self.headroom(), 'binding_write_admission_closed')
        expected, wanted = canonical(expected), canonical(wanted)
        value = self.inspect()
        for key in ('network_id', 'network_name'):
            need(value[key] == self.policy[key], 'identity_changed_specific_owner_review_required')
        need(value['logical_service_verified'] and value['running'] and value['unit_active'] == 'inactive' and
             value['allowed'] == expected, 'binding_final_compare_conflict')
        base = set(self.policy['base_allow'])
        need(base <= set(expected) and base <= set(wanted) and
             len(set(expected) - base) == len(set(wanted) - base) == 1,
             'only_reviewed_peer_may_change')
        # The durable intent is the sole authority for a derived peer or own
        # restoration. A direct adapter call cannot select another allow-list.
        pending = [v for v in self.store.history() if v['state'] in ('apply_intent', 'restore_intent')]
        need(len(pending) == 1, 'single_durable_binding_intent_required')
        intent = pending[0]
        need({k: value[k] for k in ('container_id', 'image_id')} == intent['instance'],
             'instance_changed_since_preview')
        restoring = intent['state'] == 'restore_intent'
        expected_unit = intent['restore_previews'][-1]['unit_sha256'] if restoring else intent['unit_sha256']
        need(expected == intent['after' if restoring else 'before'] and
             wanted == intent['before' if restoring else 'after'] and
             value['peer_ipv4'] == intent['after_peer'] and value['unit_sha256'] == expected_unit,
             'binding_write_does_not_match_intent')
        peer = ipaddress.IPv4Network(next(iter(set(wanted) - base)), strict=True)
        need(peer.prefixlen == 32 and peer.network_address in
             ipaddress.IPv4Network(self.policy['subnet']), 'derived_single_peer_required')
        self.store.assert_locked()
        self.runner.run([SYSTEMCTL, '--no-ask-password', '--runtime', 'set-property', UNIT,
                         'IPAddressAllow=', *['IPAddressAllow=' + v for v in wanted]])
