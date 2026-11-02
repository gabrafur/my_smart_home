"""Uninstalled inline Root guard. Never decrypts credentials or reads context values.

Only RootCoordinator may construct this class from its hash-verified source, in
its own process and while retaining all five fixed flock descriptors. No daemon,
Docker API, shell, caller-selected path/URL or runtime API is used. Injection is
an in-process synthetic-test seam, not an MCP argument or installation option.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import types
import builtins
import ipaddress
import secrets

ROOT = Path('/usr/local/lib/raspberry-nodered-admin')
STATE = Path('/var/lib/raspberry-nodered-admin')
ATTESTATIONS = STATE / 'attestations'
ACTIVATION = ROOT / 'native-runtime-activation.json'
REVIEW = ROOT / 'core-preservation-review.json'
EVIDENCE = ROOT / 'core-preservation-evidence.json'
SOURCE = ROOT / 'native_guard.py'
EXISTING_SOURCES = {name: Path('/usr/local/lib/raspberry-component-repair') / name
                    for name in ('admission.py', 'executor_observer.py')}
LOCKS = ('/tmp/my-smart-home-public-validation.lock',
         '/mnt/data/docker/.daily-maintenance.lock',
         '/var/lib/raspberry-mcp-operations/lock',
         '/var/lib/raspberry-admin-executor/executor.lock',
         '/var/lib/raspberry-mcp-operations/task-control/coordinator.lock')
CORE = '/usr/src/node-red/node_modules/@node-red/runtime/lib/'
CORE_FILES = (CORE + 'nodes/credentials.js', CORE + 'flows/util.js',
              CORE + 'nodes/context/index.js')
RUNTIME_FILES = CORE_FILES + ('/data/settings.js', '/data/flows_cred.json')
LEDGERS = {
 'task': '/var/lib/raspberry-mcp-operations/task-control/jobs.sqlite3',
 'legacy': '/var/lib/raspberry-mcp-operations/codex-control/jobs.sqlite3',
 'component_jobs': '/var/lib/raspberry-component-repair/jobs.sqlite3',
 'component_workflow': '/var/lib/raspberry-component-repair/workflow.sqlite3',
}
SCHEMAS = {
 'task': {'tasks': 'id task_key spec_hash thread state created updated reconciled',
          'sends': 'id task input_hash state turn created updated result reconciled',
          'audit': 'seq id state at', 'creation_results': 'id result'},
 'legacy': {'jobs': 'id thread intent state created updated attempts turn result',
            'audit': 'seq id state at',
            'repair_receipts': 'id task result_hash result ack'},
 'component_jobs': {'meta': 'version',
    'preparations': 'id task principal component before_sha256 after_sha256 preparation_sha256 created expires',
    'reviews': 'id task send principal component review_sha256 validation_sha256 source_set_sha256 created expires',
    'jobs': 'operation action binding binding_sha256 state created updated receipt',
    'audit': 'seq operation action state at',
    'observations': 'nonce operation binding_sha256 body at cleanup',
    'phases': 'operation purpose request_sha256 state created updated receipt'},
 'component_workflow': {'operations': 'id request_hash component task state base candidate created updated result',
    'audit': 'seq id state at', 'receipts': 'seq id state result result_hash at'},
}
# No result, prompt, thread, binding, node context or credential column is selected.
SELECTS = {
 'task': {'tasks': 'state,reconciled', 'sends': 'state,reconciled'},
 'legacy': {'jobs': 'state', 'repair_receipts': 'ack'},
 'component_jobs': {'jobs': 'state', 'phases': 'state', 'observations': 'cleanup', 'meta': 'version'},
 'component_workflow': {'operations': 'state'},
}
SAFE_STATES = {
 ('task', 'tasks'): {'created', 'completed', 'failed', 'interrupted', 'creation_lost_before_send', 'cancelled_before_first_send'},
 ('task', 'sends'): {'completed', 'failed', 'interrupted', 'not_dispatched'},
 ('legacy', 'jobs'): {'completed', 'failed', 'interrupted'},
 ('component_jobs', 'jobs'): {'terminal', 'launch_rejected_without_effect'},
 ('component_jobs', 'phases'): {'terminal', 'launch_rejected_without_effect'},
 ('component_workflow', 'operations'): {'released'},
}
CORE_CASES = {'core_context_retains_id_memory_and_fake_persistent',
              'core_context_disable_restore_retains_id',
              'core_context_removed_id_is_not_claimed_preserved',
              'core_credentials_retained_id_clean_no_decrypt',
              'core_credentials_disable_restore_same_id',
              'core_parseconfig_disabled_id_retained'}
CHECKS = {'credentials_ciphertext_only', 'retained_node_and_flow_ids_context_not_cleaned',
          'configured_store_modules_retained', 'core_5_0_9_clean_semantics',
          'disabled_node_context_unknown', 'context_api_truncation_not_equality'}


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def raw(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(raw(value)).hexdigest()


def identifier(value, size=32):
    return type(value) is str and re.fullmatch('[a-f0-9]{%d}' % size, value) is not None


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def decode(body):
    def unique(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate_guard_metadata_key')
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_guard_metadata')))


def checked_read(path, mode=0o600, maximum=262144):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'fixed_root_path_required')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            need(info.st_uid == 0 and not info.st_mode & 0o022, 'guard_root_parent_changed')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
             and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1
             and 0 < info.st_size <= maximum, 'guard_root_file_changed')
        body = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        need(len(body) == info.st_size and stamp(info) == stamp(after), 'guard_root_read_race')
        return body
    finally:
        os.close(fd)


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def atomic_create(path, value):
    path = Path(path)
    # Ancestors are checked using a Root-only marker/file read by the coordinator;
    # independently traverse here, including the immediate directory.
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            need(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                 'private_guard_parent_changed')
        info = os.fstat(directory)
        need(stat.S_IMODE(info.st_mode) == 0o700, 'private_guard_parent_required')
        body = raw(value) + b'\n'
        need(len(body) <= 32768, 'guard_proof_bound')
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        try:
            need(os.write(fd, body) == len(body), 'guard_proof_write_incomplete')
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory)
    finally:
        os.close(directory)


def runtime_ancestors(path):
    need(path in RUNTIME_FILES, 'runtime_file_outside_fixed_scope')
    return tuple(str(parent) for parent in reversed(Path(path).parents))


def verify_runtime_ancestor(info, name, parent_pins=None):
    need(stat.S_ISDIR(info.st_mode), 'runtime_ancestor_not_directory')
    if parent_pins is None:
        need(not info.st_mode & 0o022, 'runtime_ancestor_writable')
        return
    identity = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
    need(identity == parent_pins[name], 'runtime_ancestor_identity_changed')
    need(not info.st_mode & 0o002, 'runtime_ancestor_world_writable')
    if info.st_mode & 0o020:
        need(info.st_gid == 0, 'runtime_ancestor_group_write_not_root_group')


def local_ipv4_addresses(table):
    """Recognize only exact /32 host LOCAL records from bounded fib_trie text."""
    need(type(table) is str and len(table.encode()) <= 1048576, 'fib_trie_bound_or_type')
    lines = table.splitlines()
    result = set()
    for index, line in enumerate(lines[:-1]):
        match = re.fullmatch(r'[ \t|]*[|]-- ([0-9]+(?:[.][0-9]+){3})', line)
        if match and lines[index + 1].strip() == '/32 host LOCAL':
            try:
                result.add(str(ipaddress.IPv4Address(match.group(1))))
            except ipaddress.AddressValueError:
                raise ValueError('fib_trie_address_invalid') from None
    return result


def ipv4_listener(table, pinned, backend_host):
    """Read fixed IPv4 TCP LISTEN metadata; no connection or socket mutation."""
    need(type(table) is str and len(table.encode()) <= 1048576, 'tcp_table_bound_or_type')
    expected_address = str(ipaddress.IPv4Address(pinned['local_address']))
    need(expected_address in ('0.0.0.0', backend_host), 'listener_does_not_cover_backend_ip')
    matches = []
    lines = table.splitlines()
    need(lines and 'local_address' in lines[0] and len(lines) <= 8193, 'tcp_table_header_or_bound')
    for line in lines[1:]:
        fields = line.split()
        need(len(fields) >= 10, 'tcp_table_row_unknown')
        need(re.fullmatch(r'[A-Fa-f0-9]{8}:[A-Fa-f0-9]{4}', fields[1]) is not None,
             'tcp_local_address_unknown')
        encoded, encoded_port = fields[1].split(':')
        address = str(ipaddress.IPv4Address(int(encoded, 16).to_bytes(4, 'little')))
        port = int(encoded_port, 16)
        if fields[3] != '0A' or port != 1880:
            continue
        need(fields[9].isdigit(), 'tcp_listener_inode_unknown')
        if address == expected_address and int(fields[9]) == pinned['socket_inode']:
            matches.append((address, port, int(fields[9])))
    need(len(matches) == 1, 'pinned_tcp_listener_missing_or_ambiguous')
    return {'local_address': matches[0][0], 'port': matches[0][1], 'socket_inode': matches[0][2]}


class NativeIO:
    """Native fixed reads; no protocol-supplied IO operations or destinations."""
    def process(self, pid):
        proc = Path('/proc') / str(pid)
        body = (proc / 'stat').read_text()
        fields = body.rsplit(')', 1)[1].split()
        values = {line.split(':', 1)[0]: line.split(':', 1)[1].split()
                  for line in (proc / 'status').read_text().splitlines() if ':' in line}
        root = (proc / 'root').stat()
        netns = (proc / 'ns' / 'net').stat()
        return {'birth_ticks': int(fields[19]), 'state': fields[0],
                'uids': [int(v) for v in values['Uid']],
                'gids': [int(v) for v in values['Gid']],
                'root_identity': [root.st_dev, root.st_ino],
                'netns_identity': [netns.st_dev, netns.st_ino],
                'mountinfo_sha256': hashlib.sha256((proc / 'mountinfo').read_bytes()).hexdigest()}

    def peer_listener(self, pid, backend_host, activation):
        proc = Path('/proc') / str(pid)
        expected = activation['backend_listener']
        need(expected['family'] == 'tcp4', 'listener_family_not_reviewed')
        def bounded_text(name):
            need(name in ('tcp','fib_trie'), 'fixed_peer_proc_scope_required')
            fd = os.open(proc / 'net' / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                body = os.read(fd, 1048577)
                need(len(body) <= 1048576, 'peer_proc_table_bound')
                return body.decode('ascii', errors='strict')
            finally:
                os.close(fd)
        ns_before = (proc / 'ns' / 'net').stat()
        netns = [ns_before.st_dev, ns_before.st_ino]
        need(netns == activation['netns_identity'], 'backend_network_namespace_drift')
        need(backend_host in local_ipv4_addresses(bounded_text('fib_trie')),
             'backend_ip_not_local_in_pinned_namespace')
        listener = ipv4_listener(bounded_text('tcp'), expected, backend_host)
        # /proc/PID/net is namespace-wide, not proof of process ownership. The
        # exact socket inode must simultaneously be held by this pinned PID.
        descriptors = list((proc / 'fd').iterdir())
        need(len(descriptors) <= 4096, 'backend_fd_scan_bound')
        owners = []
        for item in descriptors:
            need(item.name.isdigit(), 'backend_fd_entry_unknown')
            try:
                target = os.readlink(item)
            except FileNotFoundError:
                continue  # unrelated descriptor may close; listener is rechecked below
            if target == 'socket:[%d]' % expected['socket_inode']:
                owners.append(item.name)
        need(owners, 'pinned_process_does_not_own_listener')
        need(any(os.readlink(proc / 'fd' / name) == 'socket:[%d]' % expected['socket_inode']
                 for name in owners), 'pinned_listener_descriptor_changed')
        need(ipv4_listener(bounded_text('tcp'), expected, backend_host) == listener,
             'backend_listener_changed_during_observation')
        ns_after = (proc / 'ns' / 'net').stat()
        need([ns_after.st_dev, ns_after.st_ino] == netns,
             'backend_network_namespace_read_race')
        return {**listener, 'netns_identity': netns, 'pid_owns_listener': True,
                'backend_ip_local': True, 'tcp_family': 'tcp4'}

    def check_attestation_quota(self, reserved, reserve_entries):
        need(type(reserved) is int and 0 < reserved <= 3*32768
             and type(reserve_entries) is int and 0 < reserve_entries <= 5,
             'guard_quota_reservation_unknown')
        total=0;entries=0
        for folder,dirs,files in os.walk(ATTESTATIONS,followlinks=False):
            for name in dirs+files:
                item=Path(folder)/name;meta=item.lstat();entries+=1
                need(entries<=8192 and not stat.S_ISLNK(meta.st_mode)
                     and meta.st_uid==meta.st_gid==0, 'guard_state_metadata_capacity_or_identity')
                if stat.S_ISREG(meta.st_mode):total+=meta.st_size
                else:need(stat.S_ISDIR(meta.st_mode), 'guard_state_special_file_refused')
        need(entries+reserve_entries<=8192, 'guard_state_metadata_capacity_or_identity')
        need(total+reserved<=64*1048576, 'guard_attestation_storage_capacity')
        return True

    def prepare_peer_folder(self, lease_id):
        need(identifier(lease_id), 'fixed_peer_lease_required')
        info = ATTESTATIONS.lstat()
        need(stat.S_ISDIR(info.st_mode) and not ATTESTATIONS.is_symlink()
             and info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
             'private_peer_root_required')
        self.check_attestation_quota(32768, 3)
        parent = ATTESTATIONS / 'peer'
        for folder in (parent, parent / lease_id):
            try:
                folder.mkdir(mode=0o700)
            except FileExistsError:
                pass
            meta = folder.lstat()
            need(stat.S_ISDIR(meta.st_mode) and not folder.is_symlink()
                 and meta.st_uid == meta.st_gid == 0 and stat.S_IMODE(meta.st_mode) == 0o700,
                 'private_peer_lease_directory_required')
        need(len(list(parent.iterdir())) <= 1024, 'peer_lease_capacity')
        need(len(list((parent / lease_id).iterdir())) < 64, 'peer_proof_capacity')
        return True

    def held_locks(self, context, expected):
        need(type(context.get('lock_fds')) is tuple and len(context['lock_fds']) == len(LOCKS),
             'inherited_guard_lock_descriptors_required')
        kernel = Path('/proc/locks').read_text().splitlines()
        evidence = []
        for path, fd in zip(LOCKS, context['lock_fds']):
            need(type(fd) is int and fd >= 0, 'inherited_guard_fd_invalid')
            info = os.fstat(fd)
            identity = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
            named = os.stat(path, follow_symlinks=False)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                 and identity == expected[path] and stamp(info) == stamp(named),
                 'inherited_guard_lock_identity_changed')
            token = '%02x:%02x:%d' % (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
            found = False
            for row in kernel:
                parts = row.split()
                if len(parts) >= 8 and parts[1:4] == ['FLOCK', 'ADVISORY', 'WRITE']:
                    if parts[4] == str(os.getpid()) and parts[5] == token and parts[6:] == ['0', 'EOF']:
                        found = True
            need(found, 'kernel_exclusive_flock_not_owned')
            evidence.append(identity)
        return evidence

    def runtime_file(self, pid, path, maximum, parent_pins=None):
        need(path in RUNTIME_FILES, 'runtime_file_outside_fixed_scope')
        if parent_pins is not None:
            need(type(parent_pins) is dict and set(parent_pins) == set(runtime_ancestors(path)),
                 'runtime_ancestor_pin_scope_unknown')
            need(all(type(row) is list and len(row) == 5 and
                     all(type(v) is int and v >= 0 for v in row) for row in parent_pins.values()),
                 'runtime_ancestor_pin_identity_unknown')
        # Only the kernel's proc-root link is followed; every descendant must be
        # an ordinary directory with exact Root-reviewed identity when pinned.
        # Only pinned GID0 group-write is eligible; world-write/leaf-write remain
        # blocked. No symlink substitution in node_modules, /data or leaf allowed.
        directory = os.open('/proc/%d/root' % pid, os.O_RDONLY | os.O_DIRECTORY)
        try:
            root = os.fstat(directory)
            verify_runtime_ancestor(root, '/', parent_pins)
            current_path = ''
            for name in Path(path).parts[1:-1]:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
                info = os.fstat(directory)
                current_path += '/' + name
                verify_runtime_ancestor(info, current_path, parent_pins)
            fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                 and not info.st_mode & 0o022 and 0 < info.st_size <= maximum,
                 'runtime_file_unconfirmed_or_unbounded')
            hasher = hashlib.sha256()
            total = 0
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                total += len(chunk)
                need(total <= maximum, 'runtime_fingerprint_bound')
                hasher.update(chunk)
            after = os.fstat(fd)
            need(total == info.st_size and stamp(info) == stamp(after), 'runtime_file_read_race')
            return {'sha256': hasher.hexdigest(), 'bytes': total,
                    'device': info.st_dev, 'inode': info.st_ino,
                    'uid': info.st_uid, 'gid': info.st_gid,
                    'mode': stat.S_IMODE(info.st_mode),
                    'root_identity': [root.st_dev, root.st_ino],
                    'fixed_relative_path_sha256': hashlib.sha256(path.encode()).hexdigest(),
                    'descendants_no_symlinks': True,
                    'ancestor_identity_pins_verified': parent_pins is not None}
        finally:
            os.close(fd)

    def prepare_proof_folder(self, operation_id, lease_id):
        need(identifier(operation_id) and identifier(lease_id), 'fixed_proof_identity_required')
        # Root reviewer already owns the operation folder; only this nonce child
        # is created here, under the inherited locks. No caller-selected path.
        parent=ATTESTATIONS/operation_id
        info=parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and not parent.is_symlink()
             and info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o700,
             'reviewed_operation_directory_required')
        self.check_attestation_quota(3*32768, 5)
        for folder in (parent/'leases',parent/'leases'/lease_id):
            try:folder.mkdir(mode=0o700)
            except FileExistsError:pass
            meta=folder.lstat()
            need(stat.S_ISDIR(meta.st_mode) and not folder.is_symlink()
                 and meta.st_uid==meta.st_gid==0 and stat.S_IMODE(meta.st_mode)==0o700,
                 'private_lease_directory_required')
        need(len(list((parent/'leases').iterdir()))<=32,'operation_guard_lease_capacity')
        return True

    def ledger(self, name, expected):
        need(name in LEDGERS, 'fixed_ledger_scope_required')
        path = Path(LEDGERS[name])
        for parent in path.parents:
            item = parent.lstat()
            need(stat.S_ISDIR(item.st_mode) and not stat.S_ISLNK(item.st_mode)
                 and not item.st_mode & 0o002, 'ledger_parent_changed')
        before = path.lstat()
        identity = [before.st_dev, before.st_ino, before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)]
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and identity == expected
             and before.st_size <= 1048576, 'fixed_ledger_identity_changed')
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0, isolation_level=None)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('PRAGMA trusted_schema=OFF')
            need(db.execute('PRAGMA journal_mode').fetchone()[0] == 'delete', 'ledger_journal_unknown')
            db.execute('BEGIN')
            # Exact table/column closure refuses unknown or migrated schemas.
            need(not db.execute("SELECT 1 FROM sqlite_master WHERE type NOT IN ('table','index') LIMIT 1").fetchone(),
                 'ledger_schema_objects_unknown')
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            need(tables == set(SCHEMAS[name]), 'ledger_schema_tables_unknown')
            for table, columns in SCHEMAS[name].items():
                need([r[1] for r in db.execute('PRAGMA table_info(' + table + ')')]
                     == columns.split(), 'ledger_schema_columns_unknown')
            data = {}
            for table, columns in SELECTS[name].items():
                rows = db.execute('SELECT ' + columns + ' FROM ' + table + ' LIMIT 2049').fetchall()
                need(len(rows) <= 2048, 'ledger_metadata_bound')
                data[table] = [dict(zip(columns.split(','), r)) for r in rows]
            need(stamp(before) == stamp(path.lstat()), 'ledger_changed_under_shared_locks')
            return data
        finally:
            db.close()

    def existing_executor(self, ctx, identities, source_hashes, sealed_read):
        """Reuse exact sealed existing observer, without profile-specific components().

        Existing code performs its own historical correction-link verification.
        Its private rows stay inside that reviewed code; this guard publishes
        only sanitized coverage and a metadata-snapshot hash. No result body is
        returned or written by the guard.
        """
        need(type(source_hashes) is dict and set(source_hashes) == set(EXISTING_SOURCES),
             'existing_executor_source_coverage_unknown')
        loaded = {}
        for name, source_path in EXISTING_SOURCES.items():
            body = sealed_read(source_path, 0o644, 1048576)
            need(identifier(source_hashes[name], 64) and hashlib.sha256(body).hexdigest() == source_hashes[name],
                 'existing_executor_source_drift')
            module = types.ModuleType('inline_existing_' + name[:-3])
            module.__file__ = str(source_path)
            # Do not reuse mutable global sys.modules admission. The observer
            # gets the exact in-process source module verified immediately above.
            original_import = builtins.__import__
            def bound_import(target, globals=None, locals=None, fromlist=(), level=0):
                if target == 'admission' and not level:
                    need('admission.py' in loaded, 'existing_admission_not_loaded')
                    return loaded['admission.py']
                need(target in {'contextlib','fcntl','json','math','os','re','sqlite3','stat','time','pathlib','hashlib'},
                     'existing_executor_unreviewed_import')
                return original_import(target, globals, locals, fromlist, level)
            module.__dict__['__builtins__'] = dict(vars(builtins), __import__=bound_import)
            exec(compile(body, str(source_path), 'exec'), module.__dict__)
            loaded[name] = module
        outer = self
        class ActiveLockView:
            def check(self):
                outer.held_locks(ctx, identities)
                return True
        lock = ActiveLockView()
        observer = loaded['executor_observer.py'].ExecutorObserver(
            lock, lock, lock,
            '/var/lib/raspberry-admin-executor/receipt.json',
            '/var/lib/raspberry-mcp-deploy/journal.sqlite3',
            '/usr/local/lib/raspberry-mcp-deploy/release/activation.json',
            '/var/lib/raspberry-mcp-jobs/jobs.sqlite3', 983,
            '/var/lib/raspberry-component-repair/workflow.sqlite3')
        result = observer.existing_snapshot()
        need(type(result) is dict and result.get('existing_executors_idle') is True
             and result.get('collection_error') is None and result.get('root_verified') is True
             and set(result.get('coverage', [])) ==
                 {'legacy_admin_executor','deployment_journal_and_immutable_corrections','durable_jobs'},
             'existing_executor_coverage_unconfirmed')
        return {'snapshot_sha256': digest(result), 'coverage': sorted(result['coverage']),
                'registered_existing_executors_idle': True, 'private_rows_exported': False}


class NativeGuard:
    def __init__(self, policy_document, root_policy_sha256, clock=time.time,
                 sealed_read=None, atomic_create=None, deps=None):
        self.document = policy_document
        self.policy_sha = root_policy_sha256
        self.clock = clock
        self.read = sealed_read or checked_read
        self.create = atomic_create or globals()['atomic_create']
        self.io = deps or NativeIO()
        self.expected = policy_document.get('native_guard_producer')
        required = {'mode', 'source_sha256', 'runtime_activation_sha256', 'isolated_review_sha256',
                    'ledger_identities', 'existing_executor_source_sha256'}
        need(type(self.expected) is dict and required <= set(self.expected)
             and set(self.expected) <= required | {'public_source_catalog_producer'}
             and self.expected['mode'] == 'inline', 'native_inline_guard_policy_unknown')
        if 'public_source_catalog_producer' in self.expected:
            public = self.expected['public_source_catalog_producer']
            need(type(public) is dict and set(public) == {'source_sha256'}
                 and identifier(public['source_sha256'], 64), 'public_source_producer_pin_unknown')
        need(identifier(root_policy_sha256, 64) and set(self.expected['ledger_identities']) == set(LEDGERS),
             'native_guard_ledger_scope_unknown')
        for name in ('source_sha256', 'runtime_activation_sha256', 'isolated_review_sha256'):
            need(identifier(self.expected[name], 64), 'guard_source_or_review_pin_invalid')

    def _sealed(self, path, expected):
        body = self.read(path)
        need(hashlib.sha256(body).hexdigest() == expected, 'native_guard_sealed_metadata_drift')
        value = decode(body)
        need(type(value) is dict, 'native_guard_sealed_object_required')
        return value

    def _lease(self, ctx):
        need(type(ctx) is dict and identifier(ctx.get('lock_lease_id'))
             and ctx.get('executing_pid') == os.getpid() and os.geteuid() == 0
             and finite(ctx.get('locks_acquired_at'))
             and 0 <= self.clock() - ctx['locks_acquired_at'] <= 300,
             'current_root_lock_lease_required')
        need(ctx.get('lock_identities') == self.document.get('shared_locks')
             and set(ctx['lock_identities']) == set(LOCKS), 'guard_lock_scope_changed')
        return self.io.held_locks(ctx, self.document['shared_locks'])

    def ready(self, ctx):
        self._lease(ctx)
        need(hashlib.sha256(self.read(SOURCE, 0o644, 1048576)).hexdigest()
             == self.expected['source_sha256'], 'inline_guard_source_drift')
        # Code must actually have been loaded from the exact Root module path;
        # bootstrap also hashes bytes BEFORE compile/exec into this process.
        need(Path(__file__) == SOURCE and self.__class__ is NativeGuard,
             'inline_guard_not_loaded_from_root_module')
        self._runtime()
        return True

    def _runtime(self):
        activation = self._sealed(ACTIVATION, self.expected['runtime_activation_sha256'])
        need(set(activation) == {'schema_version', 'core_version', 'pid', 'birth_ticks', 'uid', 'gid',
             'root_identity', 'mountinfo_sha256', 'image_digest', 'core_sha256', 'settings_sha256',
             'context_store_modules', 'runtime_file_owners', 'netns_identity',
             'backend_listener', 'runtime_ancestor_pins'}, 'runtime_activation_scope_unknown')
        need(activation['schema_version'] == 1 and activation['core_version'] == '5.0.9'
             and type(activation['pid']) is int and activation['pid'] > 1
             and type(activation['birth_ticks']) is int and activation['birth_ticks'] > 0
             and re.fullmatch(r'sha256:[a-f0-9]{64}', activation['image_digest'] or '')
             and set(activation['core_sha256']) == set(CORE_FILES)
             and type(activation['netns_identity']) is list and len(activation['netns_identity']) == 2
             and all(type(v) is int and v >= 0 for v in activation['netns_identity'])
             and type(activation['backend_listener']) is dict
             and set(activation['backend_listener']) == {'family','local_address','port','socket_inode'}
             and activation['backend_listener']['family'] == 'tcp4'
             and type(activation['backend_listener']['socket_inode']) is int
             and activation['backend_listener']['socket_inode'] > 0
             and activation['backend_listener']['port'] == 1880
             and type(activation['runtime_ancestor_pins']) is dict
             and set(activation['runtime_ancestor_pins']) == set(RUNTIME_FILES)
             and all(type(pins) is dict and set(pins) == set(runtime_ancestors(path))
                     and all(type(row) is list and len(row) == 5
                             and all(type(v) is int and v >= 0 for v in row)
                             for row in pins.values())
                     for path,pins in activation['runtime_ancestor_pins'].items())
             and type(activation['runtime_file_owners']) is dict
             and set(activation['runtime_file_owners']) == set(RUNTIME_FILES)
             and all(type(ids) is list and len(ids) == 2 and
                     all(type(v) is int and v >= 0 for v in ids)
                     for ids in activation['runtime_file_owners'].values())
             and activation['context_store_modules'] ==
                 {'default': 'memoryOnly', 'memoryOnly': 'memory', 'persistent': 'localfilesystem'},
             'runtime_identity_or_context_configuration_unknown')
        current = self.io.process(activation['pid'])
        need(current['state'] not in ('Z', 'X') and current['birth_ticks'] == activation['birth_ticks']
             and current['uids'] == [activation['uid']] * 4 and current['gids'] == [activation['gid']] * 4
             and current['root_identity'] == activation['root_identity']
             and current['netns_identity'] == activation['netns_identity']
             and current['mountinfo_sha256'] == activation['mountinfo_sha256'],
             'runtime_process_or_mount_drift')
        meta = {}
        for path in CORE_FILES + ('/data/settings.js',):
            info = self.io.runtime_file(activation['pid'], path, 2097152,
                                        activation['runtime_ancestor_pins'][path])
            expected = activation['settings_sha256'] if path == '/data/settings.js' else activation['core_sha256'][path]
            need(info['sha256'] == expected and info['root_identity'] == activation['root_identity']
                 and [info['uid'], info['gid']] == activation['runtime_file_owners'][path]
                 and info['descendants_no_symlinks'] is True
                 and info['ancestor_identity_pins_verified'] is True,
                 'runtime_core_or_settings_drift')
            meta[path] = info
        # PID reuse/root changes during source reads are refused as well.
        need(self.io.process(activation['pid']) == current, 'runtime_identity_read_race')
        return activation, meta

    def _review(self, activation):
        review = self._sealed(REVIEW, self.expected['isolated_review_sha256'])
        need(set(review) == {'schema_version', 'core_version', 'core_sha256', 'settings_sha256',
             'context_store_modules', 'checks', 'isolated_exit_code', 'isolated_evidence_sha256',
             'reviewed_effects_require_exact_admission'} and review['schema_version'] == 1
             and review['core_version'] == activation['core_version']
             and review['core_sha256'] == activation['core_sha256']
             and review['settings_sha256'] == activation['settings_sha256']
             and review['context_store_modules'] == activation['context_store_modules']
             and type(review['checks']) is list and set(review['checks']) == CHECKS
             and len(review['checks']) == len(CHECKS) and review['isolated_exit_code'] == 0
             and identifier(review['isolated_evidence_sha256'], 64)
             and review['reviewed_effects_require_exact_admission'] is True,
             'isolated_core_context_review_incomplete')
        evidence = self._sealed(EVIDENCE, review['isolated_evidence_sha256'])
        need(evidence.get('schema_version') == 1 and evidence.get('core_version') == '5.0.9'
             and evidence.get('passed') is True and evidence.get('core_sha256') == activation['core_sha256']
             and evidence.get('coverage') == ['actual_core_module_exports', 'in_memory_io_stubs',
                 'synthetic_ids_only', 'fake_persistent_store']
             and evidence.get('proves_full_runtime_deploy') is False
             and evidence.get('proves_real_store_flush') is False
             and evidence.get('proves_context_value_equality') is False
             and evidence.get('proves_contrib_finalize_safety') is False,
             'isolated_core_evidence_incomplete')
        cases = evidence.get('cases')
        need(type(cases) is list and len(cases) == len(CORE_CASES)
             and all(type(case) is dict and set(case) == {'name','passed'}
                     and case['passed'] is True for case in cases)
             and {case['name'] for case in cases} == CORE_CASES,
             'isolated_core_cases_unproven')
        need(evidence.get('logical_disable_restore_core_semantics_only') is True,
             'logical_disable_restore_core_semantics_unproven')
        return digest(review)

    def _common(self, plan_hash, operation_id, ctx):
        self.ready(ctx)
        need(identifier(plan_hash, 64) and identifier(operation_id), 'guard_plan_identity_invalid')
        now = self.clock()
        expiry = self.document.get('engine', {}).get('expires_at')
        need(finite(expiry) and now < expiry, 'guard_administrative_scope_expired')
        return {'producer': 'sealed_nodered_admin_validator',
                'source': 'inline_native_protected_state_guard',
                'root_policy_sha256': self.policy_sha, 'operation_id': operation_id,
                'plan_sha256': plan_hash, 'lock_lease_id': ctx['lock_lease_id'],
                'executing_pid': os.getpid(), 'observed_at': now,
                'expires_at': min(now + 5, expiry),
                'loaded_source_sha256': self.expected['source_sha256']}

    def produce_peer(self, ctx):
        """One immutable identity proof for this request/lease, never auth evidence."""
        self.ready(ctx)
        activation, _ = self._runtime()
        backend = self.document['backend']
        need(type(backend) is dict and set(backend) == {'host','port','username','identity_sha256'}
             and backend['port'] == 1880 and identifier(backend['identity_sha256'], 64),
             'fixed_peer_backend_policy_changed')
        host = str(ipaddress.IPv4Address(backend['host']))
        address = ipaddress.IPv4Address(host)
        need(address.is_private and not address.is_loopback and not address.is_unspecified
             and not address.is_multicast, 'fixed_peer_backend_address_refused')
        observed = self.io.peer_listener(activation['pid'], host, activation)
        need(observed['netns_identity'] == activation['netns_identity']
             and observed['socket_inode'] == activation['backend_listener']['socket_inode']
             and observed['port'] == 1880 and observed['tcp_family'] == 'tcp4'
             and observed['pid_owns_listener'] is True and observed['backend_ip_local'] is True,
             'native_backend_listener_unconfirmed')
        current = self.io.process(activation['pid'])
        need(current['birth_ticks'] == activation['birth_ticks'] and current['state'] not in ('Z','X')
             and current['netns_identity'] == activation['netns_identity']
             and current['root_identity'] == activation['root_identity']
             and current['uids'] == [activation['uid']] * 4
             and current['gids'] == [activation['gid']] * 4
             and current['mountinfo_sha256'] == activation['mountinfo_sha256'],
             'backend_process_changed_before_peer_publication')
        self._lease(ctx)
        nonce = secrets.token_hex(16)
        need(identifier(nonce), 'native_peer_generation_invalid')
        need(self.io.prepare_peer_folder(ctx['lock_lease_id']) is True, 'private_peer_folder_unconfirmed')
        now = self.clock()
        value = {'schema_version': 1, 'producer': 'sealed_nodered_admin_inline_peer',
                 'source': 'pinned_pid_network_namespace_listener_and_local_ip',
                 'root_policy_sha256': self.policy_sha, 'loaded_source_sha256': self.expected['source_sha256'],
                 'runtime_activation_sha256': self.expected['runtime_activation_sha256'],
                 'backend_identity_sha256': backend['identity_sha256'], 'host': host, 'port': 1880,
                 'lock_lease_id': ctx['lock_lease_id'], 'request_generation': nonce,
                 'executing_pid': os.getpid(), 'observed_at': now, 'expires_at': now + 5,
                 'runtime_pid': activation['pid'], 'runtime_birth_ticks': activation['birth_ticks'],
                 'netns_identity': observed['netns_identity'], 'socket_inode': observed['socket_inode'],
                 'backend_listener_identity_proven': True,
                 'authenticated_Admin_API_enabled': None,
                 'authentication_proven': False,
                 'authority_scope': 'identity_observation_only_not_operation_admission',
                 'observed': observed}
        path = ATTESTATIONS / 'peer' / ctx['lock_lease_id'] / (nonce + '.json')
        self.create(path, value)
        return {'proof_path': str(path), 'proof_sha256': digest(value), 'request_generation': nonce}

    def produce_coordination(self, binding, ctx):
        need(type(binding) is dict, 'coordination_binding_required')
        value = self._common(binding.get('plan_sha256'), binding.get('operation_id'), ctx)
        coverage = {}
        for name in LEDGERS:
            tables = self.io.ledger(name, self.expected['ledger_identities'][name])
            need(set(tables) == set(SELECTS[name]), 'coordination_metadata_coverage_unknown')
            for table, rows in tables.items():
                for row in rows:
                    need(type(row) is dict and set(row) == set(SELECTS[name][table].split(',')),
                         'ledger_metadata_schema_unknown')
                    if 'state' in row:
                        need(row['state'] in SAFE_STATES[(name, table)], 'unrelated_busy_uncertain_or_unknown_work')
                    if 'reconciled' in row:
                        need(type(row['reconciled']) is int and row['reconciled'] == 1,
                             'unreconciled_task_work')
                    if 'ack' in row:
                        need(type(row['ack']) is int and row['ack'] == 1, 'unreconciled_repair_work')
                    if 'cleanup' in row:
                        need(type(row['cleanup']) is int and row['cleanup'] == 1,
                             'component_authentication_cleanup_unconfirmed')
                    if 'version' in row:
                        need(type(row['version']) is int and row['version'] == 1,
                             'component_schema_version_unknown')
                if table == 'meta':
                    need(len(rows) == 1, 'component_schema_version_missing')
            coverage[name] = {table: len(rows) for table, rows in tables.items()}
        existing = self.io.existing_executor(ctx, self.document['shared_locks'],
                                             self.expected['existing_executor_source_sha256'], self.read)
        self._lease(ctx)
        value.update(ledgers_checked_under_inherited_shared_locks=True,
                     fixed_catalogues_no_busy_or_uncertain_work=True,
                     global_no_unrelated_busy_or_uncertain_work=True,
                     existing_executor_metadata=existing,
                     arbitrary_root_or_native_client_idleness_proven=False,
                     metadata_only=True, coverage=coverage,
                     coordination_scope='fixed_registered_task_legacy_repair_component_and_existing_executors',
                     native_clients_outside_shared_locks_not_globally_serialized=True)
        need(self.io.prepare_proof_folder(binding['operation_id'],ctx['lock_lease_id']) is True, 'private_proof_directory_unconfirmed')
        path = ATTESTATIONS / binding['operation_id'] / 'leases' / ctx['lock_lease_id'] / 'coordination.json'
        self.create(path, value)
        return {'proof_path': str(path), 'proof_sha256': digest(value)}

    def produce_guard(self, plan, phase, ctx):
        need(type(plan) is dict and phase in ('before', 'after'), 'guard_phase_required')
        value = self._common(digest(plan), plan.get('operation_id'), ctx)
        activation, files = self._runtime()
        review_hash = self._review(activation)
        old, new = plan.get('before_flows'), plan.get('after_flows')
        need(type(old) is list and type(new) is list and len(old) <= 10000 and len(new) <= 10000,
             'guard_flow_inventory_unknown')
        need(all(type(n) is dict and type(n.get('id')) is str for n in old + new),
             'guard_flow_id_unknown')
        old_ids, new_ids = {n['id'] for n in old}, {n['id'] for n in new}
        need(len(old_ids) == len(old) and len(new_ids) == len(new) and old_ids <= new_ids,
             'context_id_removal_or_duplicate_refused')
        # Existing node scope (flow/subflow membership) cannot migrate here: that
        # would require a separate reviewed context migration implementation.
        after = {n['id']: n for n in new}
        need(all((n.get('z'), n.get('type')) == (after[n['id']].get('z'), after[n['id']].get('type'))
                 for n in old), 'context_scope_or_node_type_migration_refused')
        credential = self.io.runtime_file(activation['pid'], '/data/flows_cred.json', 2097152,
                                          activation['runtime_ancestor_pins']['/data/flows_cred.json'])
        need([credential['uid'], credential['gid']] == activation['runtime_file_owners']['/data/flows_cred.json']
             and credential['root_identity'] == activation['root_identity']
             and credential['descendants_no_symlinks'] is True
             and credential['ancestor_identity_pins_verified'] is True, 'ciphertext_file_identity_unknown')
        construction = {'retained_ids_sha256': digest(sorted(old_ids)),
                        'before_flows_sha256': digest(old), 'after_flows_sha256': digest(new),
                        'core_files_sha256': digest(activation['core_sha256']),
                        'settings_sha256': activation['settings_sha256'],
                        'isolated_review_sha256': review_hash,
                        'store_configuration_sha256': digest(activation['context_store_modules'])}
        baseline_path = ATTESTATIONS / plan['operation_id'] / 'protected-baseline.json'
        baseline = {'schema_version': 1, 'operation_id': plan['operation_id'], 'plan_sha256': digest(plan),
                    'runtime_activation_sha256': self.expected['runtime_activation_sha256'],
                    'credential_ciphertext_sha256': credential['sha256'],
                    'credential_ciphertext_bytes': credential['bytes'],
                    'context_construction': construction}
        if phase == 'before':
            try:
                previous = decode(self.read(baseline_path))
            except FileNotFoundError:
                self.create(baseline_path, baseline)
            else:
                need(previous == baseline, 'immutable_baseline_changed_no_retry')
        else:
            previous = decode(self.read(baseline_path))
            # No automatic restore, re-encryption or new baseline on difference.
            need(previous == baseline, 'protected_state_changed_unconfirmed_no_restore')
            intent = decode(self.read(STATE / 'operations' / plan['operation_id'] / 'intent.json'))
            need(intent.get('plan_sha256') == digest(plan)
                 and finite(intent.get('attempted_at'))
                 and intent['attempted_at'] <= value['observed_at'], 'post_guard_requires_prior_exact_intent')
        self._lease(ctx)
        need(self.io.process(activation['pid'])['birth_ticks'] == activation['birth_ticks'],
             'runtime_pid_changed_before_guard_publication')
        value.update(policy_sha256=digest(self.document['engine']), risk_sha256=digest(plan['risk']),
                     phase=phase, credentials_unchanged=True, context_preservation_proven=True,
                     credential_protection='ciphertext_sha256_equality_only_no_decryption',
                     context_protection='retained_ids_and_pinned_core_store_semantics_by_construction',
                     full_runtime_context_value_equality_proven=False,
                     credential_semantic_equality_proven=False,
                     disabled_node_context_values='unknown', context_api_values_read=False,
                     root_review_sha256=review_hash, baseline_sha256=digest(baseline),
                     runtime_pid=activation['pid'], runtime_birth_ticks=activation['birth_ticks'],
                     pinned_operator_image_digest=activation['image_digest'],
                     image_digest_independently_queried=False,
                     fixed_core_metadata=files,
                     logical_delete_restore_isolated_proven=True,
                     logical_delete_restore_coverage="pinned_core_with_in_memory_store_stubs_only",
                     new_node_retirement_recoverable=False)
        need(self.io.prepare_proof_folder(plan['operation_id'],ctx['lock_lease_id']) is True, 'private_proof_directory_unconfirmed')
        path = ATTESTATIONS / plan['operation_id'] / 'leases' / ctx['lock_lease_id'] / ('guard-' + phase + '.json')
        self.create(path, value)
        return {'proof_path': str(path), 'proof_sha256': digest(value)}
