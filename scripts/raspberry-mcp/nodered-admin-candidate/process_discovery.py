"""Read-only process discovery core for a separately sealed native guard.

No credentials, container bindings, cache, subprocess, write or MCP entrypoint.
The sealed caller supplies the immutable anchor and reviewed metadata reader;
this source alone grants no discovery/adoption authority. Live-anchor checks
and final selected-owner checks stay strict when unrelated descendants exit.
"""
import copy
import errno
import os
from pathlib import Path
import re
import select
import stat

CHANGING = {'pid', 'birth_ticks', 'root_identity', 'netns_identity',
            'mountinfo_sha256', 'backend_listener', 'runtime_ancestor_pins'}


def need(ok, reason):
    if not ok: raise ValueError(reason)


def proc_text(pid, suffix, limit=1048576):
    need(suffix in ('task/%d/children'%pid,'net/tcp'), 'fixed_proc_scope')
    fd = os.open('/proc/%d/%s'%(pid,suffix), os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try: body = os.read(fd,limit+1)
    finally: os.close(fd)
    need(len(body) <= limit, 'proc_read_bound')
    return body.decode('ascii')


def descendant_candidates(init_pid):
    """Only bounded kernel child edges from fixed Docker init metadata."""
    rows = []; pending = [(init_pid,0)]
    while pending:
        pid,depth = pending.pop(0)
        need(pid not in rows and len(rows) < 64 and depth <= 8, 'process_tree_bound_or_cycle')
        rows.append(pid)
        try:
            children = proc_text(pid,'task/%d/children'%pid,4096).split()
        except (FileNotFoundError, ProcessLookupError):
            # An exited task's children are reparented to the container
            # init/subreaper and are enumerated there; init itself stays strict.
            if pid == init_pid or not kernel_proves_process_exited(pid):
                raise
            continue
        need(all(re.fullmatch('[1-9][0-9]{0,9}',v) for v in children), 'child_pid_schema')
        pending.extend((int(v),depth+1) for v in children)
    return rows


def read_process_tree(init_pid):
    try:
        return descendant_candidates(init_pid)
    except (FileNotFoundError, ProcessLookupError):
        raise ValueError('transient_process_unavailable') from None


def kernel_proves_process_absent(pid):
    # ESRCH from pidfd_open proves termination; procfs must independently
    # report ENOENT. Any permission/visibility/other error is uncertainty.
    try:
        fd = os.pidfd_open(pid, 0)
    except OSError as error:
        if error.errno != errno.ESRCH:
            return False
    else:
        os.close(fd)
        return False
    for _ in range(2):
        try:
            os.lstat('/proc/%d' % pid)
        except OSError as error:
            if error.errno != errno.ENOENT:
                return False
            continue
        return False
    return True


def kernel_proves_process_exited(pid):
    """Reaped (strict absence above) or kernel-signalled exit.

    A zombie or an exiting task keeps its PID (no reuse while unreaped) but
    releases descriptors and namespaces first, so /proc/PID/root, ns/net and
    net/tcp become ENOENT and mountinfo EINVAL before state reaches Z. The
    pidfd pins this PID; it becomes readable only when the kernel has
    completed the exit. The bounded wait is passive and never re-reads.
    """
    if kernel_proves_process_absent(pid):
        return True
    try:
        fd = os.pidfd_open(pid, 0)
    except OSError:
        return False
    try:
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        return any(mask & select.POLLIN for _, mask in poller.poll(100))
    finally:
        os.close(fd)


def read_process_identities(tree, io):
    identities = {}; terminated = set()
    for pid in tree:
        try:
            identities[pid] = io.process(pid)
        except OSError as error:
            # ENOENT/ESRCH: task gone or zombie; EINVAL: mountinfo of an
            # exiting task. Anything else (e.g. EACCES) keeps propagating.
            if error.errno not in (errno.ENOENT, errno.ESRCH, errno.EINVAL):
                raise
            if not kernel_proves_process_exited(pid):
                raise ValueError('transient_process_unavailable') from None
            terminated.add(pid)
    return identities, terminated


def read_listener_inode(pid, activation):
    try:
        return listener_inode(pid, activation)
    except (FileNotFoundError, ProcessLookupError):
        raise ValueError('transient_process_unavailable') from None


def read_peer_listener(io, pid, backend_host, activation):
    try:
        return io.peer_listener(pid, backend_host, activation)
    except (FileNotFoundError, ProcessLookupError):
        raise ValueError('transient_process_unavailable') from None


def listener_inode(pid, activation):
    expected = activation['backend_listener']; matches = []
    for line in proc_text(pid,'net/tcp').splitlines()[1:]:
        row = line.split()
        need(len(row) >= 10, 'tcp_row_schema')
        if row[3] == '0A' and row[1].endswith(':0758'):
            inode = int(row[9]); descriptors = list(Path('/proc/%d/fd'%pid).iterdir())
            need(len(descriptors) <= 4096, 'fd_scan_bound')
            for item in descriptors:
                try: target = os.readlink(item)
                except FileNotFoundError: raise ValueError('listener_fd_read_race') from None
                if target == 'socket:[%d]'%inode:
                    matches.append(inode); break
    need(len(matches) <= 1, 'process_owned_listener_ambiguous')
    need(matches, 'process_owned_listener_missing')
    return matches[0]


def credential_metadata(pid, activation, guard):
    """O_PATH leaf: inspect metadata without opening ciphertext for reading."""
    path = '/data/flows_cred.json'
    pins = activation['runtime_ancestor_pins'][path]
    directory = os.open('/proc/%d/root'%pid,os.O_RDONLY|os.O_DIRECTORY)
    try:
        guard.verify_runtime_ancestor(os.fstat(directory),'/',pins)
        current = ''
        for part in Path(path).parts[1:-1]:
            child = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory);directory = child;current += '/'+part
            guard.verify_runtime_ancestor(os.fstat(directory),current,pins)
        leaf = os.open(Path(path).name,os.O_PATH|os.O_NOFOLLOW,dir_fd=directory)
        try:
            info = os.fstat(leaf)
            named = os.stat(Path(path).name,dir_fd=directory,follow_symlinks=False)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode&0o022
                 and [info.st_uid,info.st_gid] == activation['runtime_file_owners'][path]
                 and guard.stamp(info) == guard.stamp(named), 'credential_metadata_drift')
        finally: os.close(leaf)
    finally: os.close(directory)


def ancestor_pins(pid, path, ancestors, verify):
    directory = os.open('/proc/%d/root'%pid, os.O_RDONLY|os.O_DIRECTORY)
    pins = {}
    try:
        for index, name in enumerate(ancestors(path)):
            if index:
                child = os.open(Path(name).name, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,
                                dir_fd=directory)
                os.close(directory); directory = child
            info = os.fstat(directory)
            pins[name] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                          stat.S_IMODE(info.st_mode)]
            verify(info, name, pins)
    finally:
        os.close(directory)
    return pins


def invariant_equal(anchor, observed):
    need(set(anchor) == set(observed), 'activation_scope_drift')
    for key in set(anchor)-CHANGING:
        need(anchor[key] == observed[key], 'trusted_invariant_drift_'+key)
    left, right = anchor['backend_listener'], observed['backend_listener']
    need(set(left) == set(right) and all(left[k] == right[k]
         for k in set(left)-{'socket_inode'}), 'listener_scope_drift')
    for path, pins in anchor['runtime_ancestor_pins'].items():
        current = observed['runtime_ancestor_pins'].get(path, {})
        need(set(pins) == set(current), 'ancestor_scope_drift')
        need(all(row[2:] == current[name][2:] for name,row in pins.items()),
             'ancestor_owner_or_mode_drift')


def read_process(io, pid):
    try:
        return io.process(pid)
    except (FileNotFoundError, ProcessLookupError):
        raise ValueError('transient_process_unavailable') from None


def anchor_ancestry(init_pid, anchor_pid, first, io, same_process):
    """Prove this exact live anchor reaches fixed container init via PPid and cgroup."""
    need(type(init_pid) is int and init_pid > 1 and type(anchor_pid) is int and anchor_pid > 1,
         'container_ancestry_identity_unknown')
    init = read_process(io, init_pid)
    cgroup = init.get('cgroup_identity')
    need(type(cgroup) is str and re.fullmatch('[a-f0-9]{64}', cgroup),
         'container_cgroup_identity_unknown')
    chain = {}
    pid, current = anchor_pid, first
    for _depth in range(64):
        need(pid not in chain, 'container_ancestry_cycle')
        need(type(current) is dict and current.get('state') not in ('Z', 'X')
             and current.get('cgroup_identity') == cgroup,
             'anchor_container_cgroup_mismatch')
        parent = current.get('parent_pid')
        need(type(parent) is int and parent >= 0, 'process_parent_identity_unknown')
        chain[pid] = copy.deepcopy(current)
        if pid == init_pid:
            need(same_process(current, init), 'container_init_identity_changed')
            return chain
        need(parent > 1, 'anchor_not_descendant_of_container_init')
        pid, current = parent, read_process(io, parent)
    raise ValueError('container_ancestry_depth_bound')


def discover(anchor, io, ancestors, verify, stamp, same_process, backend_host, metadata_pins, metadata_reader):
    """Prove the pinned live process without enumerating unrelated children.

    The live-anchor path proves its PPid chain and shared container cgroup,
    then rechecks container metadata, every ancestor identity, protected file
    ancestry/credential metadata and the process-owned backend listener. A dead
    anchor retains the original strict descendant enumeration, with a fixed
    cause for races; it never retries or broadens adoption after a transient read.
    """
    from types import SimpleNamespace
    try:
        old = io.process(anchor['pid'])
    except (FileNotFoundError, ProcessLookupError):
        old = None
    if old is not None and old['state'] not in ('Z', 'X'):
        need(old['birth_ticks'] == anchor['birth_ticks'], 'runtime_anchor_pid_reused')
    old_live = (old is not None and old['birth_ticks'] == anchor['birth_ticks']
                and old['state'] not in ('Z', 'X'))
    if old_live:
        need(old['uids'] == [anchor['uid']]*4 and old['gids'] == [anchor['gid']]*4
             and old['root_identity'] == anchor['root_identity']
             and old['netns_identity'] == anchor['netns_identity']
             and old['mountinfo_sha256'] == anchor['mountinfo_sha256'],
             'live_anchor_identity_drift')
        before = metadata_reader(metadata_pins, anchor)
        need(before['image'] == anchor['image_digest'], 'installed_image_changed_requires_new_review')
        chain = anchor_ancestry(before['init_pid'], anchor['pid'], old, io, same_process)
        observed = copy.deepcopy(anchor)
        observed['runtime_ancestor_pins'] = {
            path:ancestor_pins(anchor['pid'], path, ancestors, verify)
            for path in anchor['runtime_ancestor_pins']}
        invariant_equal(anchor, observed)
        guard_helpers = SimpleNamespace(verify_runtime_ancestor=verify, stamp=stamp)
        credential_metadata(anchor['pid'], observed, guard_helpers)
        listener = read_peer_listener(io, anchor['pid'], backend_host, observed)
        need(type(listener) is dict and listener.get('netns_identity') == anchor['netns_identity']
             and listener.get('socket_inode') == anchor['backend_listener']['socket_inode']
             and listener.get('port') == 1880 and listener.get('tcp_family') == 'tcp4'
             and listener.get('pid_owns_listener') is True
             and listener.get('backend_ip_local') is True,
             'native_backend_listener_unconfirmed')

        def finish():
            need(metadata_reader(metadata_pins, anchor) == before,
                 'container_metadata_changed_during_observation')
            latest = anchor_ancestry(before['init_pid'], anchor['pid'],
                                     read_process(io, anchor['pid']), io, same_process)
            need(set(latest) == set(chain)
                 and all(same_process(chain[pid], latest[pid]) for pid in chain),
                 'container_ancestry_changed_during_observation')
            need(read_peer_listener(io, anchor['pid'], backend_host, observed) == listener,
                 'listener_read_race')
            need(all(ancestor_pins(anchor['pid'], path, ancestors, verify) == pins
                     for path, pins in observed['runtime_ancestor_pins'].items()),
                 'ancestor_read_race')
            credential_metadata(anchor['pid'], observed, guard_helpers)
        return observed, finish

    before = metadata_reader(metadata_pins, anchor)
    need(before['image'] == anchor['image_digest'], 'installed_image_changed_requires_new_review')
    def listener_snapshot():
        tree = read_process_tree(before['init_pid'])
        identities, terminated = read_process_identities(tree, io)
        candidates = []
        for candidate in list(identities):
            try:
                candidate_inode = read_listener_inode(candidate, anchor)
            except ValueError as error:
                if str(error) == 'process_owned_listener_missing':
                    continue
                if (str(error) in ('transient_process_unavailable', 'listener_fd_read_race')
                        and kernel_proves_process_exited(candidate)):
                    identities.pop(candidate); terminated.add(candidate); continue
                raise
            candidates.append((candidate, candidate_inode))
        need(all(kernel_proves_process_exited(p) for p in terminated),
             'transient_process_unavailable')
        need(len(candidates) == 1, 'unique_descendant_listener_unconfirmed')
        return identities, terminated, candidates[0]

    identities, terminated, selected = listener_snapshot()
    candidates = [selected]
    pid, inode = candidates[0]
    current = identities[pid]
    need(current['state'] not in ('Z','X') and current['uids'] == [anchor['uid']]*4
         and current['gids'] == [anchor['gid']]*4, 'runtime_owner_or_liveness_changed')
    chain = anchor_ancestry(before['init_pid'], pid, current, io, same_process)
    observed = copy.deepcopy(anchor)
    observed.update(pid=pid, birth_ticks=current['birth_ticks'],
                    root_identity=current['root_identity'], netns_identity=current['netns_identity'],
                    mountinfo_sha256=current['mountinfo_sha256'])
    observed['backend_listener']['socket_inode'] = inode
    observed['runtime_ancestor_pins'] = {path:ancestor_pins(pid,path,ancestors,verify)
                                       for path in anchor['runtime_ancestor_pins']}
    invariant_equal(anchor, observed)
    guard_helpers = SimpleNamespace(verify_runtime_ancestor=verify, stamp=stamp)
    credential_metadata(pid, observed, guard_helpers)
    listener = read_peer_listener(io, pid, backend_host, observed)

    def finish():
        need(metadata_reader(metadata_pins, anchor) == before,
             'container_or_descendant_read_race')
        latest_identities, latest_terminated, latest_selected = listener_snapshot()
        need(latest_selected == (pid, inode) and pid in latest_identities
             and same_process(identities[pid], latest_identities[pid])
             and all(kernel_proves_process_exited(p) for p in terminated | latest_terminated)
             and all(kernel_proves_process_exited(p) for p in set(identities) - set(latest_identities)),
             'container_or_descendant_read_race')
        latest_chain = anchor_ancestry(before['init_pid'], pid, read_process(io,pid), io, same_process)
        need(set(latest_chain) == set(chain)
             and all(same_process(chain[p], latest_chain[p]) for p in chain),
             'container_ancestry_changed_during_observation')
        need(read_listener_inode(pid, observed) == inode, 'listener_read_race')
        need(all(ancestor_pins(pid,path,ancestors,verify) == pins
                 for path,pins in observed['runtime_ancestor_pins'].items()),
             'ancestor_read_race')
        credential_metadata(pid, observed, guard_helpers)
        need(read_peer_listener(io, pid, backend_host, observed) == listener, 'listener_read_race')
    return observed, finish
