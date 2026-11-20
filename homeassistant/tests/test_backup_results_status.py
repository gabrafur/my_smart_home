"""Git, offsite copy and tested restoration stay three separate results."""

from __future__ import annotations

import importlib.util
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "tools" / "backup_results_status.py"
SPEC = importlib.util.spec_from_file_location("backup_results_status", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
NOW = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)


class BackupResultsStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.git = base / "git"
        self.offsite = base / "offsite"
        self.original = dict(MODULE.SOURCES)
        MODULE.SOURCES.update(git=self.git, offsite=self.offsite)

    def tearDown(self) -> None:
        MODULE.SOURCES.clear()
        MODULE.SOURCES.update(self.original)
        self.tmp.cleanup()

    def test_git_success_is_confirmed_with_age_and_freshness(self) -> None:
        self.git.write_text("request_id=x\nstatus=success\nexit_code=0\nreason=none\nfinished_at=2026-11-20T04:00:06Z\n")
        row = MODULE.result("git", NOW)
        self.assertEqual(row["state"], "confirmed")
        self.assertEqual(row["last_attempt_at"], row["last_confirmed_at"])
        self.assertEqual(row["age_seconds"], 8 * 3600 - 6)
        self.assertEqual(row["freshness"], "fresh")
        self.assertNotIn("request_id", row)

    def test_failure_keeps_attempt_without_inventing_a_confirmation(self) -> None:
        self.git.write_text("status=failed\nreason=validation_failed\nfinished_at=2026-11-18T04:00:06Z\n")
        row = MODULE.result("git", NOW)
        self.assertEqual((row["state"], row["reason"], row["last_confirmed_at"]), ("failed", "validation_failed", None))
        self.assertEqual(row["freshness"], "stale")

    def test_offsite_needs_remote_verification_to_count_as_confirmed(self) -> None:
        line = "host-update stage=offsite-backup status=success finished_at=2026-11-20T04:02:35Z reason=completed remote_verified={}"
        self.offsite.write_text(line.format("true"))
        self.assertEqual(MODULE.result("offsite", NOW)["state"], "confirmed")
        self.offsite.write_text(line.format("false"))
        row = MODULE.result("offsite", NOW)
        self.assertEqual((row["state"], row["last_confirmed_at"]), ("unconfirmed", None))

    def test_restore_is_unknown_never_implied_by_backup_success(self) -> None:
        self.git.write_text("status=success\nfinished_at=2026-11-20T04:00:06Z\n")
        row = MODULE.result("restore", NOW)
        self.assertEqual((row["state"], row["reason"], row["freshness"]), ("unknown", "no_restore_evidence", "unknown"))

    def test_missing_invalid_or_future_results_are_unknown(self) -> None:
        self.assertEqual(MODULE.result("git", NOW)["reason"], "result_unreadable")
        self.git.write_text("status=success\nfinished_at=not-a-date\n")
        self.assertEqual(MODULE.result("git", NOW)["reason"], "result_invalid")
        self.git.write_text(f"status=success\nfinished_at={(NOW + timedelta(minutes=5)).isoformat()}\n")
        self.assertEqual(MODULE.result("git", NOW)["state"], "unknown")

    def test_package_and_dashboard_consume_the_producer_without_local_thresholds(self) -> None:
        package = (ROOT / "packages" / "backup_results.yaml").read_text()
        self.assertEqual(re.findall(r"unique_id: (\S+)", package),
                         ["backup_result_git", "backup_result_offsite", "backup_result_restore"])
        attributes = re.findall(r"^        - (\S+)$", package, re.M)
        self.assertEqual(attributes.count("freshness"), 3)
        self.assertEqual(attributes.count("last_confirmed_at"), 3)
        # Per-poll values would write a recorder row every 5 min.
        self.assertNotIn("age_seconds", attributes)
        self.assertNotIn("checked_at", attributes)
        dashboard = (ROOT / "dashboards" / "sistema.yaml").read_text()
        for entity in ("sensor.backup_result_git", "sensor.backup_result_offsite", "sensor.backup_result_restore"):
            self.assertIn(entity, dashboard)
        self.assertNotIn("93600", dashboard)
        self.assertNotIn("FRESH", dashboard)


if __name__ == "__main__":
    unittest.main()
