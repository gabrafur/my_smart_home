#!/usr/bin/env python3
"""Unit and integration tests for the high-potential Local AI benchmark."""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).with_name("high_potential_benchmark.py")
DATASET_GENERATOR = Path(__file__).with_name("high_potential_dataset.py")
HISTORICAL_V1 = (
    SCRIPT.parents[1]
    / "docs/benchmarks/local-ai-high-potential/history/v1-2026-08-24/latest.json"
)
SPEC = importlib.util.spec_from_file_location("high_potential_benchmark", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load benchmark module")
BENCHMARK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCHMARK)


class HighPotentialBenchmarkUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases, cls.inputs, cls.schemas = BENCHMARK.load_dataset(BENCHMARK.DATASET_DIR)
        cls.recomputed = BENCHMARK.recompute_existing_report(HISTORICAL_V1)

    def test_dataset_has_required_distribution_and_holdout(self):
        self.assertEqual(len(self.cases), 100)
        self.assertEqual(Counter(case["activity_class"] for case in self.cases), {
            "structured_extraction": 20,
            "classification": 20,
            "file_selection": 20,
            "error_clustering": 20,
            "diff_summary": 20,
        })
        self.assertEqual(sum(case["source_type"] == "real_anonymized" for case in self.cases), 70)
        self.assertEqual(sum(case["source_type"] == "synthetic" for case in self.cases), 30)
        self.assertEqual(sum(case["split"] == "calibration" for case in self.cases), 60)
        self.assertEqual(sum(case["split"] == "holdout" for case in self.cases), 40)

    def test_deterministic_arm_is_fixture_consistent_but_not_claimed_independent(self):
        audits = []
        for case in self.cases:
            source = self.inputs[case["case_id"]]
            schema = self.schemas[Path(case["schema_reference"]).name]
            audit = BENCHMARK.deterministic_audit(case, source, schema)
            audits.append(audit)
            with self.subTest(case=case["case_id"]):
                self.assertTrue(audit["deterministic_schema_valid"])
                self.assertTrue(audit["deterministic_quality_accepted"])
                self.assertEqual(audit["deterministic_critical_fact_recall"], 1.0)
                self.assertFalse(audit["deterministic_unsupported"])
        self.assertEqual(sum(item["deterministic_exact_match"] for item in audits), 40)
        provenance = self.recomputed["ground_truth_provenance"]
        self.assertEqual(provenance["status"], "INSUFFICIENT_EVIDENCE")
        self.assertIsNone(provenance["manual_review_evidence"])
        self.assertFalse(provenance["generated_by_evaluated_implementation"])
        self.assertTrue(provenance["created_in_same_commit_as_evaluated_implementation"])

    def test_ground_truth_is_hash_frozen_without_fabricated_independence(self):
        provenance = BENCHMARK.ground_truth_provenance(self.cases)
        expected_hash = BENCHMARK.stable_hash(BENCHMARK.ground_truth_payload(self.cases))
        self.assertEqual(provenance["frozen_hash"], expected_hash)
        changed = json.loads(json.dumps(self.cases))
        changed[0]["expected_output"]["audit_marker"] = "changed"
        self.assertNotEqual(
            expected_hash,
            BENCHMARK.stable_hash(BENCHMARK.ground_truth_payload(changed)),
        )
        generator_source = DATASET_GENERATOR.read_text(encoding="utf-8")
        for evaluated_function in (
            "deterministic_extract", "deterministic_classify", "deterministic_file_selection",
            "deterministic_cluster", "deterministic_diff", "deterministic_output",
        ):
            self.assertNotIn(evaluated_function, generator_source)

    def test_adversarial_guardrail_success_is_not_model_success(self):
        checks = BENCHMARK.adversarial_suite(self.cases, self.inputs, self.schemas)
        metrics = self.recomputed["adversarial_metrics"]
        self.assertEqual(len(checks), 20)
        self.assertTrue(all(item["passed"] for item in checks))
        self.assertEqual(metrics["adversarial_scenarios_total"], 20)
        self.assertEqual(metrics["adversarial_guardrails_passed"], 20)
        self.assertEqual(metrics["adversarial_model_outputs_accepted"], 0)
        self.assertEqual(metrics["adversarial_model_outputs_rejected"], 0)

    def test_recomputed_global_denominators_match_measured_v1_evidence(self):
        totals = self.recomputed["totals"]
        self.assertEqual(totals["total_cases"], 100)
        self.assertEqual(totals["eligible_cases"], 70)
        self.assertEqual(totals["non_eligible_cases"], 30)
        self.assertEqual(totals["rtx_attempted_cases"], 70)
        self.assertEqual(totals["local_inference_calls"], 86)
        self.assertEqual(totals["accepted_cases"], 27)
        self.assertEqual(totals["useful_cases"], 27)
        self.assertEqual(totals["fallback_cases"], 43)
        self.assertEqual(totals["rejected_cases"], 43)
        self.assertAlmostEqual(totals["useful_rtx_rate_among_attempts"], 27 / 70, places=4)
        self.assertAlmostEqual(totals["end_to_end_useful_coverage"], 27 / 100, places=4)
        self.assertAlmostEqual(totals["inferences_per_attempted_case"], 86 / 70, places=4)
        self.assertAlmostEqual(totals["fallback_rate_among_attempts"], 43 / 70, places=4)

    def test_every_activity_exposes_all_denominators(self):
        required = {
            "total_cases", "eligible_cases", "non_eligible_cases", "rtx_attempted_cases",
            "local_inference_calls", "accepted_cases", "rejected_cases", "fallback_cases",
            "useful_cases", "useful_rtx_rate_among_attempts", "end_to_end_useful_coverage",
            "class_eligibility_rate", "fallback_rate_among_attempts", "inferences_per_attempted_case",
        }
        for activity, summary in self.recomputed["per_activity_class"].items():
            with self.subTest(activity=activity):
                self.assertTrue(required.issubset(summary))
                self.assertEqual(summary["total_cases"], 20)
                self.assertEqual(summary["rtx_attempted_cases"], summary["eligible_cases"])
                self.assertEqual(summary["non_eligible_cases"], 20 - summary["eligible_cases"])
                self.assertAlmostEqual(
                    summary["fallback_rate_among_attempts"],
                    summary["fallback_cases"] / summary["rtx_attempted_cases"], places=4,
                )

    def test_critical_occurrences_are_distinct_from_unique_cases_and_inferences(self):
        totals = self.recomputed["totals"]
        self.assertEqual(totals["critical_error_occurrences"], 32)
        self.assertEqual(totals["cases_with_critical_error"], 25)
        self.assertAlmostEqual(totals["critical_case_rate_among_attempts"], 25 / 70, places=4)
        self.assertAlmostEqual(totals["critical_errors_per_inference"], 32 / 86, places=4)
        self.assertIsNone(totals["local_inferences_with_critical_error"])
        self.assertGreater(totals["critical_error_occurrences"], totals["cases_with_critical_error"])
        selection = self.recomputed["per_activity_class"]["file_selection"]
        self.assertEqual(selection["total_cases"], 20)
        self.assertEqual(selection["rtx_attempted_cases"], 16)
        self.assertEqual(selection["local_inference_calls"], 32)
        self.assertEqual(selection["cases_with_critical_error"], 10)

    def test_inference_reconciliation_deduplicates_jobs_and_detects_conflicts(self):
        base = {
            "job_id": "job-1", "case_id": "case-1",
            "attempt_id": "case-1:selected", "call_role": "selected",
        }
        duplicate = BENCHMARK.reconcile_inference_events([base, dict(base)])
        self.assertEqual(duplicate["local_inference_calls"], 1)
        self.assertEqual(duplicate["duplicate_event_records"], 1)
        self.assertEqual(duplicate["conflicting_job_ids"], [])
        conflicting = BENCHMARK.reconcile_inference_events([
            base,
            {**base, "case_id": "case-2", "attempt_id": "case-2:selected"},
        ])
        self.assertEqual(conflicting["conflicting_job_ids"], ["job-1"])
        self.assertEqual(self.recomputed["inference_reconciliation"]["local_inference_calls"], 86)
        self.assertEqual(self.recomputed["inference_reconciliation"]["duplicate_event_records"], 0)

    def test_token_names_and_measurement_basis_are_explicit(self):
        basis = self.recomputed["measurement_basis"]
        self.assertEqual(basis["gpt_tokens"], "estimated")
        self.assertEqual(basis["gpt_token_estimation_method"], "utf8_bytes_divided_by_4")
        self.assertEqual(basis["gpt_direct_execution"], "simulated")
        self.assertEqual(basis["local_inference"], "measured")
        self.assertEqual(basis["gpu_telemetry"], "measured")
        totals = self.recomputed["totals"]
        self.assertEqual(totals["estimated_avoided_gpt_tokens"], 88748)
        self.assertAlmostEqual(
            totals["estimated_weighted_gpt_context_reduction"], 88748 / 237627, places=6,
        )
        self.assertNotIn("weighted_token_savings", totals)
        self.assertTrue(totals["legacy_metric_aliases"]["deprecated"])

    def test_policy_keeps_all_five_activities_out_of_production(self):
        policy = self.recomputed["operational_policy"]
        self.assertEqual(policy["summarize_log"]["decision"], "SEPARATE_BENCHMARK")
        for activity in BENCHMARK.QUALITY_THRESHOLDS:
            with self.subTest(activity=activity):
                item = policy[activity]
                self.assertEqual(item["decision"], "DETERMINISTIC_FIRST")
                self.assertFalse(item["production_local_ai_enabled"])
                self.assertEqual(item["unresolved_fallback"], "gpt-direct")
                self.assertFalse(
                    self.recomputed["per_activity_class"][activity]["rtx_operational_advantage"]
                )
        self.assertEqual(policy["classification"]["local_ai_mode"], "disabled")
        self.assertEqual(policy["diff_summary"]["local_ai_mode"], "disabled")
        for activity in ("structured_extraction", "file_selection", "error_clustering"):
            self.assertEqual(policy[activity]["local_ai_mode"], "shadow")
        self.assertTrue(self.recomputed["excluded_from_production_metrics"])

    def test_rejected_output_falls_back_and_saves_zero(self):
        case = next(
            case for case in self.cases
            if case["activity_class"] == "structured_extraction" and case["expected_eligible"]
        )
        source = self.inputs[case["case_id"]]
        schema = self.schemas[Path(case["schema_reference"]).name]
        result, event = BENCHMARK.finalize_case(
            case, source, schema,
            {
                "job_id": "00000000-0000-4000-8000-000000000001", "status": "success",
                "output": {}, "duration_seconds": 1.0, "local_input_tokens": 10,
                "local_output_tokens": 2, "local_attempts": 1, "model": "fixture-model",
                "gpu_metrics_status": "not_observed",
            },
            BENCHMARK.deterministic_output(case, source), 0.001, 0.0001, mode="simulated",
        )
        self.assertEqual(result["quality_status"], "invalid")
        self.assertTrue(result["full_context_fallback"])
        self.assertEqual(result["estimated_routed_gpt_tokens"], result["estimated_baseline_gpt_tokens"])
        self.assertEqual(result["estimated_avoided_gpt_tokens"], 0)
        self.assertFalse(result["validated_estimated_context_reduction"])
        self.assertTrue(event["excluded_from_production_metrics"])

    def test_gpu_absence_is_not_reported_as_zero(self):
        sampler = type("Sampler", (), {"snapshots": []})()
        metrics = BENCHMARK.gpu_summary(sampler, 2.0, True)
        self.assertEqual(metrics["gpu_metrics_status"], "sampler_failed")
        self.assertIsNone(metrics["gpu_mean_percent"])
        self.assertIsNone(metrics["vram_peak_mib"])


class HighPotentialBenchmarkIntegrationTests(unittest.TestCase):
    def test_recomputed_report_validates_against_v2_schema_and_exports(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = BENCHMARK.recompute_existing_report(HISTORICAL_V1)
            output_dir = Path(temporary)
            BENCHMARK.write_artifacts(report, output_dir)
            schema = json.loads(
                (BENCHMARK.DATASET_DIR / "schemas/report-v2.json").read_text(encoding="utf-8")
            )
            self.assertEqual(BENCHMARK.schema_errors(report, schema), [])
            self.assertTrue(report["results_recomputed_from_existing_raw_artifacts"])
            self.assertIsNone(report["benchmark_rerun_reason"])
            self.assertEqual(report["source_artifact"]["schema_version"], 1)
            for filename in (
                "latest.json", "cases.csv", "classification-confusion-matrix.csv",
                "activity-table.csv", "report.md", "events.jsonl",
            ):
                self.assertTrue((output_dir / filename).is_file(), filename)
            with (output_dir / "activity-table.csv").open(encoding="utf-8", newline="") as handle:
                headers = next(csv.reader(handle))
            self.assertIn("useful_rtx_rate_among_attempts", headers)
            self.assertIn("end_to_end_useful_coverage", headers)
            self.assertIn("critical_error_occurrences", headers)
            self.assertNotIn("weighted_token_savings", headers)
            for filename in ("cases.csv", "classification-confusion-matrix.csv", "activity-table.csv"):
                self.assertNotIn(b"\r", (output_dir / filename).read_bytes(), filename)

    def test_full_simulated_benchmark_exports_separated_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = argparse.Namespace(
                mode="simulated", dataset_dir=BENCHMARK.DATASET_DIR,
                output_dir=Path(temporary), split="all", model="simulated:model",
                benchmark_run_id="00000000-0000-4000-8000-000000000100",
                limit=None, no_artifacts=False, quiet=True, compare_file_selection=True,
            )
            report = BENCHMARK.run_benchmark(args)
            BENCHMARK.write_artifacts(report, args.output_dir)
            schema = json.loads(
                (BENCHMARK.DATASET_DIR / "schemas/report-v2.json").read_text(encoding="utf-8")
            )
            self.assertEqual(BENCHMARK.schema_errors(report, schema), [])
            self.assertEqual(report["schema_version"], 2)
            self.assertEqual(report["totals"]["total_cases"], 100)
            self.assertEqual(report["totals"]["eligible_cases"], 70)
            self.assertEqual(report["totals"]["local_inference_calls"], 86)
            self.assertEqual(report["dataset"]["real_anonymized"], 70)
            self.assertEqual(report["adversarial_metrics"]["adversarial_guardrails_passed"], 20)
            self.assertAlmostEqual(
                report["totals"]["estimated_weighted_gpt_context_reduction"],
                (
                    report["totals"]["estimated_baseline_gpt_tokens"]
                    - report["totals"]["estimated_routed_gpt_tokens"]
                ) / report["totals"]["estimated_baseline_gpt_tokens"],
                places=6,
            )
            self.assertIn("macro_f1", report["per_activity_class"]["classification"]["objective_metrics"])
            self.assertIn("hybrid_comparison", report["per_activity_class"]["file_selection"])
            self.assertTrue(all(event["execution_mode"] == "benchmark" for event in report["benchmark_events"]))
            self.assertTrue(all(event["excluded_from_production_metrics"] for event in report["benchmark_events"]))
            self.assertEqual(report["inference_reconciliation"]["local_inference_calls"], 86)
            self.assertEqual(report["inference_reconciliation"]["conflicting_job_ids"], [])


if __name__ == "__main__":
    unittest.main()
