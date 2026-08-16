#!/usr/bin/env python3
"""Small offline checks for input bounding and conservative model selection."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("local_ai", SCRIPT_DIR / "local-ai.py")
assert SPEC and SPEC.loader
LOCAL_AI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCAL_AI)

TELEMETRY_SPEC = importlib.util.spec_from_file_location("local_ai_telemetry", SCRIPT_DIR / "telemetry.py")
assert TELEMETRY_SPEC and TELEMETRY_SPEC.loader
TELEMETRY = importlib.util.module_from_spec(TELEMETRY_SPEC)
TELEMETRY_SPEC.loader.exec_module(TELEMETRY)


class LocalAiTest(unittest.TestCase):
    def test_prefers_supported_small_code_model(self):
        models = [
            {"name": "large-coder:32b", "size": 20_000_000_000},
            {"name": "qwen3:8b", "size": 5_000_000_000},
            {"name": "qwen2.5-coder:7b", "size": 5_000_000_000},
        ]
        self.assertEqual(LOCAL_AI.select_model(models), "qwen2.5-coder:7b")

    def test_does_not_auto_select_only_large_model(self):
        self.assertIsNone(LOCAL_AI.select_model([{"name": "coder:32b", "size": 20_000_000_000}]))

    def test_input_bound_preserves_both_ends_and_collapses_repeats(self):
        bounded, truncated = LOCAL_AI.clean_and_bound("start\n" + "same\n" * 10 + "x" * 100 + "\nend", 70)
        self.assertTrue(truncated)
        self.assertIn("start", bounded)
        self.assertIn("end", bounded)
        self.assertIn("omitted", bounded)
        self.assertLessEqual(len(bounded), 70)

    def test_long_log_preprocessing_preserves_signals_and_bounds_noise(self):
        lines = [f"INFO request={index}" for index in range(100)]
        lines[40] = "ERROR DatabaseTimeoutError at src/orders/repository.py:87"
        lines[70] = "pytest FAIL tests/test_orders.py::test_retry_timeout"
        filtered, omitted = LOCAL_AI.preprocess_for_task("summarize-log", "\n".join(lines))
        self.assertIn("DatabaseTimeoutError", filtered)
        self.assertIn("test_retry_timeout", filtered)
        self.assertIn("routine log lines omitted", filtered)
        self.assertGreater(omitted, 80)
        self.assertEqual(LOCAL_AI.preprocess_for_task("review-diff", "\n".join(lines))[1], 0)

    def test_review_diff_requires_the_declared_schema(self):
        with self.assertRaises(RuntimeError):
            LOCAL_AI.validate_structured_response("review-diff", {"response": "not a review"})
        LOCAL_AI.validate_structured_response("review-diff", {
            "summary": "bounded review",
            "findings": [],
            "suspected_files": [],
            "risks": [],
            "recommended_actions": [],
            "confidence": "low",
        })

    def test_summarize_log_schema_bounds_normal_and_retry_lists(self):
        normal = LOCAL_AI.response_format("summarize-log")
        compact = LOCAL_AI.response_format("summarize-log", compact=True)
        self.assertEqual(normal["properties"]["errors"]["maxItems"], 8)
        self.assertEqual(compact["properties"]["errors"]["maxItems"], 2)
        self.assertEqual(LOCAL_AI.response_format("review-diff"), "json")

    def test_all_benchmark_cases_have_non_sensitive_input_and_known_schema(self):
        cases = LOCAL_AI.benchmark_cases()
        self.assertEqual([name for name, _ in cases], [
            "review-diff", "analyze-tests", "inspect-files", "summarize-log",
        ])
        for name, source in cases:
            self.assertNotIn("BEGIN PRIVATE", source)
            self.assertIn(name, LOCAL_AI.TASK_REQUIRED_FIELDS)

    def test_telemetry_aggregates_each_finished_job_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            event = {
                "id": "event-1",
                "started_at": "2026-08-16T12:00:00Z",
                "finished_at": "2026-08-16T12:00:01Z",
                "task": "review-diff",
                "model": "qwen2.5-coder:7b",
                "status": "success",
                "duration_seconds": 1,
                "local_input_tokens": 120,
                "local_output_tokens": 20,
                "context_input_tokens": 100,
                "context_output_tokens": 10,
                "context_overhead_tokens": 0,
                "context_replacement": True,
                "openai_context_tokens_avoided": 90,
            }
            recorder.started({**event, "status": "running"})
            recorder.finished(event)
            recorder.finished(event)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["totals"]["calls"], 1)
            self.assertEqual(state["totals"]["successful_calls"], 1)
            self.assertEqual(state["totals"]["openai_context_tokens_avoided"], 90)
            self.assertEqual(state["active_jobs"], {})

    def test_telemetry_excludes_failures_and_benchmarks_from_context_savings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            base = {
                "started_at": "2026-08-16T12:00:00Z",
                "finished_at": "2026-08-16T12:00:01Z",
                "model": "qwen2.5-coder:7b",
                "context_input_tokens": 100,
            }
            recorder.finished({**base, "id": "failed", "task": "review-diff", "status": "failed"})
            recorder.finished({
                **base, "id": "benchmark", "task": "benchmark:review-diff", "status": "success",
                "context_output_tokens": 10, "context_replacement": False,
                "openai_context_tokens_avoided": 90,
            })
            recorder.finished({
                **base, "id": "expanded", "task": "review-diff", "status": "success",
                "context_output_tokens": 120, "context_replacement": True,
                "openai_context_tokens_avoided": -20,
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["totals"]["calls"], 3)
            self.assertEqual(state["totals"]["context_input_tokens"], 100)
            self.assertEqual(state["totals"]["context_output_tokens"], 120)
            self.assertEqual(state["totals"]["openai_context_tokens_avoided"], -20)

    def test_complete_v1_history_migrates_without_benchmark_or_failed_savings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            jobs = [
                {
                    "id": "success", "task": "review-diff", "model": "model", "status": "success",
                    "started_at": "2026-08-16T12:00:00Z", "finished_at": "2026-08-16T12:00:01Z",
                    "context_input_tokens": 100, "context_output_tokens": 20,
                    "openai_context_tokens_avoided": 80,
                },
                {
                    "id": "failed", "task": "review-diff", "model": "model", "status": "failed",
                    "started_at": "2026-08-16T12:00:02Z", "finished_at": "2026-08-16T12:00:03Z",
                    "context_input_tokens": 900,
                },
                {
                    "id": "benchmark", "task": "benchmark:review-diff", "model": "model", "status": "success",
                    "started_at": "2026-08-16T12:00:04Z", "finished_at": "2026-08-16T12:00:05Z",
                    "context_input_tokens": 200, "context_output_tokens": 10,
                    "openai_context_tokens_avoided": 190,
                },
            ]
            path.write_text(json.dumps({
                "schema_version": 1, "totals": {"calls": 3, "context_input_tokens": 1200},
                "latest_jobs": jobs, "seen_event_ids": [job["id"] for job in jobs], "active_jobs": {},
            }), encoding="utf-8")
            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "inspect-files", "model": "model",
                "status": "running", "started_at": "2026-08-16T12:01:00Z",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], 2)
            self.assertEqual(state["totals"]["calls"], 3)
            self.assertEqual(state["totals"]["context_input_tokens"], 100)
            self.assertEqual(state["totals"]["openai_context_tokens_avoided"], 80)


if __name__ == "__main__":
    unittest.main()
