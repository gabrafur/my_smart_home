#!/usr/bin/env python3
"""Reduce large test output locally before it crosses the Codex tool boundary."""
import os
import signal
import subprocess
import sys

from compact_output import LIMIT, compact_output


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--":
        print("usage: python3 scripts/local-ai/run.py -- COMMAND [ARG ...]", file=sys.stderr)
        return 2
    grouped = os.name == "posix"
    try:
        child = subprocess.Popen(sys.argv[2:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=grouped)
    except OSError as error:
        print(f"local output runner: spawn_failed errno={error.errno}", file=sys.stderr)
        return 127

    def forward(signum, _frame):
        try:
            if grouped:
                os.killpg(child.pid, signum)
            else:
                child.send_signal(signum)
        except ProcessLookupError:
            pass

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), forward)
    buffered = bytearray()
    streaming = False
    for chunk in iter(lambda: child.stdout.read(65536), b""):
        if streaming:
            sys.stdout.buffer.write(chunk)
        else:
            buffered.extend(chunk)
            if len(buffered) > LIMIT:
                streaming = True
                sys.stdout.buffer.write(buffered)
                buffered.clear()
    child.stdout.close()
    code = child.wait()
    if not streaming:
        raw = bytes(buffered)
        try:
            output = compact_output(raw)["output"]
        except Exception:
            output = raw  # A formatter failure must never hide command output.
        sys.stdout.buffer.write(output)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
