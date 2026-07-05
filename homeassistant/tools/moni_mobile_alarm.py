#!/usr/bin/env python3
"""Home Assistant command helper for the Moni Mobile alarm integration.

This file intentionally does not print secret values. It is called by
Home Assistant shell_command entries and keeps protocol experiments isolated
from YAML configuration.
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover - Home Assistant normally has PyYAML.
    yaml = None


REQUIRED_SECRETS = (
    "moni_mobile_host",
    "moni_mobile_port",
    "moni_mobile_username",
    "moni_mobile_app_password",
    "moni_mobile_alarm_code",
)


class MoniMobileError(RuntimeError):
    """Raised when the Moni Mobile command cannot be executed."""


def load_secrets() -> dict[str, Any]:
    """Load Home Assistant secrets without exposing their values."""
    secrets_path = Path("/config/secrets.yaml")
    if not secrets_path.exists():
        secrets_path = Path("homeassistant/secrets.yaml")

    if yaml is None:
        raise MoniMobileError("PyYAML nao esta disponivel para ler secrets.yaml")

    data = yaml.safe_load(secrets_path.read_text(encoding="utf-8")) or {}
    missing = [name for name in REQUIRED_SECRETS if name not in data]
    if missing:
        raise MoniMobileError(
            "Secrets ausentes para Moni Mobile: " + ", ".join(missing)
        )
    return data


def tcp_probe(host: str, port: int, timeout: float) -> None:
    """Verify that the proprietary TCP port is reachable."""
    with socket.create_connection((host, port), timeout=timeout):
        return


def run_command(action: str, timeout: float) -> int:
    """Execute an alarm action.

    The public Moni Mobile endpoint uses a proprietary encrypted TCP protocol.
    The helper is wired into Home Assistant now, but refuses to fake success
    until the authenticated command packet is fully implemented.
    """
    secrets = load_secrets()
    host = str(secrets["moni_mobile_host"])
    port = int(secrets["moni_mobile_port"])

    if action == "probe":
        tcp_probe(host, port, timeout)
        print("Moni Mobile TCP acessivel")
        return 0

    tcp_probe(host, port, timeout)
    raise MoniMobileError(
        "Porta TCP Moni Mobile acessivel, mas o pacote autenticado de "
        f"{action} ainda esta em engenharia reversa."
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("probe", "arm_away", "disarm"))
    parser.add_argument("--timeout", type=float, default=8.0)
    args = parser.parse_args()

    try:
        return run_command(args.action, args.timeout)
    except Exception as exc:
        print(f"Erro Moni Mobile: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
