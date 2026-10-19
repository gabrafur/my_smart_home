#!/usr/bin/env python3
"""Fixed stdio-to-Unix relay for tunnel-client; no target/command arguments."""
import os
import selectors
import socket
import sys


def main():
    if len(sys.argv) != 1:
        sys.exit('arguments_not_allowed')
    os.environ.clear()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(120)
        connection.connect('/run/raspberry-mcp/mcp.sock')
        with selectors.DefaultSelector() as ready:
            ready.register(sys.stdin.buffer, selectors.EVENT_READ)
            ready.register(connection, selectors.EVENT_READ)
            while True:
                events = ready.select(timeout=120)
                if not events:
                    return
                for key, _ in events:
                    if key.fileobj is connection:
                        data = connection.recv(16384)
                        if not data:
                            return
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        data = os.read(sys.stdin.fileno(), 16384)
                        if not data:
                            connection.shutdown(socket.SHUT_WR)
                            ready.unregister(sys.stdin.buffer)
                        else:
                            connection.sendall(data)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        sys.stderr.write('local_mcp_unavailable\n')
        sys.exit(1)
