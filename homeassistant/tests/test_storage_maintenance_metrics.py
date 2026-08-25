import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "tools" / "raspberry_pi_health.py"
SPEC = importlib.util.spec_from_file_location("raspberry_pi_health", MODULE_PATH)
assert SPEC and SPEC.loader
HEALTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEALTH)


class StorageMaintenanceMetricsTests(unittest.TestCase):
    def test_reads_only_expected_non_sensitive_schema_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "status.json"
            status.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "filesystem_total_bytes": 1000,
                        "filesystem_used_bytes": 400,
                        "filesystem_free_bytes": 600,
                        "filesystem_used_percent": 40,
                        "inodes_total": 100,
                        "inodes_used": 10,
                        "docker_logical_bytes": 200,
                        "docker_images_logical_bytes": 180,
                        "docker_unused_tagged_logical_bytes": 80,
                        "docker_unused_untagged_logical_bytes": 10,
                        "known_logs_bytes": 20,
                        "repository_bytes": 300,
                        "vscode_server_logical_bytes": 400,
                        "cursor_server_logical_bytes": 0,
                        "npm_cache_logical_bytes": 30,
                        "allowlisted_user_caches_logical_bytes": 60,
                        "pm2_logs_logical_bytes": 7,
                        "home_assistant_recorder_logical_bytes": 500,
                        "home_assistant_backups_logical_bytes": 600,
                        "deleted_open_bytes": 0,
                        "deleted_open_count": 0,
                        "deleted_open_scan_complete": False,
                        "last_reclaimed_bytes": 50,
                        "last_filesystem_net_reclaimed_bytes": 50,
                        "last_reclaimed_by_category": {
                            "npm-cache": 40,
                            "private-category": 999,
                        },
                        "last_maintenance_at": "2026-08-25T13:00:00Z",
                        "phase2_last_maintenance_at": "2026-08-25T14:00:00Z",
                        "last_result": "success",
                        "unapproved_field": "must-not-be-forwarded",
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(HEALTH, "STORAGE_MAINTENANCE_STATUS_PATH", status):
                metrics = HEALTH.storage_maintenance_metrics()

        self.assertEqual(metrics["storage_maintenance_docker_logical_bytes"], 200)
        self.assertEqual(metrics["storage_maintenance_vscode_server_logical_bytes"], 400)
        self.assertEqual(metrics["storage_maintenance_cursor_server_logical_bytes"], 0)
        self.assertFalse(metrics["storage_maintenance_deleted_open_scan_complete"])
        self.assertEqual(
            metrics["storage_maintenance_last_reclaimed_by_category"],
            {"npm-cache": 40},
        )
        self.assertEqual(metrics["storage_maintenance_phase2_last_at"], "2026-08-25T14:00:00Z")
        self.assertEqual(metrics["storage_maintenance_last_result"], "success")
        self.assertNotIn("unapproved_field", metrics)

    def test_invalid_or_missing_status_is_unavailable_without_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "missing.json"
            with patch.object(HEALTH, "STORAGE_MAINTENANCE_STATUS_PATH", status):
                missing = HEALTH.storage_maintenance_metrics()
            status.write_text('{"schema_version":2,"docker_logical_bytes":1}', encoding="utf-8")
            with patch.object(HEALTH, "STORAGE_MAINTENANCE_STATUS_PATH", status):
                incompatible = HEALTH.storage_maintenance_metrics()

        self.assertIsNone(missing["storage_maintenance_docker_logical_bytes"])
        self.assertIsNone(incompatible["storage_maintenance_docker_logical_bytes"])


if __name__ == "__main__":
    unittest.main()
