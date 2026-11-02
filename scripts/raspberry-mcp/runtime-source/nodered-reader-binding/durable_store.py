"""Uninstalled protected receipt store. No directory or policy creation.

The installer, not the MCP caller, supplies sealed paths and lock identities.
No executor, Docker or systemd calls are made in this module.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid

LIMIT = 131072


class Refused(ValueError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_receipt_key')
        result[key] = value
    return result


def directory(path, owner):
    """Pin every ancestor, refusing symlinks or untrusted writable ancestors."""
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'fixed_absolute_directory_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Sticky shared ancestors such as /tmp are permitted only to tests
            # using their non-root owner. Production root never accepts them.
            sticky_test = owner != 0 and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            need(info.st_uid in (0, owner) and (not info.st_mode & 0o022 or sticky_test),
                 'untrusted_state_ancestor')
        info = os.fstat(fd)
        need(info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o700,
             'protected_state_directory_required')
        return fd
    except BaseException:
        os.close(fd)
        raise


class Store:
    """One bounded atomic ledger, own lock plus the reviewed maintenance lock.

    Constructor parameters are internal deployment/test dependencies, never
    deserialized from requests. It does not initialize or reset existing state.
    """
    def __init__(self, state, common_lock, common_identity, owner=0):
        self.state = Path(state)
        self.common_lock = Path(common_lock)
        self.common_identity = tuple(common_identity)
        self.owner = owner
        self.fd = None
        self.lock_fds = []
        self.raw = None
        self.rows = None

    def metadata(self, fd, mode=0o600):
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
             info.st_uid == self.owner and stat.S_IMODE(info.st_mode) == mode,
             'protected_file_identity_required')
        return info

    def _read(self, name, maximum=LIMIT):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            before = self.metadata(fd)
            need(0 < before.st_size <= maximum, 'receipt_size_limit')
            raw = bytearray()
            while len(raw) <= maximum:
                chunk = os.read(fd, min(8192, maximum + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            after = self.metadata(fd)
            fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            need(fields(before) == fields(after) and len(raw) == before.st_size,
                 'receipt_changed_during_read')
            return bytes(raw)
        finally:
            os.close(fd)

    def _acquire(self, fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock_fds.append(fd)
        except BaseException:
            os.close(fd)
            raise

    def assert_locked(self):
        need(self.fd is not None and len(self.lock_fds) == 2, 'protected_locks_required')
        common = self.common_lock.lstat()
        need((common.st_dev, common.st_ino, common.st_uid, common.st_gid,
              stat.S_IMODE(common.st_mode)) == self.common_identity,
             'maintenance_lock_identity_changed')
        current = self.state.lstat()
        held = os.fstat(self.fd)
        need(stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) ==
             (held.st_dev, held.st_ino), 'state_directory_identity_changed')
        own = os.stat('operation.lock', dir_fd=self.fd, follow_symlinks=False)
        held_lock = os.fstat(self.lock_fds[1])
        need((own.st_dev, own.st_ino) == (held_lock.st_dev, held_lock.st_ino),
             'operation_lock_identity_changed')

    @contextlib.contextmanager
    def lock(self):
        need(self.fd is None, 'nested_store_lock_refused')
        self.fd = directory(self.state, self.owner)
        try:
            fd = os.open(self.common_lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            info = os.fstat(fd)
            if not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                    (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                     stat.S_IMODE(info.st_mode)) == self.common_identity):
                os.close(fd)
                raise Refused('maintenance_lock_identity_changed')
            self._acquire(fd)
            fd = os.open('operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW |
                         os.O_NONBLOCK, 0o600, dir_fd=self.fd)
            try:
                self.metadata(fd)
            except BaseException:
                os.close(fd)
                raise
            self._acquire(fd)
            self.assert_locked()
            self.raw = self._read('ledger.json')
            self.rows = [] if self.raw is None else self._decode(self.raw)
            yield self
        finally:
            self.rows = None
            self.raw = None
            for fd in reversed(self.lock_fds):
                os.close(fd)
            self.lock_fds = []
            os.close(self.fd)
            self.fd = None

    @staticmethod
    def _decode(raw):
        data = json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite_receipt')))
        need(type(data) is dict and set(data) == {'schema_version', 'operations'} and
             data['schema_version'] == 1 and type(data['operations']) is list and
             len(data['operations']) <= 64, 'receipt_schema_refused')
        rows = data['operations']
        ids = set()
        for row in rows:
            need(type(row) is dict and type(row.get('id')) is str and
                 re.fullmatch('[a-f0-9]{32}', row['id']) and row['id'] not in ids,
                 'receipt_identity_refused')
            ids.add(row['id'])
        return rows

    def history(self):
        self.assert_locked()
        return json.loads(json.dumps(self.rows))

    def get(self, identifier):
        return next((r for r in self.history() if r['id'] == identifier), None)

    def revoked(self):
        self.assert_locked()
        try:
            info = os.stat('revoked', dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return False
        # Any object at the fixed revocation name closes admission.
        return True

    def revoke(self):
        """Create only the fixed revocation marker while both locks are held."""
        self.assert_locked()
        try:
            fd = os.open('revoked', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.fd)
        except FileExistsError:
            self.assert_locked()
            os.fsync(self.fd)
            return True
        try:
            self.metadata(fd)
            os.fsync(fd)
        finally:
            os.close(fd)
        self.assert_locked()
        os.fsync(self.fd)
        return False

    def save(self, row):
        self.assert_locked()
        rows = self.history()
        found = next((i for i, v in enumerate(rows) if v['id'] == row.get('id')), None)
        if found is None:
            rows.append(row)
        else:
            rows[found] = row
        raw = (json.dumps({'schema_version': 1, 'operations': rows},
                          allow_nan=False, separators=(',', ':')) + '\n').encode()
        need(len(raw) <= LIMIT, 'receipt_size_limit')
        self._decode(raw)
        need(self._read('ledger.json') == self.raw, 'foreign_receipt_change_preserved')
        temporary = '.ledger-' + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                self.metadata(stream.fileno())
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            self.assert_locked()
            need(self._read('ledger.json') == self.raw, 'foreign_receipt_change_preserved')
            os.replace(temporary, 'ledger.json', src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
            self.raw = raw
            self.rows = self._decode(raw)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass
