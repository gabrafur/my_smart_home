#!/usr/bin/env python3
"""Report whether the private workstation that hosts the RTX is reachable."""

from __future__ import annotations

import argparse
import socket
import subprocess

from power_control import read_secret


def probe_host(
    host: str | None,
    port: str | None,
    timeout_seconds: float,
) -> str:
    """Return online, offline or unknown without changing the remote host."""
    if not host:
        return "unknown"

    try:
        ping = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, round(timeout_seconds))), host],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 1,
        )
    except (OSError, subprocess.TimeoutExpired):
        ping = None
    if ping is not None and ping.returncode == 0:
        return "online"

    try:
        with socket.create_connection(
            (host, int(port or "22")), timeout=timeout_seconds
        ):
            return "online"
    except (OSError, TypeError, ValueError):
        return "offline" if ping is not None and ping.returncode == 1 else "unknown"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout-seconds", type=float, default=2.0)
    args = parser.parse_args()
    if not 0.2 <= args.timeout_seconds <= 10:
        parser.error("--timeout-seconds must be between 0.2 and 10")

    print(
        probe_host(
            read_secret("pc_power_host"),
            read_secret("pc_power_port", "22"),
            args.timeout_seconds,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
