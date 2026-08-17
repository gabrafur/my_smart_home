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
    def test_gpu_sampler_uses_persistent_strict_known_hosts(self):
        sampler = TELEMETRY.RemoteGpuSampler({
            "container": "homeassistant",
            "ssh_user": "gpu-user",
            "ssh_host": "gpu-host",
            "ssh_key_path": "/config/.ssh/gpu_ed25519",
            "wsl_nvidia_smi": "/usr/lib/wsl/lib/nvidia-smi",
        })

        command = sampler._ssh_command("wsl.exe -e ollama ps")

        self.assertIn("UserKnownHostsFile=/config/.ssh/known_hosts", command)
        self.assertIn("StrictHostKeyChecking=yes", command)

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

    def test_raw_input_size_survives_deterministic_log_compaction_for_accounting(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repeated.log"
            path.write_text("INFO heartbeat\n" * 2_000 + "ERROR synthetic failure\n", encoding="utf-8")
            raw, bounded, truncated, raw_limited = LOCAL_AI.read_input(str(path), 100_000)
            self.assertFalse(truncated)
            self.assertFalse(raw_limited)
            self.assertGreater(len(raw), 20_000)
            self.assertLess(len(bounded), 200)

    def test_routing_availability_rejects_a_stale_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            telemetry_path = Path(directory) / "local-ai-telemetry.json"
            telemetry_path.with_name("local-ai-status.json").write_text(json.dumps({
                "state": "LOCAL_AI_AVAILABLE", "checked_at": "2026-08-16T00:00:00Z",
            }), encoding="utf-8")
            recorder = TELEMETRY.TelemetryRecorder(telemetry_path)
            self.assertEqual(LOCAL_AI.routing_availability(recorder, None), "unknown")
            self.assertEqual(LOCAL_AI.routing_availability(recorder, "available"), "available")

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

    def test_summarize_memory_schema_preserves_required_technical_facts(self):
        schema = LOCAL_AI.response_format("summarize-memory")
        self.assertIsInstance(schema, dict)
        self.assertIn("root_causes", schema["required"])
        self.assertIn("configuration_values", schema["required"])
        LOCAL_AI.validate_structured_response("summarize-memory", {
            "summary": "bounded memory", "current_state": [], "decisions": [], "constraints": [],
            "known_bugs": [], "root_causes": [], "configuration_values": [],
            "unresolved_issues": [], "warnings": [], "source_facts": [], "confidence": "low",
        })

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
            self.assertEqual(state["schema_version"], 4)
            self.assertEqual(state["totals"]["calls"], 3)
            self.assertEqual(state["totals"]["context_input_tokens"], 100)
            self.assertEqual(state["totals"]["openai_context_tokens_avoided"], 80)

    def test_routing_decisions_are_idempotent_and_keep_only_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            decision = {
                "id": "routing-used", "timestamp": "2026-08-16T12:00:00Z",
                "task_type": "analyze-tests", "input_chars": 32_000,
                "estimated_input_tokens": 8_000, "eligible": True, "available": True,
                "expected_tokens_saved": 6_400, "actual_tokens_avoided": 6_000,
                "decision": "LOCAL_AI_USED", "reason": "large_test_output",
                "prompt": "must never be persisted",
            }
            recorder.routing_decision(decision)
            recorder.routing_decision(decision)
            recorder.routing_decision({
                "id": "routing-missed", "timestamp": "2026-08-16T12:01:00Z",
                "task_type": "review-diff", "input_chars": 24_000,
                "estimated_input_tokens": 6_000, "eligible": True, "available": True,
                "expected_tokens_saved": 3_900,
                "decision": "ROUTING_MISSED_OPPORTUNITY", "reason": "helper_not_called",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            totals = state["routing"]["totals"]
            self.assertEqual(state["schema_version"], 4)
            self.assertEqual(totals["tasks"], 2)
            self.assertEqual(totals["used_tasks"], 1)
            self.assertEqual(totals["missed_opportunities"], 1)
            self.assertEqual(totals["eligible_and_available_tasks"], 2)
            self.assertEqual(totals["potential_tokens_avoidable"], 10_300)
            self.assertEqual(totals["actual_tokens_avoided"], 6_000)
            self.assertNotIn("prompt", state["routing"]["latest_decisions"][0])
            self.assertEqual(state["daily"]["2026-08-16"]["routing"]["used_tasks"], 1)
            self.assertNotIn("totals", state["daily"]["2026-08-16"]["routing"])

    def test_failed_local_call_reason_can_be_recorded_without_changing_its_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            assessment = LOCAL_AI.assess_routing("review-diff", 32_000, availability="available")
            LOCAL_AI.record_routing_outcome(
                recorder,
                assessment,
                outcome="used",
                reason="local_ai_call_failed",
            )
            state = json.loads(path.read_text(encoding="utf-8"))
            decision = state["routing"]["latest_decisions"][0]
            self.assertEqual(decision["decision"], "LOCAL_AI_USED")
            self.assertEqual(decision["reason"], "local_ai_call_failed")


if __name__ == "__main__":
    unittest.main()
