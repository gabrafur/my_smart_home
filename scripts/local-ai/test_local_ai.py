#!/usr/bin/env python3
"""Small offline checks for input bounding and conservative model selection."""

import importlib.util
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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
    def test_telemetry_files_are_private_and_group_writable_for_bridge_sharing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            recorder.started({
                "id": "shared", "task": "inspect-files", "model": "model",
                "status": "running", "started_at": "2026-08-17T12:00:00Z",
            })
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o660)
            self.assertEqual(stat.S_IMODE(path.with_suffix(".json.lock").stat().st_mode), 0o660)

    def test_shared_writer_does_not_chmod_already_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            recorder.started({
                "id": "owner", "task": "inspect-files", "model": "model",
                "status": "running", "started_at": "2026-08-17T12:00:00Z",
            })
            lock_path = path.with_suffix(".json.lock")
            events_path = path.with_name("local-ai-events.jsonl")
            original_chmod = TELEMETRY.os.chmod

            def reject_cross_owner_chmod(target, mode):
                if Path(target) in {lock_path, events_path}:
                    raise PermissionError("simulated shared-file owner")
                original_chmod(target, mode)

            with patch.object(TELEMETRY.os, "chmod", side_effect=reject_cross_owner_chmod):
                recorder.routing_decision({
                    "id": "shared-writer", "timestamp": "2026-08-17T12:01:00Z",
                    "task_type": "inspect-files", "decision": "DETERMINISTIC",
                    "reason": "deterministic_tool_sufficient",
                })

            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["routing"]["latest_decisions"][-1]["id"], "shared-writer")

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

    def test_log_validation_requires_critical_identifiers_in_summary_or_errors(self):
        response = {
            "summary": "Cache write timed out.",
            "errors": [],
            "suspected_files": [],
            "recommended_actions": ["Inspect CACHE_WRITE_TIMEOUT."],
            "confidence": "high",
        }
        with self.assertRaises(RuntimeError):
            LOCAL_AI.validate_structured_response(
                "summarize-log", response,
                "cache TIMEOUT CACHE_WRITE_TIMEOUT after 30000ms key=session",
            )
        response["errors"] = ["CACHE_WRITE_TIMEOUT after 30000ms key=session"]
        LOCAL_AI.validate_structured_response(
            "summarize-log", response,
            "cache TIMEOUT CACHE_WRITE_TIMEOUT after 30000ms key=session",
        )

    def test_log_validation_requires_each_signal_kind_and_ignores_routine_identifiers(self):
        response = {
            "summary": "ERROR TypeError in src/app.py.",
            "errors": [],
            "suspected_files": ["src/app.py"],
            "recommended_actions": [],
            "confidence": "high",
        }
        source = "INFO ROUTINE_HEARTBEAT ok\nERROR TypeError in src/app.py\nWARN retry database"
        with self.assertRaises(RuntimeError):
            LOCAL_AI.validate_structured_response("summarize-log", response, source)
        response["errors"] = ["WARN retry database"]
        LOCAL_AI.validate_structured_response("summarize-log", response, source)

    def test_routing_availability_reuses_the_conversation_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            telemetry_path = Path(directory) / "local-ai-telemetry.json"
            telemetry_path.with_name("local-ai-status.json").write_text(json.dumps({
                "state": "LOCAL_AI_AVAILABLE", "checked_at": "2026-08-16T00:00:00Z",
            }), encoding="utf-8")
            recorder = TELEMETRY.TelemetryRecorder(telemetry_path)
            self.assertEqual(LOCAL_AI.routing_availability(recorder, None), "available")
            self.assertEqual(LOCAL_AI.routing_availability(recorder, "available"), "available")

    def test_routing_availability_requires_a_recorded_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            telemetry_path = Path(directory) / "local-ai-telemetry.json"
            telemetry_path.with_name("local-ai-status.json").write_text(json.dumps({
                "state": "LOCAL_AI_AVAILABLE",
            }), encoding="utf-8")
            recorder = TELEMETRY.TelemetryRecorder(telemetry_path)
            self.assertEqual(LOCAL_AI.routing_availability(recorder, None), "unknown")

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

    def test_test_output_preprocessing_uses_the_same_signal_contract(self):
        lines = [f"routine line {index}" for index in range(120)]
        lines[60] = "FAILED tests/test_example.py::test_contract"

        filtered, omitted = LOCAL_AI.preprocess_for_task("analyze-tests", "\n".join(lines))

        self.assertIn("FAILED tests/test_example.py::test_contract", filtered)
        self.assertIn("routine log lines omitted", filtered)
        self.assertGreater(omitted, 0)

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

    def test_review_diff_anchors_keep_sensitive_changes_but_ignore_harmless_files(self):
        source = """diff --git a/src/cache.ts b/src/cache.ts
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1 +1 @@
-return cache.setTtl(ttlSeconds)
+return cache.setTtl(ttlSeconds * 1000)
diff --git a/docs/label.md b/docs/label.md
--- a/docs/label.md
+++ b/docs/label.md
@@ -1 +1 @@
-old label
+new label
"""
        anchors = LOCAL_AI.required_source_anchors("review-diff", source)
        self.assertIn("src/cache.ts", anchors)
        self.assertIn("* 1000", anchors)
        self.assertNotIn("docs/label.md", anchors)

    def test_inspect_files_uses_a_bounded_schema(self):
        schema = LOCAL_AI.response_format("inspect-files")
        self.assertIsInstance(schema, dict)
        self.assertEqual(schema["properties"]["files"]["maxItems"], 32)
        self.assertEqual(
            schema["properties"]["files"]["items"]["properties"]["relevant_items"]["maxItems"],
            16,
        )

    def test_quality_verifier_requires_high_coverage_and_no_findings(self):
        accepted = {
            "usable": True,
            "coverage_score": 96,
            "critical_omissions": [],
            "contradictions": [],
            "unsupported_claims": [],
        }
        report, _ = LOCAL_AI.verify_candidate_quality(
            "summarize-document",
            "source contract",
            {"summary": "source contract"},
            endpoint="http://example.invalid",
            model="model",
            request_call=lambda *_args, **_kwargs: {"response": json.dumps(accepted)},
            minimum_score=90,
            context_tokens=4096,
        )
        self.assertEqual(report["coverage_score"], 96)
        rejected = {**accepted, "usable": False, "critical_omissions": ["threshold"]}
        with self.assertRaises(LOCAL_AI.QualityRejected):
            LOCAL_AI.verify_candidate_quality(
                "summarize-document",
                "source contract",
                {"summary": "source"},
                endpoint="http://example.invalid",
                model="model",
                request_call=lambda *_args, **_kwargs: {"response": json.dumps(rejected)},
                minimum_score=90,
                context_tokens=4096,
            )

    def test_response_token_usage_separates_validator_cost(self):
        self.assertEqual(
            LOCAL_AI.response_token_usage([
                {"prompt_eval_count": 120, "eval_count": 20},
                {"prompt_eval_count": 80, "eval_count": 10},
            ]),
            (200, 30, True),
        )
        self.assertEqual(
            LOCAL_AI.response_token_usage([{"prompt_eval_count": 120}]),
            (0, 0, False),
        )

    def test_bounded_schemas_limit_normal_and_retry_lists(self):
        normal = LOCAL_AI.response_format("summarize-log")
        compact = LOCAL_AI.response_format("summarize-log", compact=True)
        self.assertEqual(normal["properties"]["errors"]["maxItems"], 8)
        self.assertEqual(compact["properties"]["errors"]["maxItems"], 2)
        review = LOCAL_AI.response_format("review-diff")
        compact_review = LOCAL_AI.response_format("review-diff", compact=True)
        self.assertEqual(review["properties"]["findings"]["maxItems"], 8)
        self.assertEqual(compact_review["properties"]["findings"]["maxItems"], 2)
        finding = review["properties"]["findings"]["items"]
        self.assertEqual(finding["required"], ["file", "severity", "reason"])
        self.assertFalse(finding["additionalProperties"])

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

    def test_only_quality_validated_results_count_as_useful_savings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            base = {
                "started_at": "2026-08-17T12:00:00Z",
                "finished_at": "2026-08-17T12:00:01Z",
                "task": "summarize-log",
                "model": "model",
                "context_input_tokens": 100,
                "context_output_tokens": 10,
                "context_replacement": True,
            }
            recorder.finished({
                **base, "id": "accepted", "status": "success", "quality_accepted": True,
                "openai_context_tokens_avoided": 90,
                "gross_useful_context_tokens_avoided": 90,
                "quality_validation_input_tokens": 3,
                "quality_validation_output_tokens": 2,
                "quality_validation_tokens": 5,
                "quality_validation_tokens_measured": True,
                "useful_context_tokens_avoided": 85,
            })
            recorder.finished({
                **base, "id": "discarded", "status": "discarded", "quality_accepted": False,
                "openai_context_tokens_avoided": 90,
                "quality_validation_input_tokens": 4,
                "quality_validation_output_tokens": 1,
                "quality_validation_tokens": 5,
                "quality_validation_tokens_measured": True,
                "useful_context_tokens_avoided": 0,
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            totals = state["totals"]
            self.assertEqual(totals["quality_validated_calls"], 1)
            self.assertEqual(totals["quality_rejected_calls"], 1)
            self.assertEqual(totals["gross_useful_context_tokens_avoided"], 90)
            self.assertEqual(totals["quality_validation_tokens"], 10)
            self.assertEqual(totals["quality_validated_validation_tokens"], 5)
            self.assertEqual(totals["useful_context_tokens_avoided"], 85)
            self.assertEqual(totals["quality_validated_context_input_tokens"], 100)
            self.assertEqual(totals["attempted_context_input_tokens"], 200)

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

    def test_failed_inference_retries_once_records_failure_and_clears_active_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            telemetry_path = root / "canonical-telemetry.json"
            source_path = root / "review.diff"
            source_path.write_text("+ safe implementation change\n" * 300, encoding="utf-8")
            args = SimpleNamespace(
                task="summarize-document",
                input_file=str(source_path),
                input_max_chars=12_000,
                endpoint=None,
                model=None,
                max_output_chars=6_000,
                context_tokens=4_096,
                output_tokens=700,
                memory_topic=None,
                memory_files_found=None,
            )
            settings = {
                "enabled": True,
                "endpoint": "http://local-ai.invalid",
                "model": "qwen2.5-coder:7b",
                "telemetry_path": str(telemetry_path),
            }
            generate_calls = 0

            def request_failure(_endpoint, path, _payload=None):
                nonlocal generate_calls
                if path == "/api/tags":
                    return {"models": [{"name": "qwen2.5-coder:7b", "size": 5_000_000_000}]}
                if path == "/api/generate":
                    generate_calls += 1
                    raise RuntimeError("controlled inference failure")
                raise AssertionError(path)

            with (
                patch.object(LOCAL_AI, "user_settings", return_value=settings),
                patch.object(LOCAL_AI, "request", side_effect=request_failure),
                patch.object(LOCAL_AI, "revalidate_once", return_value=True) as revalidate,
                patch.object(LOCAL_AI, "gpu_snapshot", return_value=None),
            ):
                with self.assertRaises(RuntimeError):
                    LOCAL_AI.run_analysis(args)

            state = json.loads(telemetry_path.read_text(encoding="utf-8"))
            self.assertEqual(generate_calls, 2)
            revalidate.assert_called_once()
            self.assertEqual(state["active_jobs"], {})
            self.assertEqual(state["totals"]["successful_calls"], 0)
            self.assertEqual(state["totals"]["failed_calls"], 1)
            self.assertEqual(state["routing"]["totals"]["used_tasks"], 0)
            self.assertEqual(state["routing"]["totals"]["failed_tasks"], 1)
            self.assertEqual(state["routing"]["totals"]["missed_opportunities"], 0)
            self.assertEqual(state["latest_jobs"][-1]["status"], "failed")
            self.assertEqual(state["latest_jobs"][-1]["useful_context_tokens_avoided"], 0)
            latest_decision = state["routing"]["latest_decisions"][0]
            self.assertEqual(latest_decision["actual_tokens_avoided"], 0)
            self.assertEqual(latest_decision["useful_tokens_avoided"], 0)

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
            self.assertEqual(state["schema_version"], 10)
            self.assertEqual(state["totals"]["calls"], 3)
            self.assertEqual(state["totals"]["context_input_tokens"], 100)
            self.assertEqual(state["totals"]["openai_context_tokens_avoided"], 80)

    def test_schema_seven_backfills_complete_daily_ab_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            events_path = Path(directory) / "local-ai-events.jsonl"
            events = [
                {
                    "id": "accepted", "task": "analyze-tests", "model": "model",
                    "status": "success", "finished_at": "2026-08-23T12:00:00Z",
                    "context_replacement": True, "context_input_tokens": 100,
                },
                {
                    "id": "discarded", "task": "review-diff", "model": "model",
                    "status": "discarded", "finished_at": "2026-08-23T12:01:00Z",
                    "context_replacement": True, "context_input_tokens": 300,
                },
            ]
            events_path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")
            path.write_text(json.dumps({
                "schema_version": 7,
                "totals": {"calls": 5, "quality_validated_context_input_tokens": 100},
                "daily": {"2026-08-23": {"totals": {
                    "calls": 2, "quality_validated_context_input_tokens": 100,
                }}},
                "models": {"model": {"totals": {"calls": 2}}},
            }), encoding="utf-8")

            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "inspect-files", "model": "model",
                "status": "running", "started_at": "2026-08-23T12:02:00Z",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], 10)
            self.assertNotIn("attempted_context_input_tokens", state["totals"])
            self.assertEqual(state["daily"]["2026-08-23"]["totals"]["attempted_context_input_tokens"], 400)
            self.assertEqual(state["models"]["model"]["totals"]["attempted_context_input_tokens"], 400)

    def test_schema_eight_keeps_legacy_gross_but_claims_zero_unmeasured_net(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            path.write_text(json.dumps({
                "schema_version": 8,
                "totals": {
                    "calls": 3,
                    "quality_validated_calls": 1,
                    "quality_rejected_calls": 1,
                    "useful_context_tokens_avoided": 90,
                },
                "daily": {"2026-08-23": {"totals": {
                    "calls": 3,
                    "quality_validated_calls": 1,
                    "quality_rejected_calls": 1,
                    "useful_context_tokens_avoided": 90,
                }}},
            }), encoding="utf-8")

            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "inspect-files", "model": "model",
                "status": "running", "started_at": "2026-08-23T12:02:00Z",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            totals = state["totals"]
            self.assertEqual(state["schema_version"], 10)
            self.assertEqual(totals["gross_useful_context_tokens_avoided"], 90)
            self.assertEqual(totals["quality_validation_unmeasured_gross_tokens"], 90)
            self.assertEqual(totals["quality_validation_unmeasured_calls"], 2)
            self.assertEqual(totals["useful_context_tokens_avoided"], 0)

    def test_schema_nine_revokes_savings_from_truncated_bounded_context(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            event = {
                "id": "unsafe", "task": "summarize-document", "model": "model",
                "status": "success", "started_at": "2026-08-23T23:09:00Z",
                "finished_at": "2026-08-23T23:09:23.368688Z",  # PRIVACY_TEST_FIXTURE
                "context_replacement": True, "input_truncated": True,
                "context_input_tokens": 6910, "context_output_tokens": 375,
                "openai_context_tokens_avoided": 6535,
                "gross_useful_context_tokens_avoided": 6535,
                "quality_validation_input_tokens": 4500,
                "quality_validation_output_tokens": 346,
                "quality_validation_tokens": 4846,
                "quality_validation_tokens_measured": True,
                "quality_verification_attempts": 1,
                "quality_accepted": True, "quality_score_percent": 100,
                "useful_context_tokens_avoided": 1689,
            }
            decision = {
                "id": "unsafe-routing", "timestamp": "2026-08-23T23:09:23.368754Z",  # PRIVACY_TEST_FIXTURE
                "task_type": "summarize-document", "decision": "LOCAL_AI_USED",
                "reason": "local_ai_completed", "eligible": True, "available": True,
                "actual_tokens_avoided": 6535,
                "gross_useful_tokens_avoided": 6535,
                "quality_validation_tokens": 4846,
                "quality_validation_tokens_measured": True,
                "quality_accepted": True, "quality_score_percent": 100,
                "useful_tokens_avoided": 1689,
            }
            state = TELEMETRY._initial_state()
            state["schema_version"] = 9
            state["latest_jobs"] = [dict(event)]
            TELEMETRY._add_totals(state, event)
            state["daily"] = {"2026-08-23": {"totals": TELEMETRY._event_totals(), "routing": {}}}
            TELEMETRY._add_totals(state["daily"]["2026-08-23"], event)
            state["models"] = {"model": {"totals": TELEMETRY._event_totals()}}
            TELEMETRY._add_totals(state["models"]["model"], event)
            state["routing"]["latest_decisions"] = [dict(decision)]
            TELEMETRY._add_routing_totals(state["routing"], decision)
            TELEMETRY._add_routing_totals(state["daily"]["2026-08-23"]["routing"], decision)
            path.write_text(json.dumps(state), encoding="utf-8")

            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "summarize-log", "model": "model",
                "status": "running", "started_at": "2026-08-23T23:10:00Z",
            })
            migrated = json.loads(path.read_text(encoding="utf-8"))
            totals = migrated["totals"]
            routing = migrated["routing"]["totals"]
            self.assertEqual(migrated["schema_version"], 10)
            self.assertEqual(totals["successful_calls"], 0)
            self.assertEqual(totals["quality_rejected_calls"], 1)
            self.assertEqual(totals["quality_validated_calls"], 0)
            self.assertEqual(totals["attempted_context_input_tokens"], 6910)
            self.assertEqual(totals["gross_useful_context_tokens_avoided"], 0)
            self.assertEqual(totals["quality_validation_tokens"], 4846)
            self.assertEqual(totals["quality_validated_validation_tokens"], 0)
            self.assertEqual(totals["useful_context_tokens_avoided"], 0)
            self.assertEqual(migrated["latest_jobs"][0]["status"], "discarded")
            self.assertEqual(routing["used_tasks"], 0)
            self.assertEqual(routing["quality_rejected_tasks"], 1)
            self.assertEqual(routing["quality_validation_tokens"], 4846)
            self.assertEqual(routing["quality_validated_validation_tokens"], 0)
            self.assertEqual(routing["useful_tokens_avoided"], 0)
            self.assertEqual(
                migrated["routing"]["latest_decisions"][0]["reason"],
                "input_truncated_before_quality_gate",
            )

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
            self.assertEqual(state["schema_version"], 10)
            self.assertEqual(totals["tasks"], 2)
            self.assertEqual(totals["used_tasks"], 1)
            self.assertEqual(totals["missed_opportunities"], 1)
            self.assertEqual(totals["eligible_and_available_tasks"], 2)
            self.assertEqual(totals["potential_tokens_avoidable"], 10_300)
            self.assertEqual(totals["actual_tokens_avoided"], 6_000)
            self.assertNotIn("prompt", state["routing"]["latest_decisions"][0])
            self.assertEqual(state["daily"]["2026-08-16"]["routing"]["used_tasks"], 1)
            self.assertNotIn("totals", state["daily"]["2026-08-16"]["routing"])

    def test_routing_telemetry_splits_unknown_and_confirmed_unavailability(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            recorder.routing_decision({
                "id": "unknown", "timestamp": "2026-08-17T12:00:00Z",
                "task_type": "review-diff", "decision": "LOCAL_AI_UNAVAILABLE",
                "reason": "local_ai_availability_unknown", "eligible": True,
            })
            recorder.routing_decision({
                "id": "confirmed", "timestamp": "2026-08-17T12:01:00Z",
                "task_type": "review-diff", "decision": "LOCAL_AI_UNAVAILABLE",
                "reason": "local_ai_unavailable", "eligible": True,
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            totals = state["routing"]["totals"]
            self.assertEqual(totals["unavailable_tasks"], 2)
            self.assertEqual(totals["availability_unknown_tasks"], 1)
            self.assertEqual(totals["confirmed_unavailable_tasks"], 1)

    def test_schema_four_backfills_availability_breakdown_when_history_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            path.write_text(json.dumps({
                "schema_version": 4,
                "routing": {
                    "totals": {"unavailable_tasks": 2},
                    "latest_decisions": [
                        {"id": "u", "timestamp": "2026-08-17T12:00:00Z", "decision": "LOCAL_AI_UNAVAILABLE", "reason": "local_ai_availability_unknown"},
                        {"id": "c", "timestamp": "2026-08-17T12:01:00Z", "decision": "LOCAL_AI_UNAVAILABLE", "reason": "local_ai_unavailable"},
                    ],
                },
                "daily": {"2026-08-17": {"routing": {"unavailable_tasks": 2}}},
            }), encoding="utf-8")
            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "review-diff", "model": "model",
                "status": "running", "started_at": "2026-08-17T12:02:00Z",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], 10)
            self.assertEqual(state["routing"]["totals"]["availability_unknown_tasks"], 1)
            self.assertEqual(state["routing"]["totals"]["confirmed_unavailable_tasks"], 1)
            self.assertEqual(state["daily"]["2026-08-17"]["routing"]["availability_unknown_tasks"], 1)

    def test_schema_five_reclassifies_failed_calls_that_were_counted_as_used(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            path.write_text(json.dumps({
                "schema_version": 5,
                "routing": {
                    "totals": {"tasks": 1, "eligible_tasks": 1, "eligible_and_available_tasks": 1, "used_tasks": 1},
                    "latest_decisions": [{
                        "id": "failed", "timestamp": "2026-08-17T12:00:00Z",
                        "decision": "LOCAL_AI_USED", "reason": "local_ai_call_failed",
                    }],
                },
                "daily": {"2026-08-17": {"routing": {
                    "tasks": 1, "eligible_tasks": 1, "eligible_and_available_tasks": 1, "used_tasks": 1,
                }}},
            }), encoding="utf-8")
            TELEMETRY.TelemetryRecorder(path).started({
                "id": "active", "task": "review-diff", "model": "model",
                "status": "running", "started_at": "2026-08-17T12:02:00Z",
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["routing"]["totals"]["used_tasks"], 0)
            self.assertEqual(state["routing"]["totals"]["failed_tasks"], 1)
            self.assertEqual(state["routing"]["latest_decisions"][0]["decision"], "LOCAL_AI_FAILED")

    def test_failed_local_call_has_a_distinct_terminal_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            assessment = LOCAL_AI.assess_routing("review-diff", 32_000, availability="available")
            LOCAL_AI.record_routing_outcome(
                recorder,
                assessment,
                outcome="failed",
                reason="local_ai_call_failed",
            )
            state = json.loads(path.read_text(encoding="utf-8"))
            decision = state["routing"]["latest_decisions"][0]
            self.assertEqual(decision["decision"], "LOCAL_AI_FAILED")
            self.assertEqual(decision["reason"], "local_ai_call_failed")
            self.assertEqual(state["routing"]["totals"]["used_tasks"], 0)
            self.assertEqual(state["routing"]["totals"]["failed_tasks"], 1)

    def test_quality_rejected_decision_records_zero_real_savings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TELEMETRY.TelemetryRecorder(path)
            assessment = LOCAL_AI.assess_routing("review-diff", 32_000, availability="available")
            LOCAL_AI.record_routing_outcome(
                recorder,
                assessment,
                outcome="quality-rejected",
                actual_tokens_avoided=0,
                useful_tokens_avoided=0,
                quality_accepted=False,
                reason="quality_gate_rejected",
            )
            decision = json.loads(path.read_text(encoding="utf-8"))["routing"]["latest_decisions"][0]
            self.assertEqual(decision["decision"], "LOCAL_AI_QUALITY_REJECTED")
            self.assertEqual(decision["actual_tokens_avoided"], 0)
            self.assertEqual(decision["useful_tokens_avoided"], 0)


if __name__ == "__main__":
    unittest.main()
