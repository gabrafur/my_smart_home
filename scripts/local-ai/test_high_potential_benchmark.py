#!/usr/bin/env python3
"""Unit and integration tests for the high-potential Local AI benchmark."""

from __future__ import annotations

import argparse
import importlib.util
import tempfile
import unittest
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).with_name("high_potential_benchmark.py")
SPEC = importlib.util.spec_from_file_location("high_potential_benchmark", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load benchmark module")
BENCHMARK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCHMARK)


class HighPotentialBenchmarkUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases, cls.inputs, cls.schemas = BENCHMARK.load_dataset(BENCHMARK.DATASET_DIR)

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

    def test_all_deterministic_arms_pass_ground_truth(self):
        for case in self.cases:
            with self.subTest(case=case["case_id"]):
                source = self.inputs[case["case_id"]]
                schema = self.schemas[Path(case["schema_reference"]).name]
                output = BENCHMARK.deterministic_output(case, source)
                self.assertTrue(BENCHMARK.evaluate_output(case, output, schema, source)["core_accepted"])

    def test_adversarial_contracts_fail_closed(self):
        checks = BENCHMARK.adversarial_suite(self.cases, self.inputs, self.schemas)
        self.assertEqual(len(checks), 20)
        self.assertTrue(all(item["passed"] for item in checks))

    def test_rejected_output_falls_back_and_saves_zero(self):
        case = next(case for case in self.cases if case["activity_class"] == "structured_extraction" and case["expected_eligible"])
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
        self.assertEqual(result["routed_gpt_tokens"], result["baseline_gpt_tokens"])
        self.assertEqual(result["avoided_gpt_tokens"], 0)
        self.assertTrue(event["excluded_from_production_metrics"])

    def test_gpu_absence_is_not_reported_as_zero(self):
        sampler = type("Sampler", (), {"snapshots": []})()
        metrics = BENCHMARK.gpu_summary(sampler, 2.0, True)
        self.assertEqual(metrics["gpu_metrics_status"], "sampler_failed")
        self.assertIsNone(metrics["gpu_mean_percent"])
        self.assertIsNone(metrics["vram_peak_mib"])


class HighPotentialBenchmarkIntegrationTests(unittest.TestCase):
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
            self.assertEqual(report["totals"]["cases"], 100)
            self.assertEqual(report["dataset"]["real_anonymized"], 70)
            self.assertEqual(report["adversarial_cases_passed"], 20)
            self.assertAlmostEqual(
                report["totals"]["weighted_token_savings"],
                (report["totals"]["baseline_gpt_tokens"] - report["totals"]["routed_gpt_tokens"])
                / report["totals"]["baseline_gpt_tokens"],
                places=6,
            )
            self.assertIn("macro_f1", report["per_activity_class"]["classification"]["objective_metrics"])
            self.assertIn("hybrid_comparison", report["per_activity_class"]["file_selection"])
            self.assertTrue(all(event["execution_mode"] == "benchmark" for event in report["benchmark_events"]))
            self.assertTrue(all(event["excluded_from_production_metrics"] for event in report["benchmark_events"]))
            self.assertEqual(len({event["job_id"] for event in report["benchmark_events"] if event["job_id"]}), len([event for event in report["benchmark_events"] if event["job_id"]]))
            for filename in (
                "latest.json", "cases.csv", "classification-confusion-matrix.csv",
                "activity-table.csv", "report.md", "events.jsonl",
            ):
                self.assertTrue((args.output_dir / filename).is_file(), filename)
            for filename in ("cases.csv", "classification-confusion-matrix.csv", "activity-table.csv"):
                self.assertNotIn(b"\r", (args.output_dir / filename).read_bytes(), filename)


if __name__ == "__main__":
    unittest.main()
