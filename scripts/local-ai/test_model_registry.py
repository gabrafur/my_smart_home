#!/usr/bin/env python3
"""Regression tests for fail-closed per-activity Local AI model selection."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_registry import (
    RegistryError, canary_bucket, configured_rollout_percentage, load_registry,
    select_activity_route, stable_canary_assignment, validate_registry,
)


class ModelRegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry()

    def test_current_registry_is_valid_and_makes_summarize_log_deterministic_only(self):
        validate_registry(self.registry)
        self.assertEqual(
            self.registry["activities"]["summarize_log"]["policy"],
            "deterministic-only",
        )
        route = select_activity_route("summarize_log", "UNSUPPORTED", registry=self.registry)
        self.assertEqual(route["route"], "DETERMINISTIC_LOG_FACTS")

    def test_deterministic_success_never_calls_local_model(self):
        route = select_activity_route(
            "file_selection", None, registry=self.registry,
            environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1"},
        )
        self.assertEqual(route["route"], "DETERMINISTIC")

    def test_feature_flag_is_a_central_rollback(self):
        for value in ("0", "false", "off"):
            with self.subTest(value=value):
                route = select_activity_route(
                    "file_selection", "NEEDS_SEMANTIC_REVIEW", registry=self.registry,
                    environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": value},
                )
                self.assertEqual(route["route"], "GPT_DIRECT")
                self.assertEqual(route["reason"], "quality_pipeline_disabled")

    def test_unpromoted_activity_falls_back_even_when_feature_is_enabled(self):
        route = select_activity_route(
            "classification", "AMBIGUOUS", registry=self.registry,
            environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1"},
        )
        self.assertEqual(route["route"], "GPT_DIRECT")
        self.assertEqual(route["reason"], "activity_not_promoted")

    def test_promoted_fixture_routes_once_to_configured_model(self):
        registry = copy.deepcopy(self.registry)
        registry["models"]["current_baseline"].update({
            "enabled": True,
            "production_enabled": True,
        })
        registry["activities"]["file_selection"].update({
            "local_model": "current_baseline",
            "local_mode": "production",
            "production_enabled": True,
        })
        route = select_activity_route(
            "file_selection", "NEEDS_SEMANTIC_REVIEW", registry=registry,
            environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1"},
        )
        self.assertEqual(route["route"], "LOCAL_PRIMARY")
        self.assertEqual(route["maximum_primary_attempts"], 1)
        self.assertEqual(route["unresolved_fallback"], "gpt-direct")

    def test_structured_extraction_canary_requires_both_flags_and_stable_bucket(self):
        selected_key = next(f"case-{index}" for index in range(1000) if canary_bucket(f"case-{index}") < 10)
        disabled = select_activity_route(
            "structured_extraction", "UNSUPPORTED", registry=self.registry,
            environment={"LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1"}, routing_key=selected_key,
        )
        self.assertEqual(disabled["reason"], "structured_extraction_canary_disabled")
        enabled = select_activity_route(
            "structured_extraction", "UNSUPPORTED", registry=self.registry,
            environment={
                "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1",
                "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "1",
                "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "10",
            },
            routing_key=selected_key,
        )
        self.assertEqual(enabled["route"], "LOCAL_PRIMARY_CANARY")
        self.assertEqual(enabled["rollout_percentage"], 10)
        self.assertTrue(enabled["required_validation"])

    def test_public_rollout_defaults_to_zero_and_invalid_values_fail_closed(self):
        self.assertEqual(configured_rollout_percentage(self.registry, {}), 0)
        for value in ("invalid", "-1", "101", "10.5", ""):
            with self.subTest(value=value):
                self.assertEqual(
                    configured_rollout_percentage(
                        self.registry, {"LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": value},
                    ),
                    0,
                )

    def test_assignment_is_stable_across_retry_restart_and_source_identity(self):
        pivot = self.registry["restricted_pivot"]["structured_extraction"]
        arguments = {
            "activity": "structured_extraction",
            "assignment_version": pivot["assignment_version"],
            "rollout_salt": pivot["rollout_salt"],
            "environment_namespace": "production",
            "schema_version": pivot["schema_version"],
            "logical_origin": "test",
            "source": "Record R-1 at line 9.",
        }
        first = stable_canary_assignment(**arguments)
        retry = stable_canary_assignment(**arguments)
        restarted = stable_canary_assignment(**arguments)
        self.assertEqual(first, retry)
        self.assertEqual(first, restarted)
        self.assertNotIn("Record", first["anonymous_task_id"])

    def test_ten_percent_assignment_distribution_over_ten_thousand_ids(self):
        pivot = self.registry["restricted_pivot"]["structured_extraction"]
        selected = sum(
            stable_canary_assignment(
                activity="structured_extraction", assignment_version=pivot["assignment_version"],
                rollout_salt=pivot["rollout_salt"], environment_namespace="production",
                schema_version=pivot["schema_version"], logical_origin="distribution-test",
                task_id=f"synthetic-{index}",
            )["stable_bucket"] < 10
            for index in range(10000)
        )
        self.assertGreaterEqual(selected, 900)
        self.assertLessEqual(selected, 1100)

    def test_non_production_or_failed_eligibility_checks_bypass_canary(self):
        environment = {
            "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1",
            "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "1",
            "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100",
        }
        cases = (
            ({"execution_mode": "benchmark"}, "execution_mode_not_production"),
            ({"parser_executed": False}, "deterministic_parser_not_executed"),
            ({"contract_supported": False}, "input_contract_not_supported"),
            ({"model_available": False}, "configured_model_unavailable"),
            ({"digest_matches": False}, "configured_model_digest_mismatch"),
            ({"schema_available": False}, "schema_unavailable"),
            ({"validator_available": False}, "validator_unavailable"),
            ({"circuit_breaker_status": "OPEN"}, "circuit_breaker_not_closed"),
            ({"input_sanitized": False}, "input_not_safely_sanitized"),
            ({"retry_already_resolved": True}, "retry_already_resolved"),
        )
        for override, reason in cases:
            with self.subTest(reason=reason):
                route = select_activity_route(
                    "structured_extraction", "UNSUPPORTED", registry=self.registry,
                    environment=environment, task_id="eligible-id", **override,
                )
                self.assertEqual(route["route"], "GPT_DIRECT")
                self.assertEqual(route["reason"], reason)
                self.assertFalse(route["residual_eligible"])

    def test_missing_or_disabled_model_fails_registry_validation(self):
        registry = copy.deepcopy(self.registry)
        registry["activities"]["file_selection"]["local_model"] = "missing"
        with self.assertRaisesRegex(RegistryError, "activity_unknown_model"):
            validate_registry(registry)

    def test_summarize_log_cannot_be_reenabled_without_evidence(self):
        registry = copy.deepcopy(self.registry)
        registry["activities"]["summarize_log"] = {"policy": "production"}
        with self.assertRaisesRegex(RegistryError, "summarize_log_policy"):
            validate_registry(registry)


if __name__ == "__main__":
    unittest.main()
