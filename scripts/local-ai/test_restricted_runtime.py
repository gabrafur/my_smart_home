from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_registry import canary_bucket, load_registry
from restricted_runtime import (
    execute_structured_extraction,
    restricted_feature_route,
    summarize_log_deterministically,
    validate_candidate,
)


SCHEMA = {
    "type": "object",
    "properties": {
        "record_id": {"type": "string"},
        "path": {"type": "string"},
        "line": {"type": "integer"},
        "count": {"type": "integer"},
    },
    "required": ["record_id", "path", "line", "count"],
    "additionalProperties": False,
}


class RestrictedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry()
        self.selected_key = next(f"canary-{index}" for index in range(1000) if canary_bucket(f"canary-{index}") < 10)
        self.environment = {
            "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1",
            "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "1",
            "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "10",
        }
        self.source = "Registro R-42 em scripts/local-ai/routing.py linha 17 com contagem 9."
        self.output = {"record_id": "R-42", "path": "scripts/local-ai/routing.py", "line": 17, "count": 9}

    def execute(self, generator, environment=None):
        return execute_structured_extraction(
            self.source, SCHEMA, routing_key=self.selected_key,
            critical_fields=list(SCHEMA["required"]), numeric_fields=["line", "count"],
            forbidden_fields=["root_cause"], local_generate=generator,
            environment=self.environment if environment is None else environment,
            registry=self.registry,
        )

    def test_canary_accepts_only_source_anchored_schema_valid_output(self):
        result = self.execute(lambda source, schema, route: self.output)
        self.assertEqual(result["route"], "LOCAL_PRIMARY_CANARY")
        self.assertFalse(result["fallback"])
        self.assertTrue(result["validation"]["accepted"])
        self.assertEqual(result["telemetry"]["execution_mode"], "production_canary")
        for field in (
            "job_id", "task_id", "attempt_id", "activity", "model", "model_digest",
            "parser_status", "residual_eligible", "rollout_percentage", "stable_bucket",
            "selected_for_canary", "local_input_tokens", "local_output_tokens",
            "estimated_direct_gpt_context", "estimated_routed_gpt_context",
            "estimated_avoided_gpt_tokens", "validation_status", "accepted",
            "fallback_reason", "critical_errors", "gpu_metrics_status", "gpu_peak",
            "vram_peak", "power_peak", "duration", "circuit_breaker_status", "timestamp_utc",
        ):
            self.assertIn(field, result["telemetry"])

    def test_changed_number_or_invented_path_falls_back_directly(self):
        changed = dict(self.output); changed["line"] = 18
        invented = dict(self.output); invented["path"] = "scripts/missing.py"
        self.assertEqual(self.execute(lambda *_: changed)["route"], "GPT_DIRECT")
        self.assertIn("invented_path", self.execute(lambda *_: invented)["validation"]["critical_errors"])

    def test_invalid_type_omission_and_generator_failure_fall_back_directly(self):
        wrong_type = dict(self.output); wrong_type["count"] = "9"
        omitted = dict(self.output); omitted.pop("record_id")
        for generator in (
            lambda *_: wrong_type,
            lambda *_: omitted,
            lambda *_: (_ for _ in ()).throw(TimeoutError("bounded")),
        ):
            with self.subTest(generator=generator):
                result = self.execute(generator)
                self.assertEqual(result["route"], "GPT_DIRECT")
                self.assertTrue(result["fallback"])

    def test_kill_switch_prevents_local_generator_call(self):
        calls = []
        result = self.execute(
            lambda *_: calls.append(True),
            environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1", "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "0"},
        )
        self.assertEqual(result["route"], "GPT_DIRECT")
        self.assertEqual(calls, [])

    def test_deterministic_parser_wins_before_canary(self):
        source = '{"record_id":"R-42","path":"scripts/local-ai/routing.py","line":17,"count":9}'
        calls = []
        result = execute_structured_extraction(
            source, SCHEMA, routing_key=self.selected_key, critical_fields=list(SCHEMA["required"]),
            numeric_fields=["line", "count"], forbidden_fields=[], local_generate=lambda *_: calls.append(True),
            environment=self.environment, registry=self.registry,
        )
        self.assertEqual(result["route"], "DETERMINISTIC")
        self.assertEqual(calls, [])

    def test_independent_flags_fail_to_approved_fallbacks(self):
        expectations = {
            "summarize_log": "DETERMINISTIC_LOG_FACTS",
            "retrieval": "DETERMINISTIC",
            "reranker": "DETERMINISTIC_RANKING",
            "error_similarity": "EXACT_SIGNATURE_ONLY",
        }
        for activity, route in expectations.items():
            with self.subTest(activity=activity):
                flag = self.registry["restricted_pivot"]["feature_flags"][activity]
                disabled = restricted_feature_route(activity, {flag: "0"})
                enabled = restricted_feature_route(activity, {flag: "1"})
                self.assertEqual(disabled["route"], route)
                self.assertEqual(enabled["route"], route)
        self.assertFalse(restricted_feature_route("error_similarity", {})["automatic_merge"])

    def test_deterministic_log_context_preserves_failure_and_numbers(self):
        source = "$ pytest -q\n" + ("INFO heartbeat\n" * 900) + "FAILED test_x\n3 passed, 1 failed in 2.5s\nEXIT_CODE=1\n"
        result = summarize_log_deterministically(source, command="pytest -q", exit_code=1)
        self.assertEqual(result["route"], "DETERMINISTIC_LOG_FACTS")
        facts = {item["fact_id"]: item["value"] for item in result["result"]["observed_facts"]}
        self.assertEqual(facts["tests_failed"], "1")
        self.assertEqual(facts["exit_code"], "1")
        self.assertEqual(result["validation"]["critical_fact_recall"], 1)

    def test_deterministic_log_handles_warning_success_stack_and_multiple_failures(self):
        samples = (
            "$ check\nWARNING config deprecated\nEXIT_CODE=0\n" + "INFO ok\n" * 500,
            "$ pytest\n2 passed, 0 failed in 1.2s\nEXIT_CODE=0\n" + "INFO ok\n" * 500,
            "$ run\nERROR first\nTraceback\n  File \"app.py\", line 7\nERROR second\nEXIT_CODE=1\n" + "INFO ok\n" * 500,
        )
        for source in samples:
            with self.subTest(source=source[:20]):
                result = summarize_log_deterministically(source)
                self.assertEqual(result["route"], "DETERMINISTIC_LOG_FACTS")
                context = result["result"]
                self.assertNotIn("hypotheses", context)
                self.assertEqual(result["validation"]["unsupported_claims"], 0)
                self.assertEqual(result["validation"]["critical_fact_recall"], 1)

    def test_deterministic_log_falls_back_when_signal_count_or_reduction_is_unsafe(self):
        too_many = "\n".join(f"ERROR failure {index}" for index in range(65))
        short = "ERROR one"
        for source in (too_many, short):
            with self.subTest(lines=len(source.splitlines())):
                result = summarize_log_deterministically(source)
                self.assertEqual(result["route"], "GPT_DIRECT")
                self.assertTrue(result["fallback"])

    def test_validator_rejects_forbidden_field(self):
        candidate = {**self.output, "root_cause": "guess"}
        result = validate_candidate(
            self.source, candidate, {**SCHEMA, "additionalProperties": True},
            critical_fields=list(SCHEMA["required"]), numeric_fields=["line", "count"],
            forbidden_fields=["root_cause"],
        )
        self.assertFalse(result["accepted"])
        self.assertIn("forbidden_field", result["critical_errors"])


if __name__ == "__main__":
    unittest.main()
