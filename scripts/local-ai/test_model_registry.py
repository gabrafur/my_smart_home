#!/usr/bin/env python3
"""Regression tests for fail-closed per-activity Local AI model selection."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_registry import RegistryError, canary_bucket, load_registry, select_activity_route, validate_registry


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
            },
            routing_key=selected_key,
        )
        self.assertEqual(enabled["route"], "LOCAL_PRIMARY_CANARY")
        self.assertEqual(enabled["rollout_percentage"], 10)
        self.assertTrue(enabled["required_validation"])

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
