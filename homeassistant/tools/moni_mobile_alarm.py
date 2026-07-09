#!/usr/bin/env python3
"""Home Assistant command helper for the Moni Mobile alarm integration.

This file intentionally does not print secret values. It is called by
Home Assistant shell_command entries and keeps protocol experiments isolated
from YAML configuration.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

CLIENT_DIRS = (
    Path("/config/custom_components/moni_mobile"),
    Path("homeassistant/custom_components/moni_mobile"),
)
for client_dir in CLIENT_DIRS:
    if client_dir.exists():
        sys.path.insert(0, str(client_dir))
        break

from client import MoniMobileClient  # noqa: E402

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
_RAW_ALARM_CODE_RE = re.compile(
    r"^\s*moni_mobile_alarm_code:\s*(?P<value>[^#\r\n]+?)\s*(?:#.*)?$",
    re.MULTILINE,
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
    raw_alarm_code = _read_raw_alarm_code(secrets_path, data["moni_mobile_alarm_code"])
    data["moni_mobile_alarm_code"] = raw_alarm_code
    return data


def _read_raw_alarm_code(secrets_path: Path, fallback: Any) -> str:
    """Read the alarm code preserving leading zeros from secrets.yaml."""
    match = _RAW_ALARM_CODE_RE.search(secrets_path.read_text(encoding="utf-8"))
    if not match:
        return str(fallback)

    value = match.group("value").strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    return value


def run_command(action: str, timeout: float) -> int:
    """Execute an alarm action."""
    secrets = load_secrets()
    client = MoniMobileClient(
        host=str(secrets["moni_mobile_host"]),
        port=int(secrets["moni_mobile_port"]),
        username=str(secrets["moni_mobile_username"]),
        app_password=str(secrets["moni_mobile_app_password"]),
        alarm_code=str(secrets["moni_mobile_alarm_code"]),
        timeout=timeout,
    )

    if action == "probe":
        client.probe()
        print("Moni Mobile TCP acessivel")
        return 0
    if action == "state":
        print(client.get_state() or "unknown")
        return 0
    if action == "arm_away":
        client.arm_away()
        print("Comando de armar enviado")
        return 0
    if action == "disarm":
        client.disarm()
        print("Comando de desarmar enviado")
        return 0

    raise MoniMobileError(f"Acao desconhecida: {action}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("probe", "state", "arm_away", "disarm"))
    parser.add_argument("--timeout", type=float, default=8.0)
    args = parser.parse_args()

    try:
        return run_command(args.action, args.timeout)
    except Exception as exc:
        print(f"Erro Moni Mobile: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
