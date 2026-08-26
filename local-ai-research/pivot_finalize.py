#!/usr/bin/env python3
"""Finalize skipped Phase D and the sanitized restricted-pivot aggregate."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "docs/benchmarks/local-ai-restricted-pivot"
FLAGS = {
    "structured_extraction": "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED",
    "summarize_log": "LOCAL_AI_SUMMARIZE_LOG_ENABLED",
    "retrieval": "LOCAL_AI_RETRIEVAL_ENABLED",
    "reranker": "LOCAL_AI_RERANKER_ENABLED",
    "error_similarity": "LOCAL_AI_ERROR_SIMILARITY_ENABLED",
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finalize_error_similarity(run_id: str, retrieval: dict[str, Any]) -> dict[str, Any]:
    directory = OUTPUT_ROOT / "error-similarity"
    directory.mkdir(parents=True, exist_ok=True)
    decision = "SKIPPED_NO_RETRIEVAL_ADVANTAGE"
    schema = {
        "type": "object",
        "properties": {
            "error_id": {"type": "string"},
            "candidate_pairs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "left_id": {"type": "string"},
                        "right_id": {"type": "string"},
                        "similarity": {"type": "number"},
                        "label": {"const": "possibly_related_requires_validation"},
                    },
                    "required": ["left_id", "right_id", "similarity", "label"],
                    "additionalProperties": False,
                },
            },
            "automatic_merge": {"const": False},
        },
        "required": ["error_id", "candidate_pairs", "automatic_merge"],
        "additionalProperties": False,
    }
    config = {
        "benchmark_run_id": run_id,
        "phase_condition": "retrieval_reranking == DEMONSTRATED",
        "observed_parent_decision": retrieval["decision"],
        "feature_flag": FLAGS["error_similarity"],
        "enabled_by_default": False,
        "automatic_merge": False,
        "fallback": "exact-signature-only",
    }
    dataset = {
        "status": "NOT_CONSTRUCTED_PHASE_SKIPPED",
        "cases": 0,
        "reason": decision,
        "private_runtime_used": False,
    }
    event = {
        "job_id": None,
        "task_id": None,
        "attempt_id": None,
        "activity": "error_similarity",
        "execution_mode": "benchmark",
        "model": None,
        "model_digest": None,
        "model_role": "embedding",
        "dataset": None,
        "case_id": None,
        "input_tokens": None,
        "output_tokens": None,
        "estimated_direct_gpt_context": None,
        "estimated_routed_gpt_context": None,
        "estimated_avoided_gpt_tokens": None,
        "validation_status": "NOT_TESTED",
        "accepted": False,
        "fallback_reason": decision,
        "critical_errors": [],
        "gpu_metrics_status": "NOT_TESTED",
        "gpu_peak": None,
        "vram_peak": None,
        "power_peak": None,
        "duration": None,
        "index_version": None,
        "index_freshness": None,
        "automatic_merge": False,
    }
    write_json(directory / "schema.json", schema)
    write_json(directory / "frozen-config.json", config)
    write_json(directory / "dataset-manifest.json", dataset)
    write_json(directory / "decision.json", {"decision": decision, "automatic_merge": False})
    write_json(directory / "latest.json", {
        "schema_version": 1,
        "suite": "local-ai-restricted-pivot-v1",
        "activity": "error_similarity",
        "benchmark_run_id": run_id,
        "benchmark_executed_at": utc_now(),
        "measurement_basis": {"embedding_inference": "NOT_TESTED", "gpu": "NOT_TESTED"},
        "dataset": dataset,
        "frozen_config": config,
        "results": [],
        "decision": decision,
        "automatic_merge": False,
        "production_enabled": False,
        "limitations": [
            "phase_skipped_by_predeclared_retrieval_gate",
            "no_similarity_dataset_or_inference",
        ],
    })
    (directory / "events.jsonl").write_text(json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    with (directory / "results.csv").open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerow(["case_id", "candidate_pair_recall_at_k", "precision_at_k", "false_relation_suggestions", "critical_auto_merges"])
    (directory / "report.md").write_text(
        "# Similaridade entre erros\n\n"
        f"Decisão: `{decision}` porque retrieval/reranking ficou `{retrieval['decision']}`. "
        "Nenhum dataset foi construído, nenhuma inferência foi executada e não existe auto-merge.\n\n"
        "Limitação: a fase foi pulada pelo gate pré-declarado; não há métricas semânticas.\n",
        encoding="utf-8",
    )
    return read_json(directory / "latest.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    structured = read_json(OUTPUT_ROOT / "structured-extraction-promotion/latest.json")
    logs = read_json(OUTPUT_ROOT / "summarize-log-validation/latest.json")
    retrieval = read_json(OUTPUT_ROOT / "retrieval-reranking/latest.json")
    for report in (structured, logs, retrieval):
        if report.get("benchmark_run_id") != args.run_id:
            raise SystemExit("pivot activity run-id mismatch")
    similarity = finalize_error_similarity(args.run_id, retrieval)
    decisions = {
        "structured_extraction": structured["decision"],
        "summarize_log": logs["decision"],
        "retrieval_reranking": retrieval["decision"],
        "error_similarity": "SKIPPED",
        "local_ai_expansion": "CONTINUE_RESTRICTED" if structured["decision"] == "PROMOTE_TO_CANARY" else "STOP_EXPANSION",
    }
    aggregate = {
        "schema_version": 1,
        "suite": "local-ai-restricted-pivot-v1",
        "benchmark_run_id": args.run_id,
        "benchmark_executed_at": utc_now(),
        "decisions": decisions,
        "feature_flags": FLAGS,
        "structured_extraction": {
            "model": structured["model"],
            "dataset": structured["dataset"],
            "promotion_holdout": structured["promotion_holdout"],
            "canary": structured["canary"],
            "production_enabled": False,
        },
        "summarize_log": {
            "dataset": logs["dataset"],
            "promotion_holdout": logs["promotion_holdout"],
            "additional_context_reduction_vs_deterministic": logs["additional_context_reduction_vs_deterministic"],
            "production_policy": "deterministic-only",
        },
        "retrieval_reranking": {
            "models": retrieval["models"],
            "dataset": retrieval["dataset"],
            "promotion_holdout": retrieval["promotion_holdout"],
            "index": retrieval["index"],
        },
        "error_similarity": {
            "decision": similarity["decision"],
            "automatic_merge": False,
            "measurement_basis": similarity["measurement_basis"],
        },
        "measurement_basis": {
            "structured_local_inference": "MEASURED",
            "summarize_log_local_inference": "MEASURED",
            "embedding_inference": "MEASURED",
            "reranking": "NOT_TESTED",
            "error_similarity": "NOT_TESTED",
            "gpt_direct_execution": "NOT_TESTED",
            "gpt_tokens": "NOT_TESTED",
            "benchmark_operational_savings": 0,
        },
        "rollback": {
            "target": "deterministic-to-gpt-direct",
            "persistent_index_created": False,
            "automatic_error_merge": False,
        },
    }
    activity_files = [
        OUTPUT_ROOT / name / "latest.json"
        for name in ("structured-extraction-promotion", "summarize-log-validation", "retrieval-reranking", "error-similarity")
    ]
    aggregate["artifact_hashes"] = {path.parent.name: file_hash(path) for path in activity_files}
    write_json(OUTPUT_ROOT / "latest.json", aggregate)
    print(json.dumps({"run_id": args.run_id, "decisions": decisions}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
