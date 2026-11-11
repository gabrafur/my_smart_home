import copy
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

import integration_repository as adapter

REPO = "alandtse/alexa_media_player"


class RepositoryAdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.path = self.base / "marketplace.repositories"
        self.value = {"version": 1, "minor_version": 1, "key": self.path.name, "data": {
            "alexa": {"full_name": REPO, "installed": True, "version_installed": "v5.19.0"},
            "other": {"full_name": "other/integration", "installed": True, "sentinel": "keep-before"}}}
        self.write(self.value)

    def write(self, value, path=None):
        target = path or self.path
        target.write_text(json.dumps(value))
        target.chmod(0o644)

    def call(self, mode, **extra):
        return adapter.operate({"repository": REPO, "mode": mode, **extra}, self.base)

    def test_native_is_authoritative_and_read_is_scoped(self):
        legacy = copy.deepcopy(self.value)
        legacy["key"] = "hacs.repositories"
        legacy["data"]["alexa"]["version_installed"] = "v1.0.0"
        self.write(legacy, self.base / "hacs.repositories")
        result = self.call("read")
        self.assertEqual(result["repository_source"], "marketplace")
        self.assertEqual(result["version_installed"], "v5.19.0")
        self.assertNotIn("keep-before", json.dumps(result))
        self.path.unlink()
        self.assertEqual(self.call("read")["repository_source"], "hacs")

    def test_native_invalid_or_missing_identity_never_falls_back(self):
        legacy = copy.deepcopy(self.value);legacy["key"] = "hacs.repositories"
        self.write(legacy, self.base / "hacs.repositories")
        self.write({"key": self.path.name, "data": {}})
        with self.assertRaisesRegex(ValueError, "schema_unreviewed"):
            self.call("read")
        self.value["data"].pop("alexa");self.write(self.value)
        with self.assertRaisesRegex(ValueError, "missing_or_ambiguous"):
            self.call("read")

    def test_ambiguous_uninstalled_and_unknown_repositories_are_rejected(self):
        self.value["data"]["duplicate"] = self.value["data"]["alexa"].copy();self.write(self.value)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            self.call("snapshot")
        self.value["data"].pop("duplicate");self.value["data"]["alexa"]["installed"] = False;self.write(self.value)
        with self.assertRaisesRegex(ValueError, "installation_unconfirmed"):
            self.call("snapshot")
        with self.assertRaisesRegex(ValueError, "not_reviewed"):
            adapter.operate({"repository": "arbitrary/repository", "mode": "read"}, self.base)

    def test_restore_changes_only_own_record_preserving_later_foreign_updates(self):
        before = self.call("snapshot")
        self.value["data"]["alexa"]["version_installed"] = "v5.20.0"
        self.value["data"]["other"]["sentinel"] = "keep-later"
        self.value["data"]["new"] = {"full_name": "new/integration"};self.write(self.value)
        result = self.call("restore", before=before, target="v5.20.0")
        expected = copy.deepcopy(self.value);expected["data"]["alexa"] = before["record"]
        self.assertEqual(json.loads(self.path.read_text()), expected)
        self.assertTrue(result["other_records_preserved"])

    def test_restore_refuses_unrelated_own_version_or_identity(self):
        before = self.call("snapshot")
        self.value["data"]["alexa"]["version_installed"] = "v6.0.0";self.write(self.value)
        raw = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "another_update"):
            self.call("restore", before=before, target="v5.20.0")
        self.assertEqual(self.path.read_bytes(), raw)
        before["repository_id"] = "different"
        with self.assertRaisesRegex(ValueError, "identity_changed"):
            self.call("restore", before=before, target="v5.20.0")

    def test_failed_atomic_replace_preserves_store_and_cleans_only_own_temporary(self):
        before = self.call("snapshot");raw = self.path.read_bytes()
        with patch.object(adapter.os, "replace", side_effect=OSError("fixture failure")):
            with self.assertRaises(OSError):
                self.call("restore", before=before, target="v5.20.0")
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertEqual(list(self.base.glob(".reviewed-repository-*")), [])

    def test_concurrent_store_change_is_not_overwritten(self):
        before = self.call("snapshot")
        fsync = os.fsync
        def concurrent_write(fd):
            self.value["data"]["other"]["sentinel"] = "concurrent"
            self.write(self.value)
            return fsync(fd)
        with patch.object(adapter.os, "fsync", side_effect=concurrent_write):
            with self.assertRaisesRegex(ValueError, "changed_during_restore"):
                self.call("restore", before=before, target="v5.20.0")
        self.assertEqual(json.loads(self.path.read_text())["data"]["other"]["sentinel"], "concurrent")

    def test_symlink_storage_is_rejected(self):
        real = self.base / "real.json";self.path.rename(real);self.path.symlink_to(real)
        with self.assertRaises(OSError):
            self.call("snapshot")

    def test_helper_enforces_address_space_and_cpu_without_cgroup_support(self):
        result = subprocess.run([sys.executable, "-B", "-c",
            "import integration_repository as a,resource,json;a.apply_process_limits();"
            "print(json.dumps([resource.getrlimit(resource.RLIMIT_AS),resource.getrlimit(resource.RLIMIT_CPU)]))"],
            cwd=Path(__file__).parent, capture_output=True, text=True, check=True)
        limits = json.loads(result.stdout)
        self.assertLessEqual(limits[0][0], 128 * 1024 * 1024)
        self.assertLessEqual(limits[1][0], 4)


if __name__ == "__main__":
    unittest.main()
