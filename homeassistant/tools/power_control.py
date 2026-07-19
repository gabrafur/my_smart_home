#!/usr/bin/env python3
"""Power controls used by Home Assistant shell_command."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path


SECRETS_PATH = Path("/config/secrets.yaml")
SYSTEMD_DESTINATION = "org.freedesktop.systemd1"
SYSTEMD_PATH = "/org/freedesktop/systemd1"
SYSTEMD_INTERFACE = "org.freedesktop.systemd1.Manager"


def raspberry_power(action: str, *, dry_run: bool = False, check_only: bool = False) -> None:
    method = "Reboot" if action == "reboot" else "PowerOff"
    dbus_method = "reboot" if action == "reboot" else "power_off"
    if dry_run:
        print(f"DBus {SYSTEMD_INTERFACE}.{method}()")
        return

    script = f"""
import asyncio
from dbus_fast import BusType
from dbus_fast.aio import MessageBus

async def main():
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    introspection = await bus.introspect("{SYSTEMD_DESTINATION}", "{SYSTEMD_PATH}")
    proxy = bus.get_proxy_object("{SYSTEMD_DESTINATION}", "{SYSTEMD_PATH}", introspection)
    manager = proxy.get_interface("{SYSTEMD_INTERFACE}")
    properties = proxy.get_interface("org.freedesktop.DBus.Properties")
    state = await properties.call_get("{SYSTEMD_INTERFACE}", "SystemState")
    if {check_only!r}:
        print(f"SystemState: {{state.value}}")
        return
    await manager.call_{dbus_method}()

asyncio.run(main())
"""
    subprocess.run(["python3", "-c", script], check=True)


def read_secret(name: str, default: str | None = None) -> str | None:
    if not SECRETS_PATH.exists():
        return default
    pattern = re.compile(rf"^\s*{re.escape(name)}:\s*(?P<value>[^#\r\n]+?)\s*(?:#.*)?$")
    for line in SECRETS_PATH.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            return match.group("value").strip().strip("'\"")
    return default


def pc_power(action: str, *, dry_run: bool = False) -> None:
    host = read_secret("pc_power_host")
    user = read_secret("pc_power_user")
    port = read_secret("pc_power_port", "22")
    os_type = (read_secret("pc_power_os", "windows") or "windows").lower()
    key_path = read_secret("pc_power_ssh_key", "/config/.ssh/ha_power_ed25519")

    missing = [name for name, value in {"pc_power_host": host, "pc_power_user": user}.items() if not value]
    if missing:
        raise RuntimeError(f"Missing secrets: {', '.join(missing)}")

    if os_type == "windows":
        remote_command = "shutdown /r /t 0" if action == "reboot" else "shutdown /s /t 0"
    elif os_type == "linux":
        remote_command = "sudo /sbin/reboot" if action == "reboot" else "sudo /sbin/poweroff"
    else:
        raise RuntimeError(f"Unsupported pc_power_os: {os_type}")

    ssh_command = [
        "ssh",
        "-i",
        key_path,
        "-p",
        str(port),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=accept-new",
        f"{user}@{host}",
        remote_command,
    ]
    if dry_run:
        print(" ".join(ssh_command))
        return
    subprocess.run(ssh_command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=("raspberry", "pc"))
    parser.add_argument("action", choices=("reboot", "poweroff"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    try:
        if args.target == "raspberry":
            raspberry_power(args.action, dry_run=args.dry_run, check_only=args.check_only)
        else:
            if args.check_only:
                raise RuntimeError("--check-only is only supported for raspberry")
            pc_power(args.action, dry_run=args.dry_run)
    except Exception as exc:
        print(f"power_control error: {exc}", file=sys.stderr)
        return 1
    time.sleep(0.2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
