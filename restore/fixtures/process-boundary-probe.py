import ctypes
import errno
import json
import mmap
import os
import resource
import signal
import threading

limit = 64 * 1024 * 1024
assert resource.getrlimit(resource.RLIMIT_AS) == (limit, limit)
assert resource.getrlimit(resource.RLIMIT_CPU) == (60, 60)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
assert resource.getrlimit(resource.RLIMIT_NOFILE) == (128, 128)
assert os.geteuid() != 0
with open("/proc/self/limits") as source:
    native_limit = next(line for line in source if line.startswith("Max address space")).split()
assert native_limit[3:5] == [str(limit), str(limit)] and native_limit[5] == "bytes"

def denied_fork():
    try:
        pid = os.fork()
    except OSError as e:
        assert e.errno == errno.EPERM
        return True
    if pid == 0:
        os._exit(91)
    os.waitpid(pid, 0)
    raise AssertionError("fork escaped boundary")

assert denied_fork()
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
machine = os.uname().machine
clone = {"aarch64": 220, "x86_64": 56}[machine]
def denied_clone(flags):
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(clone), ctypes.c_ulong(flags),
                          ctypes.c_void_p(), ctypes.c_void_p(),
                          ctypes.c_void_p(), ctypes.c_void_p())
    assert result == -1 and ctypes.get_errno() == errno.EPERM

denied_clone(signal.SIGCHLD)
denied_clone(0x100 | signal.SIGCHLD)  # Shared VM without CLONE_THREAD is forbidden.
denied_clone(1 << 32)  # No high flags outside the audited pthread ABI.
for syscall, expected in [(435, errno.ENOSYS), (425, errno.EPERM)]:
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(syscall), ctypes.c_void_p(), ctypes.c_ulong(0))
    assert result == -1 and ctypes.get_errno() == expected

try:
    resource.setrlimit(resource.RLIMIT_AS, (limit * 2, limit * 2))
except (ValueError, PermissionError):
    pass
else:
    raise AssertionError("hard ceiling was raised")
try:
    mmap.mmap(-1, limit + 4096)
except (OSError, MemoryError):
    pass
else:
    raise AssertionError("oversized mapping succeeded")

ready, allocate, mapped, release = [threading.Event() for _ in range(4)]
errors = []
def worker():
    try:
        denied_clone(signal.SIGCHLD)
        ready.set()
        assert allocate.wait(5)
        with mmap.mmap(-1, 8 * 1024 * 1024):
            mapped.set()
            assert release.wait(5)
    except BaseException as e:
        errors.append(type(e).__name__)
        ready.set(); mapped.set()

thread = threading.Thread(target=worker)
thread.start()
assert ready.wait(5) and not errors
assert len(os.listdir("/proc/self/task")) >= 2
with open("/proc/self/status") as source:
    status = dict(line.split(":", 1) for line in source if ":" in line)
baseline = int(status["VmSize"].split()[0]) * 1024
attempt = limit - baseline - 4 * 1024 * 1024
assert attempt > 0
allocate.set()
assert mapped.wait(5) and not errors
try:
    mmap.mmap(-1, attempt)
except (OSError, MemoryError):
    pass
else:
    raise AssertionError("thread mapping was excluded from the shared ceiling")
release.set(); thread.join(5)
assert not thread.is_alive() and not errors
with mmap.mmap(-1, attempt):
    pass
assert int(status["NoNewPrivs"]) == 1 and int(status["Seccomp"]) == 2
assert int(status["Seccomp_filters"]) >= 1
print(json.dumps({"schema_version": 1, "scope": "process_boundary_probe_not_restore",
    "hard_AS_bytes": limit, "shared_thread_mapping_enforced": True,
    "valid_threads_started": True, "fork_denied": True, "nonthread_clone_denied": True,
    "clone3_denied_with_fallback": True, "child_creation_denied_in_thread": True,
    "hard_ceiling_cannot_be_raised": True, "oversized_mapping_refused": True,
    "io_uring_denied": True, "seccomp_filters": int(status["Seccomp_filters"]),
    "restored_services_started": 0, "backup_key_reads": 0}))
