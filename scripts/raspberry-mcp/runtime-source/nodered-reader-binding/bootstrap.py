"""Sealed native bootstrap. Stdlib only until every approved byte is checked.

The systemd command must pin this file's hash AND the expected policy hash.
No path, digest, role or code is taken from an MCP request or environment.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

LIB = Path('/usr/local/lib/raspberry-nodered-binding')
FILES = ('bootstrap.py', 'controller.py', 'durable_store.py', 'native_manager.py',
         'runtime.py', 'server.py', 'client.py', 'broker.py')
MODULES = (('controller.py', 'controller'), ('durable_store.py', 'durable_store'),
           ('native_manager.py', 'native_manager'), ('runtime.py', 'binding_runtime'),
           ('client.py', 'binding_client'))


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_binding_policy_key')
        result[key] = value
    return result


def library_fd(path, owner=0):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'fixed_library_path_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Only unprivileged tests may traverse sticky /tmp ancestors.
            test_sticky = owner != 0 and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            need(info.st_uid in (0, owner) and not (info.st_mode & 0o022 and not test_sticky),
                 'protected_library_ancestor_required')
        info = os.fstat(fd)
        need(info.st_uid == info.st_gid == owner and stat.S_IMODE(info.st_mode) == 0o755,
             'protected_binding_library_required')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_at(parent, name, owner=0, maximum=65536):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
             before.st_uid == before.st_gid == owner and stat.S_IMODE(before.st_mode) == 0o644
             and 0 < before.st_size <= maximum, 'protected_binding_file_required')
        raw = bytearray()
        while len(raw) <= maximum:
            part = os.read(fd, min(8192, maximum + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        after = os.fstat(fd)
        fields = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        need(fields(before) == fields(after) and len(raw) == before.st_size,
             'binding_file_changed_during_read')
        return bytes(raw)
    finally:
        os.close(fd)


def verify_bundle(path, expected_policy, owner=0):
    need(type(expected_policy) is str and re.fullmatch('[a-f0-9]{64}', expected_policy),
         'unit_pinned_policy_hash_required')
    fd = library_fd(path, owner)
    try:
        need(set(os.listdir(fd)) == set(FILES) | {'approval.json'},
             'unexpected_binding_library_entry')
        raw = read_at(fd, 'approval.json', owner, maximum=32768)
        need(hashlib.sha256(raw).hexdigest() == expected_policy, 'unit_pinned_policy_hash_changed')
        policy = json.loads(raw, object_pairs_hook=unique)
        hashes = policy.get('source_hashes') if type(policy) is dict else None
        need(type(hashes) is dict and set(hashes) == set(FILES), 'binding_source_scope_changed')
        sources = {}
        for name in FILES:
            need(type(hashes[name]) is str and re.fullmatch('[a-f0-9]{64}', hashes[name]),
                 'binding_source_hash_required')
            content = read_at(fd, name, owner)
            need(hashlib.sha256(content).hexdigest() == hashes[name],
                 'binding_source_hash_changed_before_import')
            sources[name] = content
        return policy, sources
    finally:
        os.close(fd)


def verified_modules(sources, policy_digest):
    """Execute the verified buffers, never Python's on-disk import/pyc cache."""
    modules = {}
    for filename, name in MODULES:
        module = types.ModuleType(name)
        module.__file__ = str(LIB / filename)
        module.__package__ = ''
        module.__cached__ = None
        sys.modules[name] = module
        exec(compile(sources[filename], module.__file__, 'exec'), module.__dict__)
        modules[name] = module
    modules['binding_runtime']._BOOT_POLICY_SHA256 = policy_digest
    return modules


def execute_entry(role, sources, modules, policy):
    filename = 'server.py' if role == 'server' else 'broker.py'
    scope = {'__name__': '__main__', '__file__': str(LIB / filename),
             '__package__': '', '__cached__': None,
             '_BOOT_RUNTIME': modules['binding_runtime'],
             '_BOOT_CLIENT': modules['binding_client'], '_BOOT_POLICY': policy}
    exec(compile(sources[filename], scope['__file__'], 'exec'), scope)


def main():
    need(Path(__file__) == LIB / 'bootstrap.py', 'sealed_binding_bootstrap_entrypoint_required')
    need(len(sys.argv) == 3 and sys.argv[1] in ('server', 'broker'), 'fixed_binding_bootstrap_role_required')
    role, expected = sys.argv[1:]
    need(os.geteuid() == (0 if role == 'server' else 1001), 'binding_bootstrap_uid_refused')
    policy, sources = verify_bundle(LIB, expected)
    modules = verified_modules(sources, expected)
    # Full semantic policy validation also runs before the chosen entrypoint.
    modules['binding_runtime'].load_policy()
    execute_entry(role, sources, modules, policy)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        os.write(1, b'{"state":"unavailable","collection_error":"binding_sealed_bootstrap_unconfirmed","automatic_retry":false}\n')
        raise SystemExit(1)
