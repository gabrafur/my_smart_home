#!/usr/bin/env python3
"""Deterministic workload matrix for the Local AI routing policy."""

from __future__ import annotations

import unittest

from routing import apply_economic_precheck, assess_routing, terminal_decision


class RoutingPolicyTest(unittest.TestCase):
    def test_workload_matrix_has_expected_decisions(self):
        cases = [
            ("typo-small", "review-diff", 120, True, "available", "DETERMINISTIC"),
            ("search-many-files", "inspect-files", 16_000, True, "available", "DETERMINISTIC"),
            ("diff-small", "review-diff", 2_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("diff-bounded", "review-diff", 10_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("diff-too-large", "review-diff", 24_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("pytest-small", "analyze-tests", 2_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("pytest-large", "analyze-tests", 32_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("log-short", "summarize-log", 1_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("log-below-validated-band", "summarize-log", 10_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("log-repeated-stack", "summarize-log", 36_000, False, "available", "LOCAL_AI_ELIGIBLE"),
            ("json-large", "inspect-files", 80_000, True, "available", "DETERMINISTIC"),
            ("file-triage-too-large", "inspect-files", 40_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("documentation-bounded", "summarize-document", 10_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("documentation-too-large", "summarize-document", 24_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("memory-small-focused", "summarize-memory", 2_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("memory-bounded-retrieval", "summarize-memory", 20_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("memory-too-large", "summarize-memory", 32_000, False, "available", "LOCAL_AI_NOT_BENEFICIAL"),
            ("gpu-unavailable", "summarize-log", 32_000, False, "unavailable", "LOCAL_AI_UNAVAILABLE"),
        ]
        for name, task, chars, deterministic, availability, expected in cases:
            with self.subTest(name=name):
                actual = assess_routing(
                    task,
                    chars,
                    deterministic_sufficient=deterministic,
                    availability=availability,
                )
                self.assertEqual(actual["decision"], expected)

    def test_missed_opportunity_requires_eligible_and_available_task(self):
        eligible = assess_routing("summarize-log", 32_000, availability="available")
        missed = terminal_decision(eligible, "skipped")
        self.assertEqual(missed["decision"], "ROUTING_MISSED_OPPORTUNITY")
        unavailable = assess_routing("summarize-log", 32_000, availability="unavailable")
        self.assertEqual(terminal_decision(unavailable, "skipped")["decision"], "LOCAL_AI_UNAVAILABLE")

    def test_small_and_low_compressibility_tasks_do_not_look_like_opportunities(self):
        small = assess_routing("summarize-log", 1_000)
        self.assertFalse(small["eligible"])
        self.assertEqual(small["decision"], "LOCAL_AI_NOT_BENEFICIAL")
        low = assess_routing("summarize-log", 40_000, compressibility="low")
        self.assertEqual(low["decision"], "LOCAL_AI_NOT_BENEFICIAL")

    def test_bounded_tasks_do_not_claim_savings_for_unseen_middle_content(self):
        assessment = assess_routing("summarize-document", 73_435, availability="available")

        self.assertFalse(assessment["eligible"])
        self.assertEqual(assessment["expected_tokens_saved"], 0)
        self.assertEqual(assessment["bounded_input_limit_tokens"], 3_000)
        self.assertEqual(assessment["reason"], "input_exceeds_bounded_context")

    def test_tasks_rejected_by_quality_ab_are_not_operational_candidates(self):
        for task in (
            "analyze-tests", "classify-error", "inspect-files", "review-diff",
            "summarize-document", "summarize-memory",
        ):
            with self.subTest(task=task):
                assessment = assess_routing(task, 10_000, availability="available")
                self.assertFalse(assessment["eligible"])
                self.assertEqual(assessment["reason"], "task_quality_not_validated")

    def test_signal_preprocessing_must_leave_positive_expected_net_savings(self):
        eligible = assess_routing("summarize-log", 40_000, availability="available")
        rejected = apply_economic_precheck(
            eligible,
            context_input_tokens=10_000,
            model_input_tokens=9_500,
        )
        accepted = apply_economic_precheck(
            eligible,
            context_input_tokens=10_000,
            model_input_tokens=1_000,
        )

        self.assertEqual(rejected["decision"], "LOCAL_AI_NOT_BENEFICIAL")
        self.assertEqual(rejected["reason"], "insufficient_expected_net_savings")
        self.assertEqual(accepted["decision"], "LOCAL_AI_ELIGIBLE")
        self.assertGreaterEqual(accepted["expected_net_tokens_saved"], 600)


if __name__ == "__main__":
    unittest.main()
