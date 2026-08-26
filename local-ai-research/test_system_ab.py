#!/usr/bin/env python3
"""Regression tests for the weighted end-to-end routing A/B report."""

import importlib.util
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("system_ab", SCRIPT_DIR / "system_ab.py")
assert SPEC and SPEC.loader
SYSTEM_AB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYSTEM_AB)


class SystemWorkloadABTest(unittest.TestCase):
    def test_workload_has_two_cases_per_required_class_and_weights_sum_to_100(self):
        cases = SYSTEM_AB.workload_cases()
        self.assertEqual(sum(SYSTEM_AB.WORKLOAD_WEIGHTS.values()), 100)
        self.assertEqual(len(cases), 14)
        for class_name in SYSTEM_AB.WORKLOAD_WEIGHTS:
            self.assertEqual(sum(case["class"] == class_name for case in cases), 2)

    def test_summary_keeps_ineligible_classes_in_weighted_denominator(self):
        results = []
        for class_name in SYSTEM_AB.WORKLOAD_WEIGHTS:
            used = class_name == "logs"
            results.append({
                "class": class_name,
                "rtx_used": used,
                "routing_latency_seconds": 2.0 if used else 0.1,
                "baseline": self.arm(1000, {"value": class_name}),
                "routed": self.arm(500 if used else 1000, {"value": class_name}),
            })
        report = SYSTEM_AB.summarize(
            results,
            model="gpt-5.6-terra",
            reasoning="medium",
            fixture_hash="fixtures",
        )
        self.assertEqual(report["baseline_gpt_tokens"], 100000)
        self.assertEqual(report["routed_gpt_tokens"], 91000)
        self.assertEqual(report["weighted_token_savings_percent"], 9.0)
        self.assertEqual(report["eligible_task_token_savings_percent"], 50.0)
        self.assertTrue(report["quality_equivalent"])
        self.assertTrue(report["benchmark_approved"])
        self.assertEqual(report["per_class"]["rtx_ineligible"]["token_savings_percent"], 0.0)

    @staticmethod
    def arm(tokens, facts):
        return {
            "success": True,
            "quality_ok": True,
            "input_tokens": tokens,
            "latency_seconds": 1.0,
            "facts": facts,
        }


if __name__ == "__main__":
    unittest.main()
