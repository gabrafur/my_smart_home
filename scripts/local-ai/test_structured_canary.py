#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from canary_state import CanaryStore
from restricted_runtime import LocalInferenceResult
from structured_canary import effective_config, extract_payload, update_runtime_config
from model_registry import load_registry


SCHEMA = {
    "type": "object",
    "properties": {
        "record_id": {"type": "string"}, "path": {"type": "string"},
        "line": {"type": "integer"}, "count": {"type": "integer"},
    },
    "required": ["record_id", "path", "line", "count"],
    "additionalProperties": False,
}
SOURCE = "Record R-42 identifies scripts/local-ai/routing.py at line 17 with count 9."
OUTPUT = {"record_id": "R-42", "path": "scripts/local-ai/routing.py", "line": 17, "count": 9}
ACTIVE = {
    "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1",
    "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "1",
    "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100",
    "LOCAL_AI_SUMMARIZE_LOG_ENABLED": "0", "LOCAL_AI_RETRIEVAL_ENABLED": "0",
    "LOCAL_AI_RERANKER_ENABLED": "0", "LOCAL_AI_ERROR_SIMILARITY_ENABLED": "0",
}


class StructuredCanaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.settings = {"telemetry_path": str(root / "base.json")}
        self.store = CanaryStore(root / "events.jsonl", root / "breaker.json", root / "summary.json")
        self.counter = 0

    def tearDown(self):
        self.temporary.cleanup()

    def payload(self, **updates):
        self.counter += 1
        value = {"source": SOURCE, "schema": SCHEMA, "task_id": f"task-{self.counter}", "execution_mode": "production"}
        value.update(updates)
        return value

    def extract(self, generator, *, environment=None, model_state=None, **payload):
        return extract_payload(
            self.payload(**payload), settings=self.settings, environment=ACTIVE if environment is None else environment,
            store=self.store, generator=generator,
            model_state_override=model_state or {"available": True, "digest_matches": True, "endpoint": "test"},
        )

    def test_valid_candidate_is_accepted_with_complete_trace_and_one_attempt(self):
        calls = []
        result = self.extract(lambda *_: calls.append(1) or OUTPUT)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["route"], "LOCAL_PRIMARY_CANARY")
        self.assertTrue(result["validation"]["complete_validation_trace"])
        self.assertTrue(all(item["source_evidence_hash"] for item in result["validation"]["validation_trace"]))

    def test_deterministic_parser_resolves_without_model_or_operational_denominator(self):
        calls = []
        source = json.dumps(OUTPUT, separators=(",", ":"))
        result = self.extract(lambda *_: calls.append(1), source=source)
        self.assertEqual(result["route"], "DETERMINISTIC")
        self.assertEqual(calls, [])
        self.assertFalse(self.store.events_path.exists())

    def test_invalid_json_omission_changed_number_and_invented_field_fallback(self):
        generators = (
            lambda *_: LocalInferenceResult(candidate=None, inference_status="invalid_json", error_type="invalid_json"),
            lambda *_: {key: value for key, value in OUTPUT.items() if key != "record_id"},
            lambda *_: {**OUTPUT, "line": 18},
            lambda *_: {**OUTPUT, "invented": "value"},
        )
        for generator in generators:
            with self.subTest(generator=generator):
                result = self.extract(generator)
                self.assertEqual(result["route"], "GPT_DIRECT")
                self.assertTrue(result["fallback"])
                self.assertLess(result["telemetry"]["estimated_avoided_gpt_tokens"], 0)

    def test_unavailable_model_timeout_oom_and_sampler_failure_fallback(self):
        unavailable = self.extract(lambda *_: OUTPUT, model_state={"available": False, "digest_matches": False, "endpoint": None})
        self.assertEqual(unavailable["reason"], "configured_model_unavailable")
        timeout = self.extract(lambda *_: (_ for _ in ()).throw(TimeoutError("bounded")))
        self.assertEqual(timeout["telemetry"]["inference_status"], "timeout")
        oom = self.extract(lambda *_: (_ for _ in ()).throw(MemoryError("bounded")))
        self.assertEqual(oom["telemetry"]["inference_status"], "oom")
        sampled = self.extract(lambda *_: LocalInferenceResult(candidate=OUTPUT, gpu_metrics_status="sampler_failed"))
        self.assertEqual(sampled["telemetry"]["gpu_metrics_status"], "sampler_failed")
        self.assertIsNone(sampled["telemetry"]["gpu_peak"])

    def test_master_specific_rollout_and_breaker_kill_switches_prevent_inference(self):
        cases = (
            ({**ACTIVE, "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "0"}, "quality_pipeline_disabled"),
            ({**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "0"}, "structured_extraction_canary_disabled"),
            ({**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "0"}, "rollout_zero"),
        )
        for environment, reason in cases:
            calls = []
            result = self.extract(lambda *_: calls.append(1), environment=environment)
            self.assertEqual(result["reason"], reason)
            self.assertEqual(calls, [])
        self.store.set_breaker("OPEN", "test")
        calls = []
        result = self.extract(lambda *_: calls.append(1))
        self.assertEqual(result["reason"], "circuit_breaker_not_closed")
        self.assertEqual(calls, [])

    def test_secret_or_unsupported_schema_is_control_bypass(self):
        secret = self.extract(lambda *_: OUTPUT, source="password=not-safe Record R-42 line 17 count 9")
        self.assertEqual(secret["reason"], "input_contract_not_supported")
        schema = {**SCHEMA, "additionalProperties": True}
        unsupported = self.extract(lambda *_: OUTPUT, schema=schema)
        self.assertEqual(unsupported["reason"], "input_contract_not_supported")

    def test_runtime_config_updater_preserves_unrelated_settings_and_disables_other_features(self):
        root = Path(self.temporary.name)
        config = root / "local-ai.json"; env = root / ".env"
        config.write_text(json.dumps({"endpoint": "private", "unrelated": 7}), encoding="utf-8")
        env.write_text("UNRELATED=value\nLOCAL_AI_RETRIEVAL_ENABLED=1\n", encoding="utf-8")
        runtime = root / "runtime.json"
        update_runtime_config(config, env, True, runtime)
        updated = json.loads(config.read_text(encoding="utf-8"))
        self.assertEqual(updated["unrelated"], 7)
        flags = updated["structured_extraction_canary"]["feature_flags"]
        self.assertTrue(flags["LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED"])
        self.assertFalse(flags["LOCAL_AI_RETRIEVAL_ENABLED"])
        self.assertIn("LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT=10", env.read_text(encoding="utf-8"))
        self.assertIn("LOCAL_AI_RETRIEVAL_ENABLED=0", env.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(runtime.read_text(encoding="utf-8"))["LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT"], 10)

    def test_repository_defaults_remain_disabled_zero(self):
        config, _ = effective_config(load_registry(), {}, {}, runtime_override={})
        self.assertFalse(config["master_switch"])
        self.assertFalse(config["structured_extraction"])
        self.assertEqual(config["rollout_percentage"], 0)

    def test_central_runtime_kill_switch_overrides_stale_process_environment(self):
        override = {
            "feature_flags": {
                "LOCAL_AI_QUALITY_PIPELINE_ENABLED": False,
                "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": False,
            },
            "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": 0,
        }
        config, _ = effective_config(load_registry(), {}, ACTIVE, runtime_override=override)
        self.assertFalse(config["master_switch"])
        self.assertFalse(config["structured_extraction"])
        self.assertEqual(config["rollout_percentage"], 0)


if __name__ == "__main__":
    unittest.main()
