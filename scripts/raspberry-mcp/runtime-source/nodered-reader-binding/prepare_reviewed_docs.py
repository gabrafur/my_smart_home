"""Build a receipt for three exact, committed public documents; no writes."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

ROOT = Path('/mnt/data/docker')
FILES = ('docs/raspberry-mcp/README.md', 'docs/raspberry-mcp/tools.md',
         'docs/raspberry-mcp/reference/nodered-reader-binding.md')
MAX_BYTES = 256 * 1024


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def git(root, arguments, limit=MAX_BYTES):
    """Bound subprocess time and bytes; no shell, inherited config or network."""
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'HOME': '/nonexistent',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0',
           'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1'}
    proc = subprocess.Popen(['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', str(root), *arguments],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=env, close_fds=True)
    output = bytearray()
    deadline = time.monotonic() + 5
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                need(remaining > 0, 'git_timeout')
                need(selector.select(remaining), 'git_timeout')
                chunk = os.read(proc.stdout.fileno(), min(8192, limit + 1 - len(output)))
                if not chunk:
                    selector.unregister(proc.stdout)
                    break
                output.extend(chunk)
                need(len(output) <= limit, 'git_output_limit')
        need(proc.wait(timeout=max(.001, deadline - time.monotonic())) == 0, 'git_failed')
        return bytes(output)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)
        proc.stdout.close()


def checked_file(root, relative):
    """Traverse from / with directory FDs; refuse symlinks in all ancestors."""
    root = Path(root)
    need(root.is_absolute() and '..' not in root.parts and relative in FILES, 'fixed_path_required')
    parts = (*root.parts[1:], *Path(relative).parts)
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= MAX_BYTES,
                 'unsafe_document')
            chunks = bytearray()
            while len(chunks) <= MAX_BYTES:
                chunk = os.read(fd, min(8192, MAX_BYTES + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            after = os.fstat(fd)
            identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            need(len(chunks) == before.st_size and identity(before) == identity(after), 'document_changed')
            need(b'\0' not in chunks, 'document_contains_nul')
            bytes(chunks).decode('utf-8')
            return bytes(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def build(reviewed_head, *, root=ROOT, git_runner=git, clock=None):
    need(type(reviewed_head) is str and re.fullmatch('[a-f0-9]{40}', reviewed_head), 'reviewed_head_invalid')
    branch = git_runner(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 128)
    head = git_runner(root, ['rev-parse', '--verify', 'HEAD'], 128)
    origin = git_runner(root, ['rev-parse', '--verify', 'refs/remotes/origin/main'], 128)
    need(branch == b'main\n' and head == (reviewed_head + '\n').encode()
         and origin == head, 'reviewed_main_head_mismatch')
    files = {}
    for relative in FILES:
        raw = checked_file(root, relative)
        committed = git_runner(root, ['show', 'HEAD:' + relative], MAX_BYTES)
        need(raw == committed, 'document_differs_from_reviewed_commit')
        files[relative] = hashlib.sha256(raw).hexdigest()
    need(git_runner(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 128) == branch and
         git_runner(root, ['rev-parse', '--verify', 'HEAD'], 128) == head and
         git_runner(root, ['rev-parse', '--verify', 'refs/remotes/origin/main'], 128) == origin,
         'reviewed_main_head_changed')
    observed = (clock or (lambda: datetime.datetime.now(datetime.timezone.utc)))()
    need(isinstance(observed, datetime.datetime) and observed.tzinfo is not None, 'observation_clock_invalid')
    observed = observed.astimezone(datetime.timezone.utc).replace(microsecond=0)
    return {'schema_version': 1, 'source': 'reviewed_public_MCP_docs_v1',
            'public_head': reviewed_head, 'observed_at': observed.isoformat().replace('+00:00', 'Z'),
            'files': files}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reviewed-head', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.reviewed_head), separators=(',', ':')))


if __name__ == '__main__':
    main()
