"""Regression tests for the Recorder retention readiness sensor."""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "tools" / "recorder_retention_status.py"
SPEC = importlib.util.spec_from_file_location("recorder_retention_status", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecorderRetentionStatusTest(unittest.TestCase):
    """The readiness cutoff must remain fixed at the cycle start."""

    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.executescript(
            """
            CREATE TABLE states_meta (metadata_id INTEGER PRIMARY KEY, entity_id TEXT);
            CREATE TABLE states (
                state_id INTEGER PRIMARY KEY,
                metadata_id INTEGER,
                state TEXT,
                last_updated_ts REAL
            );
            """
        )
        self.cycle_started_at = 1_800_000_000
        self.connection.executemany(
            "INSERT INTO states_meta(metadata_id, entity_id) VALUES (?, ?)",
            [
                (1, MODULE.CYCLE_ENTITY_ID),
                (2, "sensor.vehicle_primary_refresh_coordinator"),
            ],
        )
        self.connection.execute(
            "INSERT INTO states VALUES (?, ?, ?, ?)",
            (1, 1, str(self.cycle_started_at), self.cycle_started_at),
        )

    def tearDown(self) -> None:
        self.connection.close()

    def test_reads_persisted_cycle_marker(self) -> None:
        self.assertEqual(MODULE.read_cycle_started_at(self.connection), self.cycle_started_at)

    def test_reports_raw_space_without_embedding_repack_policy(self) -> None:
        metrics = MODULE.database_space_metrics(self.connection)
        self.assertGreater(metrics["database_bytes"], 0)
        self.assertGreaterEqual(metrics["reclaimable_bytes"], 0)
        self.assertGreaterEqual(metrics["reclaimable_percent"], 0)
        self.assertNotIn("repack_recommended", metrics)

    def test_rows_eligible_at_cycle_start_block_readiness(self) -> None:
        cutoff = self.cycle_started_at - 2 * 24 * 60 * 60
        self.connection.execute("INSERT INTO states VALUES (?, ?, ?, ?)", (2, 2, "old", cutoff - 1))
        self.assertTrue(
            MODULE.target_has_pending(
                self.connection,
                2,
                "sm.entity_id IN ({})",
                ("sensor.vehicle_primary_refresh_coordinator",),
                self.cycle_started_at,
            )
        )

    def test_rows_crossing_retention_after_start_do_not_extend_cycle(self) -> None:
        cutoff = self.cycle_started_at - 2 * 24 * 60 * 60
        self.connection.execute("INSERT INTO states VALUES (?, ?, ?, ?)", (2, 2, "later", cutoff + 60))
        self.assertFalse(
            MODULE.target_has_pending(
                self.connection,
                2,
                "sm.entity_id IN ({})",
                ("sensor.vehicle_primary_refresh_coordinator",),
                self.cycle_started_at,
            )
        )


if __name__ == "__main__":
    unittest.main()
