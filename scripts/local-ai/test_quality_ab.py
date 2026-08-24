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
        self.assertFalse(report["end_to_end_primary_model_evaluated"])
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

    @staticmethod
    def result(task, repetition, *, useful, accepted, efficient):
        return {
            "task": task,
            "repetition": repetition,
            "quality_accepted": accepted,
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
