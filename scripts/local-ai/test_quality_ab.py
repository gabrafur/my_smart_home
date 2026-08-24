#!/usr/bin/env python3
"""Offline checks for the auditable Local AI quality benchmark report."""

import importlib.util
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("quality_ab", SCRIPT_DIR / "quality_ab.py")
assert SPEC and SPEC.loader
QUALITY_AB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUALITY_AB)


class QualityBenchmarkTest(unittest.TestCase):
    def test_report_separates_token_weighted_reduction_from_typical_case(self):
        results = [
            self.result("summarize-log", 1, useful=600, accepted=True, efficient=True),
            self.result("review-diff", 1, useful=0, accepted=False, efficient=False),
            self.result("summarize-log", 2, useful=400, accepted=True, efficient=True),
            self.result("review-diff", 2, useful=0, accepted=False, efficient=False),
        ]

        report = QUALITY_AB.summarize_results(
            results,
            model="generator",
            verifier_model="verifier",
            repetitions=2,
            fixture_hash="fixtures",
            prompt_hash="prompts",
        )

        self.assertEqual(report["benchmark_kind"], "offline_context_compression_with_fidelity_gate")
        self.assertEqual(report["suite"], "local-ai-quality-benchmark-v5")
        self.assertFalse(report["end_to_end_primary_model_evaluated"])
        self.assertFalse(report["operational_savings_proven"])
        self.assertEqual(report["confirmed_end_to_end_useful_tokens_avoided"], 0)
        self.assertTrue(report["independent_verifier"])
        self.assertEqual(report["token_weighted_useful_reduction_percent"], 25.0)
        self.assertEqual(report["median_useful_reduction_percent"], 20.0)
        self.assertEqual(report["quality_acceptance_rate_percent"], 50.0)
        self.assertEqual(report["efficiency_rate_percent"], 50.0)
        self.assertEqual(
            report["per_task"]["review-diff"]["median_useful_reduction_percent"],
            0,
        )
        self.assertEqual(
            report["per_task"]["summarize-log"]["token_weighted_useful_reduction_percent"],
            50.0,
        )
        self.assertEqual(report["per_split"]["holdout"]["observations"], 2)
        self.assertEqual(report["per_input_size_band"]["1200-2999"]["observations"], 4)
        self.assertEqual(report["uncertainty"]["method"], "fixture_cluster_bootstrap_2000_and_wilson_95")
        self.assertEqual(report["net_gain_tokens_distribution"]["zero_observations"], 2)

    def test_delivery_ab_requires_bound_code_mode_receipt_and_reports_final_percent(self):
        job_id = "12345678-1234-4234-8234-123456789abc"
        job = {
            "id": job_id,
            "task": "summarize-log",
            "invocation_source": "mcp",
            "status": "success",
            "quality_accepted": True,
            "quality_validation_tokens_measured": True,
            "quality_gate_type": "deterministic-log-anchors-v1",
            "verifier_model": "deterministic:log-anchors-v1",
            "quality_verification_attempts": 0,
            "quality_validation_tokens": 0,
            "context_input_chars": 16293,
            "context_input_tokens": 4074,
            "context_output_tokens": 149,
            "useful_context_tokens_avoided": 3925,
            "token_count_method": "tiktoken:o200k_base",
        }
        state = {
            "latest_jobs": [job],
            "deliveries": {"latest_receipts": [{
                "job_id": job_id,
                "task": "summarize-log",
                "transport": "code-mode-orchestrator-v1",
                "source_output_chars": 16293,
                "confirmed_at": "2026-08-24T13:17:47Z",
            }]},
        }

        report = QUALITY_AB.delivery_ab_report(state, job_id)
        self.assertEqual(report["suite"], "local-ai-delivery-ab-v6")
        self.assertTrue(report["operational_savings_proven"])
        self.assertTrue(report["primary_model_use_confirmed"])
        self.assertFalse(report["final_answer_quality_evaluated"])
        self.assertEqual(report["confirmed_end_to_end_useful_tokens_avoided"], 3925)
        self.assertEqual(report["final_useful_reduction_percent"], 96.3)

        state["deliveries"]["latest_receipts"][0]["source_output_chars"] = 16292
        with self.assertRaisesRegex(RuntimeError, "evidence_invalid"):
            QUALITY_AB.delivery_ab_report(state, job_id)

    @staticmethod
    def result(task, repetition, *, useful, accepted, efficient):
        return {
            "task": task,
            "repetition": repetition,
            "fixture_id": f"{task}-{repetition}",
            "fixture_split": "development" if repetition == 1 else "holdout",
            "input_size_band": "1200-2999",
            "quality_accepted": accepted,
            "gate_accepted": accepted,
            "oracle_accepted": accepted,
            "efficient": efficient,
            "control_tokens": 1000,
            "effective_tokens_sent_to_primary": 1000 - useful,
            "gross_useful_tokens_avoided": useful + (100 if accepted else 0),
            "quality_validation_tokens": 100 if accepted else 50,
            "quality_validation_tokens_measured": True,
            "useful_tokens_avoided": useful,
            "latency_seconds": 1.0,
            "token_count_method": "tiktoken:o200k_base",
        }


if __name__ == "__main__":
    unittest.main()
