"""Tests for the side-effect-free RTX workstation reachability probe."""

from pathlib import Path
import importlib.util
import io
import json
from contextlib import redirect_stdout
from datetime import datetime
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location(
    "rtx_host_reachability", TOOLS / "rtx_host_reachability.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RtxHostReachabilityTest(unittest.TestCase):
    """Classify reachability without waking or mutating the workstation."""

    @patch.object(MODULE, "read_secret", return_value="host.test")
    @patch.object(MODULE, "probe_host", return_value="online")
    def test_json_observation_keeps_plain_cli_compatible(self, probe, secret):
        for args in [[], ["--json"]]:
            output = io.StringIO()
            with patch.object(sys, "argv", ["probe", *args]), redirect_stdout(output):
                self.assertEqual(MODULE.main(), 0)
            if args:
                payload = json.loads(output.getvalue())
                self.assertEqual(payload["state"], "online")
                self.assertIsNotNone(datetime.fromisoformat(payload["collected_at"]).tzinfo)
            else:
                self.assertEqual(output.getvalue(), "online\n")

    def test_missing_host_is_unknown(self) -> None:
        self.assertEqual(MODULE.probe_host(None, "22", 1), "unknown")

    @patch.object(MODULE.socket, "create_connection")
    @patch.object(MODULE.subprocess, "run")
    def test_ping_success_is_online(self, run: MagicMock, connect: MagicMock) -> None:
        run.return_value = MagicMock(returncode=0)

        self.assertEqual(MODULE.probe_host("host.test", "22", 1), "online")
        connect.assert_not_called()

    @patch.object(MODULE.socket, "create_connection")
    @patch.object(MODULE.subprocess, "run")
    def test_ssh_fallback_can_confirm_online(
        self, run: MagicMock, connect: MagicMock
    ) -> None:
        run.return_value = MagicMock(returncode=1)
        connect.return_value.__enter__.return_value = object()

        self.assertEqual(MODULE.probe_host("host.test", "22", 1), "online")

    @patch.object(MODULE.socket, "create_connection", side_effect=OSError)
    @patch.object(MODULE.subprocess, "run")
    def test_confirmed_probe_failures_are_offline(
        self, run: MagicMock, _connect: MagicMock
    ) -> None:
        run.return_value = MagicMock(returncode=1)

        self.assertEqual(MODULE.probe_host("host.test", "22", 1), "offline")

    @patch.object(MODULE.socket, "create_connection", side_effect=OSError)
    @patch.object(
        MODULE.subprocess,
        "run",
        side_effect=subprocess.TimeoutExpired("ping", 1),
    )
    def test_unavailable_probe_mechanisms_are_unknown(
        self, _run: MagicMock, _connect: MagicMock
    ) -> None:
        self.assertEqual(MODULE.probe_host("host.test", "22", 1), "unknown")


if __name__ == "__main__":
    unittest.main()
