"""Keep service failure distinct from Home Assistant transport sentinels."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

SOURCE = Path(__file__).resolve().parents[1] / "tools" / "codex_rtx_live.py"
SPEC = importlib.util.spec_from_file_location("rtx_live_helper_fixture", SOURCE)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class LiveStateTest(unittest.TestCase):
    def collect(self, local):
        body = io.StringIO(json.dumps({"local_ai": local}))
        output = io.StringIO()
        with patch.object(HELPER.urllib.request, "urlopen", return_value=body), contextlib.redirect_stdout(output):
            HELPER.main()
        result = json.loads(output.getvalue())
        self.assertIn("collected_at", result)
        return result

    def test_current_service_failure_is_not_missing_sensor_data(self):
        result = self.collect({"available": False, "preflight": {"state": "LOCAL_AI_UNAVAILABLE"},
                               "freshness": {"preflight": {"current": True}}})
        self.assertEqual(result["state"], "service_unavailable")
        self.assertTrue(result["preflight_current"])

    def test_available_remains_available(self):
        self.assertEqual(self.collect({"available": True})["state"], "available")

    def test_current_job_remains_in_use(self):
        self.assertEqual(self.collect({"current_job": {"task": "fixture"}})["state"], "in_use")

    def test_old_preflight_is_stale(self):
        self.assertEqual(self.collect({"available": False, "preflight": {"state": "LOCAL_AI_UNAVAILABLE"},
                                       "freshness": {"preflight": {"current": False}}})["state"], "stale")

    def test_service_failure_does_not_invent_idle_gpu_samples(self):
        result = self.collect({"preflight": {"state": "LOCAL_AI_UNAVAILABLE"},
                               "freshness": {"preflight": {"current": True}}})
        for key in ("gpu_util_percent", "vram_mib", "power_watts"):
            self.assertIsNone(result[key])

    def test_collection_failure_remains_error(self):
        output = io.StringIO()
        with patch.object(HELPER.urllib.request, "urlopen", side_effect=urllib.error.URLError("fixture")), contextlib.redirect_stdout(output):
            HELPER.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result["state"], "error")
        self.assertIn("collected_at", result)


if __name__ == "__main__":
    unittest.main()
