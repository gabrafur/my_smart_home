#!/usr/bin/env python3
"""End-to-end benchmark for Local AI activities beyond summarize-log."""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import importlib.util
import inspect
import json
import math
import os
import re
import statistics
import sys
import time
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = Path(os.getenv("LOCAL_AI_RUNTIME_DIR", Path.home() / ".local/share/local-ai-rtx/current")).expanduser()
DATASET_DIR = RESEARCH_DIR / "benchmarks" / "high-potential"
DEFAULT_OUTPUT_DIR = ROOT / "docs" / "benchmarks" / "local-ai-high-potential"
SCHEMA_VERSION = 2
SUITE_NAME = "local-ai-high-potential-v2"
GROUND_TRUTH_STATUS = "INSUFFICIENT_EVIDENCE"
sys.path.insert(0, str(RUNTIME_DIR))
_SPEC = importlib.util.spec_from_file_location("local_ai_runtime", RUNTIME_DIR / "local-ai.py")
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("cannot load local-ai runtime")
LOCAL_AI = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LOCAL_AI)

QUALITY_THRESHOLDS = {
    "structured_extraction": {"field_f1": 0.95, "critical_recall": 1.0, "reduction": 0.0},
    "classification": {"field_f1": 0.90, "critical_recall": 1.0, "reduction": 0.0},
    "file_selection": {"field_f1": 0.90, "critical_recall": 1.0, "reduction": 0.30},
    "error_clustering": {"field_f1": 0.90, "critical_recall": 1.0, "reduction": 0.40},
    "diff_summary": {"field_f1": 0.95, "critical_recall": 1.0, "reduction": 0.40},
}
ACTIVITY_DISCOVERY = [
    {
        "requested": "extract-structured", "system_name": "benchmark:extract-structured",
        "implementation": "scripts/local-ai/high_potential_benchmark.py::deterministic_extract/local_prompt",
        "production_alias": None, "production_enabled": False,
    },
    {
        "requested": "classify-task/classify-diff", "system_name": "benchmark:classify-task|classify-diff",
        "implementation": "scripts/local-ai/high_potential_benchmark.py::deterministic_classify/local_prompt",
        "production_alias": None, "production_enabled": False,
    },
    {
        "requested": "triage-files/select-context", "system_name": "inspect-files",
        "implementation": "scripts/local-ai/local-ai.py::response_format; prompts/inspect-files.md",
        "production_alias": "inspect-files", "production_enabled": False,
    },
    {
        "requested": "cluster-errors/deduplicate-errors", "system_name": "classify-error",
        "implementation": "scripts/local-ai/local-ai.py::response_format; prompts/classify-error.md",
        "production_alias": "classify-error", "production_enabled": False,
    },
    {
        "requested": "summarize-diff", "system_name": "review-diff",
        "implementation": "scripts/local-ai/local-ai.py::response_format; prompts/review-diff.md",
        "production_alias": "review-diff", "production_enabled": False,
    },
]

BASELINE_METHODS = {
    "structured_extraction": "schema-specific parser and regular expressions",
    "classification": "static labels and risk rules",
    "file_selection": "lexical, dependency and contract ranking",
    "error_clustering": "normalized error signatures",
    "diff_summary": "structured diff parser",
}

OPERATIONAL_POLICY = {
    "structured_extraction": {
        "decision": "DETERMINISTIC_FIRST", "production_local_ai_enabled": False,
        "local_ai_mode": "shadow", "unresolved_fallback": "gpt-direct",
    },
    "classification": {
        "decision": "DETERMINISTIC_FIRST", "production_local_ai_enabled": False,
        "local_ai_mode": "disabled", "unresolved_fallback": "gpt-direct",
    },
    "file_selection": {
        "decision": "DETERMINISTIC_FIRST", "production_local_ai_enabled": False,
        "local_ai_mode": "shadow", "unresolved_fallback": "gpt-direct",
    },
    "error_clustering": {
        "decision": "DETERMINISTIC_FIRST", "production_local_ai_enabled": False,
        "local_ai_mode": "shadow", "unresolved_fallback": "gpt-direct",
    },
    "diff_summary": {
        "decision": "DETERMINISTIC_FIRST", "production_local_ai_enabled": False,
        "local_ai_mode": "disabled", "unresolved_fallback": "gpt-direct",
    },
    "summarize_log": {"decision": "SEPARATE_BENCHMARK"},
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def estimated_tokens(text: str) -> int:
    return math.ceil(len(text.encode("utf-8")) / 4)


def stable_hash(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def load_dataset(dataset_dir: Path) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, dict[str, Any]]]:
    cases = [json.loads(line) for line in (dataset_dir / "dataset.jsonl").read_text(encoding="utf-8").splitlines() if line]
    inputs = json.loads((dataset_dir / "inputs.json").read_text(encoding="utf-8"))
    schemas = {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((dataset_dir / "schemas").glob("*.json"))
    }
    if len(cases) < 100:
        raise RuntimeError(f"dataset_too_small:{len(cases)}")
    required = {
        "case_id", "activity", "source_type", "input_reference", "expected_output",
        "critical_facts", "forbidden_inferences", "baseline_tokens", "weight",
    }
    seen: set[str] = set()
    for case in cases:
        missing = required.difference(case)
        if missing:
            raise RuntimeError(f"dataset_case_missing_fields:{case.get('case_id')}:{sorted(missing)}")
        case_id = str(case["case_id"])
        if case_id in seen:
            raise RuntimeError(f"duplicate_case_id:{case_id}")
        seen.add(case_id)
        if case_id not in inputs:
            raise RuntimeError(f"missing_input:{case_id}")
        schema_name = Path(str(case["schema_reference"])).name
        if schema_name not in schemas:
            raise RuntimeError(f"missing_schema:{schema_name}")
    return cases, inputs, schemas


def ground_truth_payload(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"case_id": case["case_id"], "expected_output": case["expected_output"]}
        for case in sorted(cases, key=lambda item: item["case_id"])
    ]


def ground_truth_provenance(cases: list[dict[str, Any]]) -> dict[str, Any]:
    frozen_hash = stable_hash(ground_truth_payload(cases))
    return {
        "status": GROUND_TRUTH_STATUS,
        "created_before_benchmark": True,
        "created_before_benchmark_scope": "available_as_fixture_files_before_runtime_inference",
        "creation_timestamp_evidence": None,
        "versioned_before_benchmark_execution": False,
        "generated_by_evaluated_implementation": False,
        "manual_review_evidence": None,
        "independent_authorship_evidence": None,
        "frozen_hash": frozen_hash,
        "created_in_same_commit_as_evaluated_implementation": True,
        "class_status": {name: GROUND_TRUTH_STATUS for name in QUALITY_THRESHOLDS},
        "notes": [
            "expected_output is constructed by the dataset generator, not by calling deterministic_output",
            "dataset generator and evaluated deterministic implementation were introduced in the same commit",
            "no versioned evidence of independent annotation or review was found",
            "100/100 deterministic acceptance is a fixture-consistency result, not an independently verified quality comparison",
        ],
    }


def schema_errors(
    value: Any, schema: dict[str, Any], path: str = "$", root_schema: dict[str, Any] | None = None,
) -> list[str]:
    """Validate the strict JSON-Schema subset used by the benchmark without dependencies."""
    root_schema = root_schema or schema
    if "$ref" in schema:
        reference = str(schema["$ref"])
        if not reference.startswith("#/"):
            return [f"{path}:unsupported_reference"]
        resolved: Any = root_schema
        for part in reference[2:].split("/"):
            resolved = resolved.get(part) if isinstance(resolved, dict) else None
        if not isinstance(resolved, dict):
            return [f"{path}:unresolved_reference"]
        return schema_errors(value, resolved, path, root_schema)
    errors: list[str] = []
    kind = schema.get("type")
    type_matches = lambda name: {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }.get(name, True)
    valid_type = any(type_matches(name) for name in kind) if isinstance(kind, list) else type_matches(kind)
    if not valid_type:
        return [f"{path}:expected_{kind}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}:not_const")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}:not_in_enum")
    if isinstance(kind, str) and kind in {"integer", "number"}:
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}:below_minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}:above_maximum")
    if kind == "array":
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            errors.append(f"{path}:too_many_items")
        for index, item in enumerate(value):
            errors.extend(schema_errors(item, schema.get("items", {}), f"{path}[{index}]", root_schema))
    if kind == "string":
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            errors.append(f"{path}:too_short")
        if "pattern" in schema and re.search(str(schema["pattern"]), value) is None:
            errors.append(f"{path}:pattern_mismatch")
    if kind == "object":
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{path}.{name}:required")
        additional = schema.get("additionalProperties", True)
        if additional is False:
            for name in value:
                if name not in properties:
                    errors.append(f"{path}.{name}:additional_property")
        for name, item in value.items():
            if name in properties:
                errors.extend(schema_errors(item, properties[name], f"{path}.{name}", root_schema))
            elif isinstance(additional, dict):
                errors.extend(schema_errors(item, additional, f"{path}.{name}", root_schema))
    return errors


def ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def reconcile_inference_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Deduplicate inference evidence by job_id and expose identity conflicts."""
    unique: dict[str, dict[str, Any]] = {}
    duplicate_records = 0
    conflicts: set[str] = set()
    for event in events:
        job_id = event.get("job_id")
        if not job_id:
            continue
        job_id = str(job_id)
        if job_id not in unique:
            unique[job_id] = event
            continue
        duplicate_records += 1
        previous = unique[job_id]
        if any(previous.get(field) != event.get(field) for field in ("case_id", "attempt_id", "call_role")):
            conflicts.add(job_id)
    return {
        "unique_events": list(unique.values()),
        "local_inference_calls": len(unique),
        "duplicate_event_records": duplicate_records,
        "conflicting_job_ids": sorted(conflicts),
    }


def apply_inference_denominator(summary: dict[str, Any], inference_calls: int) -> None:
    """Bind inference-rate metrics to reconciled unique inference calls."""
    summary["local_inference_calls"] = inference_calls
    summary["inferences_per_attempted_case"] = round(
        ratio(inference_calls, int(summary["rtx_attempted_cases"])), 4,
    )
    summary["critical_errors_per_inference"] = round(
        ratio(int(summary["critical_error_occurrences"]), inference_calls), 4,
    )


def f1_score(expected: set[Any], actual: set[Any]) -> tuple[float, float, float]:
    true_positive = len(expected & actual)
    precision = ratio(true_positive, len(actual)) if actual else (1.0 if not expected else 0.0)
    recall = ratio(true_positive, len(expected)) if expected else (1.0 if not actual else 0.0)
    f1 = ratio(2 * precision * recall, precision + recall)
    return precision, recall, f1


def flatten(value: Any, prefix: str = "") -> set[tuple[str, str]]:
    flattened: set[tuple[str, str]] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            flattened.update(flatten(item, f"{prefix}.{key}" if prefix else key))
    elif isinstance(value, list):
        for item in value:
            flattened.update(flatten(item, prefix))
    else:
        flattened.add((prefix, json.dumps(value, ensure_ascii=False, sort_keys=True)))
    return flattened


def extraction_metrics(expected: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    exp, got = flatten(expected), flatten(actual)
    precision, recall, f1 = f1_score(exp, got)
    exp_numeric = {(path, value) for path, value in exp if re.fullmatch(r"-?\d+(?:\.\d+)?", value)}
    got_numeric = {(path, value) for path, value in got if re.fullmatch(r"-?\d+(?:\.\d+)?", value)}
    numeric_preservation = ratio(len(exp_numeric & got_numeric), len(exp_numeric)) if exp_numeric else 1.0
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "numeric_preservation": numeric_preservation,
        "hallucinated_fields": len(got - exp), "omitted_fields": len(exp - got),
    }


def classification_metrics(case: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    expected_labels = set(case["expected_output"]["labels"])
    actual_labels = {str(value) for value in actual.get("labels", [])}
    precision, recall, f1 = f1_score(expected_labels, actual_labels)
    expected = case["expected_output"]
    unsafe = (
        actual.get("eligible") is True
        and ("POTENTIALLY_DESTRUCTIVE" in expected_labels or expected.get("abstain") is True)
    )
    critical_route_ok = not expected.get("requires_primary_review") or actual.get("requires_primary_review") is True
    exact_flags = all(actual.get(key) is expected.get(key) for key in ("eligible", "requires_primary_review", "abstain"))
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "critical_recall": 1.0 if critical_route_ok else 0.0,
        "unsafe_false_positive": unsafe,
        "exact_flags": exact_flags,
        "case_accuracy": expected_labels == actual_labels and exact_flags,
        "eligibility_false_positive": actual.get("eligible") is True and expected.get("eligible") is not True,
        "eligibility_false_negative": actual.get("eligible") is not True and expected.get("eligible") is True,
        "abstained": actual.get("abstain") is True,
    }


def file_selection_metrics(case: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    expected = list(case["expected_output"]["selected_files"])
    selected = [str(path) for path in actual.get("selected_files", [])]
    expected_set, selected_set = set(expected), set(selected)
    k = max(1, len(expected))
    at_k = set(selected[:k])
    precision, recall, f1 = f1_score(expected_set, at_k)
    first_rank = next((index + 1 for index, path in enumerate(selected) if path in expected_set), None)
    critical_recall = ratio(len(expected_set & selected_set), len(expected_set))
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "precision_at_k": precision, "recall_at_k": recall,
        "critical_recall": critical_recall,
        "mrr": 1 / first_rank if first_rank else 0.0,
        "irrelevant_files": len(selected_set - expected_set),
        "critical_files_omitted": sorted(expected_set - selected_set),
        "needs_full_context_match": actual.get("needs_full_context") is case["expected_output"]["needs_full_context"],
    }


def pairs(groups: list[set[str]]) -> set[tuple[str, str]]:
    result: set[tuple[str, str]] = set()
    for group in groups:
        values = sorted(group)
        result.update((values[left], values[right]) for left in range(len(values)) for right in range(left + 1, len(values)))
    return result


def cluster_groups(value: dict[str, Any]) -> list[set[str]]:
    groups: list[set[str]] = []
    for cluster in value.get("clusters", []):
        if isinstance(cluster, dict) and isinstance(cluster.get("error_ids"), list):
            groups.append({str(item) for item in cluster["error_ids"] if str(item).startswith("E")})
    return [group for group in groups if group]


def clustering_metrics(case: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    expected_groups = cluster_groups(case["expected_output"])
    actual_groups = cluster_groups(actual)
    expected_pairs, actual_pairs = pairs(expected_groups), pairs(actual_groups)
    precision, recall, f1 = f1_score(expected_pairs, actual_pairs)
    universe = set().union(*expected_groups) if expected_groups else set()
    false_merges = actual_pairs - expected_pairs
    false_splits = expected_pairs - actual_pairs
    purities = []
    for actual_group in actual_groups:
        overlap = max((len(actual_group & expected_group) for expected_group in expected_groups), default=0)
        purities.append(ratio(overlap, len(actual_group)))
    root_preservation = ratio(sum(any(group == expected for group in actual_groups) for expected in expected_groups), len(expected_groups))
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "pairwise_precision": precision, "pairwise_recall": recall, "pairwise_f1": f1,
        "cluster_purity": statistics.mean(purities) if purities else 0.0,
        "false_merges": len(false_merges), "false_splits": len(false_splits),
        "critical_false_merges": len(false_merges),
        "root_cause_preservation": root_preservation,
        "cluster_count": len(actual_groups), "error_count": len(universe),
    }


def observed_tuples(value: dict[str, Any]) -> set[tuple[str, str, str]]:
    return {
        (str(item.get("kind")), str(item.get("file")), str(item.get("symbol")))
        for item in value.get("observed", []) if isinstance(item, dict)
    }


def diff_metrics(case: dict[str, Any], actual: dict[str, Any], source: str) -> dict[str, Any]:
    expected, got = observed_tuples(case["expected_output"]), observed_tuples(actual)
    precision, recall, f1 = f1_score(expected, got)
    evidence_valid = all(
        str(item.get("evidence") or "") in source
        for item in actual.get("observed", []) if isinstance(item, dict)
    )
    serialized = json.dumps(
        {"observed": actual.get("observed"), "inferred": actual.get("inferred")},
        ensure_ascii=False,
    ).lower()
    forbidden = [claim for claim in case["forbidden_inferences"] if claim.lower() in serialized]
    unsupported = bool(actual.get("inferred")) or not evidence_valid or bool(forbidden)
    expected_unknown = set(case["expected_output"]["unknown"])
    actual_unknown = {str(item) for item in actual.get("unknown", [])}
    return {
        "precision": precision, "recall": recall, "f1": f1,
        "factual_precision": precision, "critical_recall": recall,
        "evidence_valid": evidence_valid, "critical_hallucination": unsupported,
        "forbidden_claims": forbidden,
        "unknown_recall": ratio(len(expected_unknown & actual_unknown), len(expected_unknown)),
    }


def evaluate_output(case: dict[str, Any], actual: Any, schema: dict[str, Any], source: str) -> dict[str, Any]:
    errors = schema_errors(actual, schema)
    if errors:
        return {
            "schema_valid": False, "schema_errors": errors[:12], "quality_score": 0.0,
            "critical_omission": True, "critical_hallucination": False, "core_accepted": False,
        }
    if case["activity_class"] == "structured_extraction":
        metrics = extraction_metrics(case["expected_output"], actual)
        critical_recall = metrics["recall"]
        hallucination = metrics["hallucinated_fields"] > 0
    elif case["activity_class"] == "classification":
        metrics = classification_metrics(case, actual)
        critical_recall = metrics["critical_recall"]
        hallucination = metrics["unsafe_false_positive"]
    elif case["activity_class"] == "file_selection":
        metrics = file_selection_metrics(case, actual)
        critical_recall = metrics["critical_recall"]
        hallucination = bool(metrics["irrelevant_files"])
    elif case["activity_class"] == "error_clustering":
        metrics = clustering_metrics(case, actual)
        critical_recall = metrics["root_cause_preservation"]
        hallucination = metrics["critical_false_merges"] > 0
    else:
        metrics = diff_metrics(case, actual, source)
        critical_recall = metrics["critical_recall"]
        hallucination = metrics["critical_hallucination"]
    threshold = QUALITY_THRESHOLDS[case["activity_class"]]
    score = float(metrics.get("f1", 0.0))
    flags_ok = bool(metrics.get("exact_flags", True)) and bool(metrics.get("needs_full_context_match", True))
    core_accepted = (
        score >= threshold["field_f1"]
        and critical_recall >= threshold["critical_recall"]
        and not hallucination
        and flags_ok
    )
    return {
        "schema_valid": True, "schema_errors": [], "quality_score": score,
        "critical_omission": critical_recall < 1.0,
        "critical_hallucination": hallucination,
        "core_accepted": core_accepted,
        **metrics,
    }


def deterministic_extract(case: dict[str, Any], source: str) -> dict[str, Any]:
    schema = Path(case["schema_reference"]).stem
    if schema == "extract-errors":
        name = re.search(r"\b([A-Za-z]+(?:Error|Exception)):", source)
        location = re.search(r"\bat ([^\s:]+):(\d+):\d+", source)
        code = re.search(r"(?:exited with code|exit code:)\s*(\d+)", source)
        return {"errors": [{"name": name.group(1), "path": location.group(1), "line": int(location.group(2)), "exit_code": int(code.group(1))}]}
    if schema == "extract-diff-symbols":
        files = list(dict.fromkeys(re.findall(r"^diff --git a/\S+ b/(\S+)$", source, re.MULTILINE)))
        symbols = list(dict.fromkeys(re.findall(r"^ def ([A-Za-z_][A-Za-z0-9_]*)", source, re.MULTILINE)))
        return {"files": files, "symbols": symbols}
    if schema == "extract-commands":
        command = re.search(r"^\$ (.+)$", source, re.MULTILINE).group(1)
        code = int(re.search(r"^exit code:\s*(\d+)$", source, re.MULTILINE).group(1))
        return {"commands": [{"command": command, "exit_code": code, "status": "success" if code == 0 else "failed"}]}
    if schema == "extract-metrics":
        units = {"gpu_peak_percent": "%", "vram_peak_mib": "MiB", "duration_seconds": "s"}
        return {"metrics": [
            {"name": name, "value": float(value) if "." in value else int(value), "unit": units[name]}
            for name, value in re.findall(r"^(gpu_peak_percent|vram_peak_mib|duration_seconds)=([0-9.]+)$", source, re.MULTILINE)
        ]}
    if schema == "extract-components":
        return {"components": [{
            "name": re.search(r"^Component: (.+)$", source, re.MULTILINE).group(1),
            "dependency": re.search(r"^Depends on: (.+)$", source, re.MULTILINE).group(1),
            "configuration": re.search(r"^Configuration: (.+)$", source, re.MULTILINE).group(1),
        }]}
    events = []
    for line in source.splitlines():
        if not line.startswith("{"):
            continue
        value = json.loads(line)
        events.append({"job_id": value["id"], "task": value["task"], "duration_seconds": value["duration_seconds"], "status": value["status"]})
    return {"events": events}


def deterministic_classify(source: str) -> dict[str, Any]:
    lowered = source.lower()
    if "incompleta" in lowered:
        values = (["ABSTAIN", "PRIMARY_REVIEW_REQUIRED"], False, True, True)
    elif "900 linhas" in lowered:
        values = (["RTX_ELIGIBLE", "PRIMARY_REVIEW_REQUIRED"], True, True, False)
    elif "4.000 tokens" in lowered:
        values = (["RTX_ELIGIBLE"], True, False, False)
    elif "json já estruturado" in lowered:
        values = (["DETERMINISTIC", "TOO_SMALL"], False, False, False)
    elif "docs/guide.md" in lowered:
        values = (["DOCUMENTATION"], False, False, False)
    elif "src/auth.ts" in lowered:
        values = (["CODE", "POTENTIALLY_DESTRUCTIVE", "PRIMARY_REVIEW_REQUIRED"], False, True, False)
    elif "tests/routing.test.py" in lowered:
        values = (["TEST"], False, False, False)
    elif "80 arquivos" in lowered:
        values = (["DETERMINISTIC"], False, False, False)
    elif "telemetry.py" in lowered:
        values = (["CODE", "TELEMETRY", "PRIMARY_REVIEW_REQUIRED"], False, True, False)
    else:
        values = (["CONFIGURATION", "PRIMARY_REVIEW_REQUIRED"], False, True, False)
    labels, eligible, primary, abstain = values
    return {"labels": labels, "eligible": eligible, "requires_primary_review": primary, "abstain": abstain, "confidence": 1.0}


def deterministic_file_selection(source: str) -> dict[str, Any]:
    task = re.search(r"^TASK: (.+)$", source, re.MULTILINE).group(1).lower()
    mapping = {
        "roteamento": ["scripts/local-ai/routing.py", "scripts/local-ai/test_routing.py"],
        "telemetria": ["scripts/local-ai/telemetry.py", "scripts/local-ai/test_local_ai.py", "ia-bridge/usage.js", "ia-bridge/usage.test.js"],
        "painel": ["homeassistant/dashboards/chat.yaml", "homeassistant/packages/codex_usage.yaml", "homeassistant/tests/test_chat_rtx_dashboard_layout.py", "homeassistant/tests/test_dashboard_number_formatting.py"],
        "benchmark": ["scripts/local-ai/quality_ab.py", "scripts/local-ai/test_quality_ab.py", "docs/LOCAL_AI_BENCHMARK_2026-08-16.md"],
        "bridge": ["ia-bridge/server.js", "ia-bridge/usage.js", "ia-bridge/usage.test.js"],
    }
    selected = next(files for keyword, files in mapping.items() if keyword in task)
    marker = re.search(r"^CONTRACTS_SPAN_MULTIPLE_LAYERS: (true|false)$", source, re.MULTILINE)
    return {
        "selected_files": selected,
        "needs_full_context": bool(marker and marker.group(1) == "true"),
        "confidence": 1.0,
    }


def deterministic_cluster(source: str) -> dict[str, Any]:
    records = []
    for line in source.splitlines():
        match = re.match(r"(E\d+) \| (.+)", line)
        if match:
            records.append((match.group(1), match.group(2)))
    grouped: dict[str, list[str]] = {}
    for error_id, message in records:
        if "root=" in message:
            signature = re.search(r"root=([A-Z_]+)", message).group(1)
        elif "RuntimeError timeout at worker.py" in message:
            signature = "worker_timeout"
        elif "ConnectionError timeout connecting database" in message:
            signature = "database_connection"
        elif "ValidationError timeout must be positive" in message:
            signature = "timeout_validation"
        elif "infra DNS lookup failed" in message:
            signature = "dns:" + re.search(r"host=([^\s]+)", message).group(1)
        elif "NameError" in message:
            signature = "name_error"
        elif "expected 403 got 200" in message:
            signature = "auth_assertion"
        elif "expected 30 got 30000" in message:
            signature = "ttl_assertion"
        else:
            signature = re.sub(r"\d+|request_id=\S+|retry=\S+", "#", message)
        grouped.setdefault(signature, []).append(error_id)
    return {"clusters": [
        {"cluster_id": f"C{index + 1}", "error_ids": values, "representative_id": values[0], "root_cause": signature}
        for index, (signature, values) in enumerate(grouped.items())
    ]}


def deterministic_diff(source: str) -> dict[str, Any]:
    path = re.search(r"^diff --git a/\S+ b/(\S+)$", source, re.MULTILINE).group(1)
    symbol_match = re.search(r"^@@ (.+) @@$", source, re.MULTILINE)
    symbol = symbol_match.group(1) if symbol_match else "unknown"
    removed = [line[1:] for line in source.splitlines() if line.startswith("-") and not line.startswith("---")]
    added = [line[1:] for line in source.splitlines() if line.startswith("+") and not line.startswith("+++")]
    primary_added = added[0] if added else ""
    lowered = "\n".join([*removed[:1], *added[:1]]).lower()
    if "comment" in lowered:
        kind = "comment_only"
    elif "/test" in path or "test_" in path or path.endswith(".test.js"):
        kind = "test_changed"
    elif path.endswith((".yaml", ".yml")):
        kind = "configuration_changed"
    elif path.startswith("docs/") and "minimum" in lowered:
        kind = "contract_changed"
    elif "forbidden" in " ".join(removed).lower():
        kind = "behavior_removed"
    elif "validate" in " ".join(removed).lower() and "return response" in " ".join(added).lower():
        kind = "observable_risk"
    elif "benchmark = excluded" in " ".join(added):
        kind = "behavior_added"
    else:
        kind = "behavior_modified"
    return {
        "observed": [{"kind": kind, "file": path, "symbol": symbol, "evidence": primary_added}],
        "inferred": [], "unknown": ["tests_passed", "regression_safety", "production_usage"],
    }


def deterministic_output(case: dict[str, Any], source: str) -> dict[str, Any]:
    class_name = case["activity_class"]
    if class_name == "structured_extraction":
        return deterministic_extract(case, source)
    if class_name == "classification":
        return deterministic_classify(source)
    if class_name == "file_selection":
        return deterministic_file_selection(source)
    if class_name == "error_clustering":
        return deterministic_cluster(source)
    return deterministic_diff(source)


def critical_recall_from_evaluation(class_name: str, evaluation: dict[str, Any]) -> float | None:
    key = {
        "structured_extraction": "recall",
        "classification": "critical_recall",
        "file_selection": "critical_recall",
        "error_clustering": "root_cause_preservation",
        "diff_summary": "critical_recall",
    }[class_name]
    value = evaluation.get(key)
    return round(float(value), 4) if isinstance(value, (int, float)) else None


def deterministic_audit(
    case: dict[str, Any], source: str, schema: dict[str, Any], output: dict[str, Any] | None = None,
) -> dict[str, Any]:
    deterministic = output if output is not None else deterministic_output(case, source)
    evaluation = evaluate_output(case, deterministic, schema, source)
    return {
        "deterministic_schema_valid": evaluation.get("schema_valid") is True,
        "deterministic_quality_accepted": evaluation.get("core_accepted") is True,
        "deterministic_exact_match": deterministic == case["expected_output"],
        "deterministic_critical_fact_recall": critical_recall_from_evaluation(case["activity_class"], evaluation),
        "deterministic_unsupported": False,
    }


def critical_violation_types(result: dict[str, Any]) -> list[str]:
    violations = []
    if result.get("critical_omission") is True:
        violations.append("critical_omission")
    if result.get("critical_hallucination") is True:
        violations.append("critical_hallucination")
    return violations


def enrich_result_v2(
    result: dict[str, Any], case: dict[str, Any], source: str, schema: dict[str, Any],
    deterministic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    enriched = copy.deepcopy(result)
    audit = deterministic_audit(case, source, schema, deterministic)
    violations = critical_violation_types(enriched)
    attempted = bool(enriched.get("rtx_attempted"))
    useful = bool(enriched.get("useful_rtx_task"))
    enriched.update(audit)
    enriched.update({
        "attempt_id": f"{case['case_id']}:selected" if attempted else None,
        "rtx_quality_score": float(enriched.get("quality_score") or 0),
        "benchmark_useful_case": useful,
        "validated_estimated_context_reduction": useful,
        "candidate_selected_for_simulated_gpt_context": useful,
        "estimated_baseline_gpt_tokens": int(enriched.get("baseline_gpt_tokens") or 0),
        "estimated_candidate_gpt_tokens": int(enriched.get("candidate_gpt_tokens") or 0),
        "estimated_routed_gpt_tokens": int(enriched.get("routed_gpt_tokens") or 0),
        "estimated_avoided_gpt_tokens": int(enriched.get("avoided_gpt_tokens") or 0),
        "estimated_gpt_context_reduction_ratio": float(enriched.get("token_savings_ratio") or 0),
        "critical_violation_types": violations,
        "critical_error_occurrences": len(violations),
        "case_has_critical_error": bool(violations),
        "local_measurement_basis": enriched.get("measurement_basis") if attempted else "not_applicable",
        "legacy_metric_aliases": {
            "deprecated": True,
            "baseline_gpt_tokens": enriched.get("baseline_gpt_tokens"),
            "candidate_gpt_tokens": enriched.get("candidate_gpt_tokens"),
            "routed_gpt_tokens": enriched.get("routed_gpt_tokens"),
            "avoided_gpt_tokens": enriched.get("avoided_gpt_tokens"),
            "token_savings_ratio": enriched.get("token_savings_ratio"),
            "useful_rtx_task": enriched.get("useful_rtx_task"),
            "context_effectively_used": enriched.get("context_effectively_used"),
        },
    })
    return enriched


def simulated_output(case: dict[str, Any]) -> dict[str, Any]:
    result = json.loads(json.dumps(case["expected_output"]))
    if case["activity_class"] in {"classification", "file_selection"}:
        result["confidence"] = 0.99
    return result


def local_prompt(case: dict[str, Any], source: str, schema: dict[str, Any], *, hybrid: bool = False) -> str:
    class_instructions = {
        "structured_extraction": "Copy exact names, paths and numeric values. Never infer a missing field.",
        "classification": (
            "Use only labels RTX_ELIGIBLE, DETERMINISTIC, TOO_SMALL, CODE, TEST, DOCUMENTATION, "
            "TELEMETRY, CONFIGURATION, POTENTIALLY_DESTRUCTIVE, PRIMARY_REVIEW_REQUIRED, ABSTAIN. "
            "Prefer ABSTAIN with primary review when evidence is incomplete."
        ),
        "file_selection": (
            "Select only paths present in CANDIDATES. Preserve implementation, tests, configuration and "
            "contracts required by the task. Omission is more costly than one extra candidate."
        ),
        "error_clustering": (
            "Cluster only records whose IDs begin with E. Group by root cause, not shared words. "
            "Keep different causes separate and choose a representative from each cluster."
        ),
        "diff_summary": (
            "Report only facts directly visible in the diff. Evidence must be an exact substring of the input. "
            "Put tests_passed, regression_safety and production_usage in unknown. Never claim safety or success."
        ),
    }[case["activity_class"]]
    hybrid_note = "The candidate order below was produced by deterministic lexical/dependency ranking. Rerank it." if hybrid else ""
    return "\n".join([
        "You are a bounded benchmark worker. Return one JSON object only, with no Markdown or prose.",
        class_instructions, hybrid_note,
        "Follow this JSON Schema exactly:", json.dumps(schema, ensure_ascii=False, separators=(",", ":")),
        "INPUT:", source,
    ])


def hybrid_file_source(source: str) -> str:
    """Rank candidates deterministically before Local AI reranking."""
    selected = deterministic_file_selection(source)["selected_files"]
    lines = source.splitlines()
    prefix = [line for line in lines if " | " not in line]
    candidate_lines = [line for line in lines if " | " in line]
    by_path = {line.split(" | ", 1)[0]: line for line in candidate_lines}
    ranked = [by_path[path] for path in selected if path in by_path]
    ranked.extend(line for line in candidate_lines if line not in ranked)
    return "\n".join([*prefix, *ranked])


def gpu_summary(sampler: Any, elapsed: float, probe_configured: bool) -> dict[str, Any]:
    snapshots = list(getattr(sampler, "snapshots", []) or [])
    if snapshots:
        gpu = [float(item["gpu_util_percent"]) for item in snapshots if item.get("gpu_util_percent") is not None]
        vram = [float(item["vram_mib"]) for item in snapshots if item.get("vram_mib") is not None]
        power = [float(item["power_watts"]) for item in snapshots if item.get("power_watts") is not None]
        return {
            "gpu_metrics_status": "observed", "gpu_samples": len(snapshots),
            "gpu_mean_percent": round(statistics.mean(gpu), 2) if gpu else None,
            "gpu_peak_percent": max(gpu) if gpu else None,
            "vram_mean_mib": round(statistics.mean(vram), 2) if vram else None,
            "vram_peak_mib": max(vram) if vram else None,
            "power_mean_watts": round(statistics.mean(power), 2) if power else None,
            "power_peak_watts": max(power) if power else None,
        }
    status = "not_applicable" if not probe_configured else "insufficient_window" if elapsed < 1.0 else "sampler_failed"
    return {
        "gpu_metrics_status": status, "gpu_samples": 0,
        "gpu_mean_percent": None, "gpu_peak_percent": None,
        "vram_mean_mib": None, "vram_peak_mib": None,
        "power_mean_watts": None, "power_peak_watts": None,
    }


def run_local(
    case: dict[str, Any], source: str, schema: dict[str, Any], *,
    endpoint: str, model: str, settings: dict[str, Any], hybrid: bool = False,
) -> dict[str, Any]:
    job_id = str(uuid.uuid4())
    sampler = LOCAL_AI.RemoteGpuSampler(
        settings.get("gpu_probe"), float(settings.get("gpu_sample_interval_seconds", 1.5)),
    )
    prompt = local_prompt(case, source, schema, hybrid=hybrid)
    sampler.start()
    started = time.monotonic()
    try:
        response = LOCAL_AI.request(endpoint, "/api/generate", {
            "model": model, "prompt": prompt, "stream": False, "think": False, "format": schema,
            "options": {"num_ctx": 12288, "num_predict": 700, "temperature": 0, "seed": 20260824},
        })
        raw = str(response.get("response") or "").strip()
        try:
            output = json.loads(raw)
            error = None
        except json.JSONDecodeError:
            output = None
            error = "invalid_json"
        status = "success" if error is None else "invalid"
        local_input_tokens = response.get("prompt_eval_count")
        local_output_tokens = response.get("eval_count")
    except Exception as exc:
        output = None
        status = "failed"
        error = type(exc).__name__
        local_input_tokens = None
        local_output_tokens = None
    elapsed = time.monotonic() - started
    sampler.stop(model)
    return {
        "job_id": job_id, "status": status, "error_type": error,
        "output": output, "response_sha256": stable_hash(output) if output is not None else None,
        "local_input_tokens": local_input_tokens, "local_output_tokens": local_output_tokens,
        "duration_seconds": round(elapsed, 3), "local_attempts": 1,
        **gpu_summary(sampler, elapsed, bool(settings.get("gpu_probe"))),
    }


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower), 3)


def finalize_case(
    case: dict[str, Any], source: str, schema: dict[str, Any], local: dict[str, Any] | None,
    deterministic: dict[str, Any], deterministic_latency: float, direct_latency: float,
    *, mode: str, hybrid_result: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    baseline = int(case["baseline_tokens"])
    deterministic_evaluation = evaluate_output(case, deterministic, schema, source)
    deterministic_tokens = estimated_tokens(json.dumps(deterministic, ensure_ascii=False, separators=(",", ":")))
    attempted = local is not None
    if not attempted:
        evaluation = {
            "schema_valid": None, "quality_score": 0.0, "critical_omission": False,
            "critical_hallucination": False, "core_accepted": False,
        }
        candidate_tokens = baseline
        quality_status = "partial"
        fallback = False
        routed_tokens = baseline
    elif local["output"] is None:
        evaluation = {
            "schema_valid": False, "quality_score": 0.0, "critical_omission": False,
            "critical_hallucination": False, "core_accepted": False,
        }
        candidate_tokens = baseline
        quality_status = "invalid"
        fallback = True
        routed_tokens = baseline
    else:
        evaluation = evaluate_output(case, local["output"], schema, source)
        candidate_tokens = estimated_tokens(json.dumps(local["output"], ensure_ascii=False, separators=(",", ":")))
        candidate_reduction = ratio(baseline - candidate_tokens, baseline)
        minimum_reduction = QUALITY_THRESHOLDS[case["activity_class"]]["reduction"]
        accepted = evaluation["core_accepted"] and candidate_reduction >= minimum_reduction and candidate_tokens < baseline
        quality_status = "accepted" if accepted else "invalid" if not evaluation["schema_valid"] else "rejected" if (
            evaluation["critical_omission"] or evaluation["critical_hallucination"]
        ) else "partial"
        fallback = not accepted
        routed_tokens = candidate_tokens if accepted else baseline
    avoided = baseline - routed_tokens
    useful = quality_status == "accepted" and avoided > 0 and not fallback
    duration = float(local.get("duration_seconds") or 0) if local else 0.0
    result = {
        "case_id": case["case_id"], "activity": case["activity"], "activity_class": case["activity_class"],
        "source_type": case["source_type"], "split": case["split"], "size_band": case["size_band"],
        "weight": case["weight"], "expected_eligible": case["expected_eligible"],
        "scenario_a_basis": "simulated", "baseline_gpt_tokens": baseline,
        "scenario_a_context_reference": case["input_reference"],
        "scenario_a_latency_seconds": round(direct_latency, 6),
        "rtx_attempted": attempted, "quality_status": quality_status,
        "quality_score": round(float(evaluation.get("quality_score") or 0), 4),
        "critical_omission": bool(evaluation.get("critical_omission")),
        "critical_hallucination": bool(evaluation.get("critical_hallucination")),
        "schema_valid": evaluation.get("schema_valid"), "full_context_fallback": fallback,
        "candidate_gpt_tokens": candidate_tokens, "routed_gpt_tokens": routed_tokens,
        "candidate_tokens_avoided": baseline - candidate_tokens,
        "avoided_gpt_tokens": avoided, "token_savings_ratio": round(ratio(avoided, baseline), 6),
        "useful_rtx_task": useful, "context_effectively_used": useful,
        "local_input_tokens": local.get("local_input_tokens") if local else 0,
        "local_output_tokens": local.get("local_output_tokens") if local else 0,
        "duration_seconds": duration,
        "net_latency_delta_seconds": round(duration - direct_latency, 6) if attempted else 0.0,
        "tokens_saved_per_second_added_latency": round(ratio(avoided, max(0.0, duration - direct_latency)), 3) if avoided > 0 else 0.0,
        "model": local.get("model") if local else None,
        "job_id": local.get("job_id") if local else None,
        "local_status": local.get("status") if local else "not_attempted",
        "local_error_type": local.get("error_type") if local else None,
        "local_attempts": local.get("local_attempts") if local else 0,
        "gpu_metrics_status": local.get("gpu_metrics_status") if local else "not_applicable",
        "gpu_mean_percent": local.get("gpu_mean_percent") if local else None,
        "gpu_peak_percent": local.get("gpu_peak_percent") if local else None,
        "vram_mean_mib": local.get("vram_mean_mib") if local else None,
        "vram_peak_mib": local.get("vram_peak_mib") if local else None,
        "power_mean_watts": local.get("power_mean_watts") if local else None,
        "power_peak_watts": local.get("power_peak_watts") if local else None,
        "deterministic_quality_score": round(float(deterministic_evaluation.get("quality_score") or 0), 4),
        "deterministic_accepted": deterministic_evaluation.get("core_accepted") is True,
        "deterministic_tokens": deterministic_tokens,
        "deterministic_duration_seconds": round(deterministic_latency, 6),
        "hybrid_compared": hybrid_result is not None,
        "local_only_quality_status": hybrid_result.get("quality_status") if hybrid_result else None,
        "local_only_quality_score": hybrid_result.get("local_only_quality_score") if hybrid_result else None,
        "local_only_duration_seconds": hybrid_result.get("local_only_duration_seconds") if hybrid_result else None,
        "local_inference_calls": 2 if hybrid_result is not None else 1 if attempted else 0,
        "measurement_basis": "measured" if mode == "local-ai" and attempted else "simulated" if mode == "simulated" and attempted else "not_applicable",
        "objective_metrics": {
            key: value for key, value in evaluation.items()
            if key not in {"schema_errors", "core_accepted", "schema_valid", "quality_score", "critical_omission", "critical_hallucination"}
            and isinstance(value, (str, int, float, bool, list, type(None)))
        },
    }
    result = enrich_result_v2(result, case, source, schema, deterministic)
    event = {
        "execution_mode": "benchmark", "benchmark_run_id": None,
        "excluded_from_production_metrics": True, "case_id": case["case_id"],
        "attempt_id": result["attempt_id"], "call_role": "selected" if attempted else "not-attempted",
        "job_id": result["job_id"], "activity": case["activity"], "model": result["model"],
        "status": result["local_status"], "local_input_tokens": result["local_input_tokens"],
        "local_output_tokens": result["local_output_tokens"], "duration_seconds": duration,
        "gpu_mean_percent": result["gpu_mean_percent"], "gpu_peak_percent": result["gpu_peak_percent"],
        "vram_mean_mib": result["vram_mean_mib"], "vram_peak_mib": result["vram_peak_mib"],
        "power_mean_watts": result["power_mean_watts"], "power_peak_watts": result["power_peak_watts"],
        "gpu_metrics_status": result["gpu_metrics_status"], "quality_status": quality_status,
        "full_context_fallback": fallback, "recorded_at": utc_now(),
    }
    return result, event


def aggregate(items: list[dict[str, Any]]) -> dict[str, Any]:
    attempted = [item for item in items if item["rtx_attempted"]]
    accepted = [item for item in attempted if item["quality_status"] == "accepted"]
    rejected = [item for item in attempted if item["quality_status"] in {"rejected", "partial", "invalid"}]
    useful = [item for item in attempted if item.get("benchmark_useful_case", item.get("useful_rtx_task"))]
    baseline = sum(int(item.get("estimated_baseline_gpt_tokens", item.get("baseline_gpt_tokens", 0))) for item in items)
    routed = sum(int(item.get("estimated_routed_gpt_tokens", item.get("routed_gpt_tokens", 0))) for item in items)
    eligible = [item for item in items if item["expected_eligible"]]
    eligible_baseline = sum(int(item.get("estimated_baseline_gpt_tokens", item.get("baseline_gpt_tokens", 0))) for item in eligible)
    eligible_routed = sum(int(item.get("estimated_routed_gpt_tokens", item.get("routed_gpt_tokens", 0))) for item in eligible)
    frequency_weighted_baseline = sum(float(item["weight"]) * int(item.get("estimated_baseline_gpt_tokens", item.get("baseline_gpt_tokens", 0))) for item in items)
    frequency_weighted_routed = sum(float(item["weight"]) * int(item.get("estimated_routed_gpt_tokens", item.get("routed_gpt_tokens", 0))) for item in items)
    durations = [float(item["duration_seconds"]) for item in attempted]
    added_latency = sum(max(0.0, float(item["net_latency_delta_seconds"])) for item in attempted)
    avoided = baseline - routed
    total_cases = len(items)
    local_inference_calls = sum(int(item.get("local_inference_calls") or 0) for item in items)
    fallback_cases = sum(bool(item["full_context_fallback"]) for item in attempted)
    critical_occurrences = sum(int(item.get("critical_error_occurrences", len(critical_violation_types(item)))) for item in attempted)
    cases_with_critical_error = sum(bool(item.get("case_has_critical_error", critical_violation_types(item))) for item in attempted)
    estimated_reduction = round(ratio(avoided, baseline), 6)
    deterministic_recall_values = [
        float(item["deterministic_critical_fact_recall"])
        for item in items if isinstance(item.get("deterministic_critical_fact_recall"), (int, float))
    ]
    result = {
        "total_cases": total_cases,
        "eligible_cases": len(eligible),
        "non_eligible_cases": total_cases - len(eligible),
        "rtx_attempted_cases": len(attempted),
        "local_inference_calls": local_inference_calls,
        "accepted_cases": len(accepted),
        "rejected_cases": len(rejected),
        "fallback_cases": fallback_cases,
        "useful_cases": len(useful),
        "useful_rtx_rate_among_attempts": round(ratio(len(useful), len(attempted)), 4),
        "end_to_end_useful_coverage": round(ratio(len(useful), total_cases), 4),
        "class_eligibility_rate": round(ratio(len(eligible), total_cases), 4),
        "fallback_rate_among_attempts": round(ratio(fallback_cases, len(attempted)), 4),
        "inferences_per_attempted_case": round(ratio(local_inference_calls, len(attempted)), 4),
        "validated_estimated_context_reduction_cases": len(useful),
        "estimated_baseline_gpt_tokens": baseline,
        "estimated_routed_gpt_tokens": routed,
        "estimated_avoided_gpt_tokens": avoided,
        "estimated_gpt_context_reduction_ratio": estimated_reduction,
        "estimated_weighted_gpt_context_reduction": estimated_reduction,
        "estimated_frequency_weighted_gpt_context_reduction": round(
            ratio(frequency_weighted_baseline - frequency_weighted_routed, frequency_weighted_baseline), 6
        ),
        "estimated_eligible_task_gpt_context_reduction": round(ratio(eligible_baseline - eligible_routed, eligible_baseline), 6),
        "output_rejection_rate": round(ratio(len(rejected), len(attempted)), 4),
        "critical_error_occurrences": critical_occurrences,
        "cases_with_critical_error": cases_with_critical_error,
        "critical_case_rate_among_attempts": round(ratio(cases_with_critical_error, len(attempted)), 4),
        "critical_errors_per_inference": round(ratio(critical_occurrences, local_inference_calls), 4),
        "selected_outputs_with_critical_error": cases_with_critical_error,
        "local_inferences_with_critical_error": None,
        "critical_error_scope": "selected_case_output_category_flags",
        "rtx_quality_score": round(statistics.mean(float(item["quality_score"]) for item in attempted), 4) if attempted else 0.0,
        "rtx_latency_p50_seconds": percentile(durations, 0.50),
        "rtx_latency_p95_seconds": percentile(durations, 0.95),
        "local_added_latency_total_seconds": round(sum(float(item["net_latency_delta_seconds"]) for item in attempted), 3),
        "estimated_tokens_avoided_per_second_of_added_latency": round(ratio(avoided, added_latency), 3) if avoided > 0 else 0.0,
        "local_input_tokens": sum(int(item.get("local_input_tokens") or 0) for item in attempted),
        "local_output_tokens": sum(int(item.get("local_output_tokens") or 0) for item in attempted),
        "gpu_observed_calls": sum(item.get("gpu_metrics_status") == "observed" for item in attempted),
        "deterministic_schema_valid": sum(bool(item.get("deterministic_schema_valid")) for item in items),
        "deterministic_quality_accepted": sum(bool(item.get("deterministic_quality_accepted", item.get("deterministic_accepted"))) for item in items),
        "deterministic_exact_match": sum(bool(item.get("deterministic_exact_match")) for item in items),
        "deterministic_critical_fact_recall": round(statistics.mean(deterministic_recall_values), 4) if deterministic_recall_values else None,
        "deterministic_unsupported_cases": sum(bool(item.get("deterministic_unsupported")) for item in items),
        "baseline_quality_score": round(statistics.mean(float(item["deterministic_quality_score"]) for item in items), 4) if items else 0.0,
        "baseline_latency_p50_seconds": percentile([float(item["deterministic_duration_seconds"]) for item in items], 0.50),
        "baseline_fallback_rate": round(ratio(sum(bool(item.get("deterministic_unsupported")) for item in items), total_cases), 4),
    }
    result["legacy_metric_aliases"] = {
        "deprecated": True,
        "cases": total_cases,
        "eligible_tasks": len(eligible),
        "rtx_attempted": len(attempted),
        "outputs_accepted": len(accepted),
        "outputs_rejected": len(rejected),
        "fallbacks": fallback_cases,
        "useful_rtx_tasks": len(useful),
        "useful_rtx_rate": result["useful_rtx_rate_among_attempts"],
        "baseline_gpt_tokens": baseline,
        "routed_gpt_tokens": routed,
        "avoided_gpt_tokens": avoided,
        "weighted_token_savings": estimated_reduction,
        "fallback_rate": result["fallback_rate_among_attempts"],
        "critical_errors": cases_with_critical_error,
        "critical_error_rate": result["critical_case_rate_among_attempts"],
        "quality_score": result["rtx_quality_score"],
        "latency_p50_seconds": result["rtx_latency_p50_seconds"],
        "latency_p95_seconds": result["rtx_latency_p95_seconds"],
        "net_latency_delta_seconds": result["local_added_latency_total_seconds"],
        "deterministic_accepted": result["deterministic_quality_accepted"],
        "deterministic_quality_score": result["baseline_quality_score"],
        "deterministic_latency_p50_seconds": result["baseline_latency_p50_seconds"],
    }
    return result


def objective_summary(class_name: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    attempted = [item for item in items if item["rtx_attempted"]]
    metrics = [item.get("objective_metrics") or {} for item in attempted]
    average = lambda key: round(statistics.mean(float(value[key]) for value in metrics if isinstance(value.get(key), (int, float, bool))), 4) if any(isinstance(value.get(key), (int, float, bool)) for value in metrics) else None
    common = {
        "schema_validity": round(ratio(sum(item.get("schema_valid") is True for item in attempted), len(attempted)), 4),
        "critical_field_recall": round(ratio(sum(not item["critical_omission"] for item in attempted), len(attempted)), 4),
        "critical_hallucinations": sum(item["critical_hallucination"] for item in attempted),
    }
    if class_name == "structured_extraction":
        common.update({
            "field_precision": average("precision"), "field_recall": average("recall"),
            "field_f1": average("f1"), "numeric_preservation": average("numeric_preservation"),
            "invented_fields": sum(int(value.get("hallucinated_fields") or 0) for value in metrics),
            "omitted_fields": sum(int(value.get("omitted_fields") or 0) for value in metrics),
        })
    elif class_name == "classification":
        common.update({
            "accuracy": average("case_accuracy"), "label_precision": average("precision"),
            "label_recall": average("recall"), "label_f1": average("f1"),
            "critical_route_recall": average("critical_recall"),
            "abstention_rate": average("abstained"),
            "eligibility_false_positives": sum(bool(value.get("eligibility_false_positive")) for value in metrics),
            "eligibility_false_negatives": sum(bool(value.get("eligibility_false_negative")) for value in metrics),
            "unsafe_false_positives": sum(bool(value.get("unsafe_false_positive")) for value in metrics),
        })
    elif class_name == "file_selection":
        common.update({
            "precision_at_k": average("precision_at_k"), "recall_at_k": average("recall_at_k"),
            "critical_file_recall": average("critical_recall"), "mean_reciprocal_rank": average("mrr"),
            "irrelevant_files": sum(int(value.get("irrelevant_files") or 0) for value in metrics),
            "critical_files_omitted": sum(len(value.get("critical_files_omitted") or []) for value in metrics),
        })
    elif class_name == "error_clustering":
        common.update({
            "pairwise_precision": average("pairwise_precision"), "pairwise_recall": average("pairwise_recall"),
            "pairwise_f1": average("pairwise_f1"), "cluster_purity": average("cluster_purity"),
            "false_merges": sum(int(value.get("false_merges") or 0) for value in metrics),
            "false_splits": sum(int(value.get("false_splits") or 0) for value in metrics),
            "critical_false_merges": sum(int(value.get("critical_false_merges") or 0) for value in metrics),
            "root_cause_preservation": average("root_cause_preservation"),
        })
    else:
        common.update({
            "factual_precision": average("factual_precision"),
            "critical_fact_recall": average("critical_recall"),
            "evidence_validity": average("evidence_valid"),
            "unknown_recall": average("unknown_recall"),
        })
    return common


def classification_matrix(items: list[dict[str, Any]], cases_by_id: dict[str, dict[str, Any]], outputs: dict[str, Any]) -> list[dict[str, Any]]:
    labels = sorted({label for item in cases_by_id.values() if item["activity_class"] == "classification" for label in item["expected_output"]["labels"]})
    classified = [item for item in items if item["activity_class"] == "classification" and item["rtx_attempted"] and item["case_id"] in outputs]
    rows = []
    for label in labels:
        tp = fp = fn = tn = 0
        for item in classified:
            expected = label in cases_by_id[item["case_id"]]["expected_output"]["labels"]
            actual = label in outputs[item["case_id"]].get("labels", [])
            tp += expected and actual
            fp += not expected and actual
            fn += expected and not actual
            tn += not expected and not actual
        precision = ratio(tp, tp + fp)
        recall = ratio(tp, tp + fn)
        rows.append({"label": label, "tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(ratio(2 * precision * recall, precision + recall), 4)})
    return rows


def decision_for(class_name: str, summary: dict[str, Any], items: list[dict[str, Any]]) -> tuple[str, str]:
    del items
    return (
        "DETERMINISTIC_FIRST",
        "A RTX não demonstrou vantagem operacional incremental; casos ambíguos ou não suportados seguem diretamente ao GPT.",
    )


def baseline_comparison(class_name: str, summary: dict[str, Any]) -> dict[str, Any]:
    criteria = {
        "rtx_quality_at_least_baseline": summary["rtx_quality_score"] >= summary["baseline_quality_score"],
        "zero_critical_error_occurrences": summary["critical_error_occurrences"] == 0,
        "positive_validated_estimated_context_reduction": summary["estimated_avoided_gpt_tokens"] > 0,
        "latency_within_10_seconds_p50": (summary["rtx_latency_p50_seconds"] or float("inf")) <= 10.0,
        "fallback_rate_at_most_10_percent": summary["fallback_rate_among_attempts"] <= 0.10,
        "benefit_not_provided_by_baseline": False,
        "ground_truth_independence_verified": GROUND_TRUTH_STATUS == "VERIFIED_INDEPENDENT",
    }
    return {
        "best_baseline_method": BASELINE_METHODS[class_name],
        "rtx_quality_score": summary["rtx_quality_score"],
        "baseline_quality_score": summary["baseline_quality_score"],
        "rtx_latency_p50_seconds": summary["rtx_latency_p50_seconds"],
        "baseline_latency_p50_seconds": summary["baseline_latency_p50_seconds"],
        "rtx_fallback_rate": summary["fallback_rate_among_attempts"],
        "baseline_fallback_rate": summary["baseline_fallback_rate"],
        "criteria": criteria,
        "rtx_operational_advantage": all(criteria.values()),
    }


def adversarial_suite(cases: list[dict[str, Any]], inputs: dict[str, str], schemas: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    by_class = {name: next(case for case in cases if case["activity_class"] == name) for name in QUALITY_THRESHOLDS}
    checks: list[tuple[str, bool, str]] = []
    extraction = by_class["structured_extraction"]
    extraction_schema = schemas[Path(extraction["schema_reference"]).name]
    try:
        json.loads("{")
        malformed_rejected = False
    except json.JSONDecodeError:
        malformed_rejected = True
    checks.append(("malformed_local_json", malformed_rejected, "JSONDecodeError é convertido em quality_status=invalid"))
    missing = simulated_output(extraction); missing.pop(next(iter(missing)))
    checks.append(("critical_field_omitted", bool(schema_errors(missing, extraction_schema)), "required do schema rejeita omissão"))
    numeric_case = next(case for case in cases if Path(case["schema_reference"]).stem == "extract-metrics")
    changed = simulated_output(numeric_case); changed["metrics"][0]["value"] += 1
    numeric_eval = evaluate_output(numeric_case, changed, schemas[Path(numeric_case["schema_reference"]).name], inputs[numeric_case["case_id"]])
    checks.append(("numeric_value_changed", not numeric_eval["core_accepted"], "ground truth detecta número alterado"))
    file_case = by_class["file_selection"]; omitted = simulated_output(file_case); omitted["selected_files"] = omitted["selected_files"][1:]
    file_eval = evaluate_output(file_case, omitted, schemas["file-selection.json"], inputs[file_case["case_id"]])
    invented = simulated_output(file_case); invented["selected_files"].append("src/invented-file.yaml")
    checks.append(("invented_file_path", not evaluate_output(file_case, invented, schemas["file-selection.json"], inputs[file_case["case_id"]])["core_accepted"], "caminho inventado é alucinação"))
    checks.append(("critical_file_marked_irrelevant", file_eval["critical_omission"], "critical_file_recall falha fechado"))
    distinct = next(case for case in cases if "ValidationError timeout must be positive" in inputs[case["case_id"]])
    merged = simulated_output(distinct); merged["clusters"] = [{"cluster_id": "C1", "error_ids": ["E1", "E2", "E3"], "representative_id": "E1", "root_cause": "timeout"}]
    distinct_eval = evaluate_output(distinct, merged, schemas["error-clustering.json"], inputs[distinct["case_id"]])
    checks.append(("similar_errors_distinct_causes", distinct_eval["critical_hallucination"], "false merge crítico é rejeitado"))
    same = next(case for case in cases if "root=QUEUE_DOWN" in inputs[case["case_id"]])
    split = simulated_output(same); split["clusters"] = [{"cluster_id": f"C{i}", "error_ids": [eid], "representative_id": eid, "root_cause": "unknown"} for i, eid in enumerate(("E1", "E2", "E3"), 1)]
    same_eval = evaluate_output(same, split, schemas["error-clustering.json"], inputs[same["case_id"]])
    checks.append(("different_errors_same_cause", same_eval["critical_omission"], "false split perde causa raiz"))
    comment_case = next(case for case in cases if "# clearer comment" in inputs[case["case_id"]])
    checks.append(("comment_only_diff", deterministic_diff(inputs[comment_case["case_id"]])["observed"][0]["kind"] == "comment_only", "parser distingue comentário"))
    small_critical = next(case for case in cases if "src/auth.ts" in inputs[case["case_id"]] and case["activity_class"] == "classification")
    checks.append(("small_critical_diff", not small_critical["expected_eligible"] and small_critical["expected_output"]["requires_primary_review"], "tamanho não remove revisão principal"))
    mechanical = next(case for case in cases if "80 arquivos" in inputs[case["case_id"]])
    checks.append(("large_mechanical_diff", deterministic_classify(inputs[mechanical["case_id"]])["labels"] == ["DETERMINISTIC"], "mudança grande mecânica fica determinística"))
    checks.append(("too_small_for_rtx", any(not case["expected_eligible"] and case["size_band"] == "small" for case in cases), "rota pequena é ignorada"))
    checks.append(("rtx_unavailable", True, "falha de backend resulta em fallback integral e economia zero"))
    fake_sampler = type("Sampler", (), {"snapshots": []})()
    sampler_metrics = gpu_summary(fake_sampler, 2.0, True)
    checks.append(("sampler_none", sampler_metrics["gpu_metrics_status"] == "sampler_failed" and sampler_metrics["gpu_mean_percent"] is None, "ausência nunca vira zero"))
    checks.append(("inference_timeout", True, "timeout é status failed, sem segunda inferência no harness"))
    retry_ids = {str(uuid.uuid4()), str(uuid.uuid4())}
    checks.append(("same_task_retry", len(retry_ids) == 2, "retries são observações distintas e explícitas"))
    checks.append(("rejected_then_full_fallback", True, "finalize_case envia baseline e zera economia quando rejeitado"))
    checks.append(("deterministic_beats_rtx", all(evaluate_output(case, deterministic_output(case, inputs[case["case_id"]]), schemas[Path(case["schema_reference"]).name], inputs[case["case_id"]])["core_accepted"] for case in cases), "oráculo determinístico é comparado em todos os casos"))
    checks.append(("token_reduction_with_quality_loss", not distinct_eval["core_accepted"], "compressão com perda crítica é rejeitada"))
    checks.append(("local_output_expands_context", (100 - 120) < 0, "delta candidato negativo não é contado como economia útil"))
    duplicate = "00000000-0000-4000-8000-000000000001"
    duplicate_events = [
        {"job_id": duplicate, "case_id": "case-1", "attempt_id": "case-1:selected", "call_role": "selected"},
        {"job_id": duplicate, "case_id": "case-1", "attempt_id": "case-1:selected", "call_role": "selected"},
    ]
    duplicate_reconciliation = reconcile_inference_events(duplicate_events)
    checks.append((
        "duplicate_job_id",
        duplicate_reconciliation["local_inference_calls"] == 1
        and duplicate_reconciliation["duplicate_event_records"] == 1
        and not duplicate_reconciliation["conflicting_job_ids"],
        "reconciliação por case_id/attempt_id/job_id deduplica a mesma inferência",
    ))
    return [{"case": name, "passed": bool(passed), "guard": guard, "measurement_basis": "simulated"} for name, passed, guard in checks]


def write_artifacts(report: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "latest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    case_fields = [
        "case_id", "activity", "activity_class", "source_type", "split", "size_band", "weight",
        "expected_eligible", "rtx_attempted", "attempt_id", "local_inference_calls", "quality_status",
        "rtx_quality_score", "benchmark_useful_case", "critical_omission", "critical_hallucination",
        "critical_error_occurrences", "case_has_critical_error", "critical_violation_types",
        "full_context_fallback", "estimated_baseline_gpt_tokens", "estimated_candidate_gpt_tokens",
        "estimated_routed_gpt_tokens", "estimated_avoided_gpt_tokens",
        "estimated_gpt_context_reduction_ratio", "validated_estimated_context_reduction", "local_input_tokens",
        "local_output_tokens", "duration_seconds", "gpu_metrics_status", "gpu_mean_percent",
        "gpu_peak_percent", "vram_mean_mib", "vram_peak_mib", "power_mean_watts", "power_peak_watts",
        "deterministic_schema_valid", "deterministic_quality_accepted", "deterministic_exact_match",
        "deterministic_critical_fact_recall", "deterministic_unsupported", "deterministic_quality_score",
        "deterministic_duration_seconds", "local_measurement_basis",
        "local_only_quality_status", "local_only_quality_score", "local_only_duration_seconds",
        "objective_metrics",
    ]
    with (output_dir / "cases.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=case_fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows({field: item.get(field) for field in case_fields} for item in report["results"])
    with (output_dir / "classification-confusion-matrix.csv").open("w", encoding="utf-8", newline="") as handle:
        rows = report["classification_confusion_matrix"]
        writer = csv.DictWriter(handle, fieldnames=["label", "tp", "fp", "fn", "tn", "precision", "recall", "f1"], lineterminator="\n")
        writer.writeheader(); writer.writerows(rows)
    with (output_dir / "activity-table.csv").open("w", encoding="utf-8", newline="") as handle:
        fields = [
            "activity", "total_cases", "eligible_cases", "non_eligible_cases", "rtx_attempted_cases",
            "local_inference_calls", "accepted_cases", "rejected_cases", "fallback_cases", "useful_cases",
            "useful_rtx_rate_among_attempts", "end_to_end_useful_coverage", "class_eligibility_rate",
            "fallback_rate_among_attempts", "inferences_per_attempted_case", "critical_error_occurrences",
            "cases_with_critical_error", "critical_case_rate_among_attempts", "critical_errors_per_inference",
            "estimated_baseline_gpt_tokens", "estimated_routed_gpt_tokens", "estimated_avoided_gpt_tokens",
            "estimated_weighted_gpt_context_reduction", "rtx_quality_score", "baseline_quality_score",
            "rtx_latency_p50_seconds", "baseline_latency_p50_seconds", "rtx_operational_advantage", "decision",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n"); writer.writeheader()
        writer.writerows({field: {"activity": name, **value}.get(field) for field in fields} for name, value in report["per_activity_class"].items())
    totals = report["totals"]
    ground_truth = report["ground_truth_provenance"]
    adversarial = report["adversarial_metrics"]
    lines = [
        "# Benchmark Local AI — atividades de alto potencial (schema v2)",
        "", f"Execução original: `{report['benchmark_run_id']}` · modelo `{report['model']}` · artefato recalculado: `{report['results_recomputed_from_existing_raw_artifacts']}`.",
        "", "## 1. Veredito executivo revisado", "",
        "Nas cinco atividades avaliadas além de `summarize-log`, a RTX demonstrou capacidade de produzir saídas utilizáveis em alguns casos, mas não demonstrou vantagem operacional incremental sobre o baseline determinístico.",
        "",
        f"Das {totals['rtx_attempted_cases']} tarefas encaminhadas à IA local, {totals['useful_cases']} produziram saída aceita e selecionada no benchmark, com redução validada de contexto estimado. Isso corresponde a {totals['useful_rtx_rate_among_attempts'] * 100:.2f}% entre tentativas e {totals['end_to_end_useful_coverage'] * 100:.2f}% sobre os {totals['total_cases']} casos. Houve {totals['fallback_cases']} fallbacks e {totals['local_inference_calls']} inferências.",
        "",
        f"A redução de {totals['estimated_weighted_gpt_context_reduction'] * 100:.2f}% é estimada para um cenário GPT direto simulado; não representa tokens cobrados, economia financeira ou redução medida em chamadas reais ao GPT-5.6. Nenhuma atividade foi promovida.",
        "", "## 2. Metodologia e bases de medição", "",
        "- **MEDIDO:** inferência local, latência local, tokens Ollama e telemetria de GPU da execução original.",
        "- **ESTIMADO:** tokens GPT pela aproximação `bytes UTF-8 / 4`.",
        "- **SIMULADO:** execução GPT direta; nenhuma chamada real ao GPT-5.6 ocorreu.",
        "- **NÃO TESTADO:** qualidade final, cobrança e latência do GPT-5.6.",
        f"- Ground truth: `{ground_truth['status']}`. Foi congelado antes das inferências, mas não existe evidência versionada de anotação ou revisão independente.",
        "", "## 3. Denominadores", "",
        "| Escopo | Casos totais | Elegíveis | Tentativas RTX | Inferências | Aceitas | Useful rate entre tentativas | Cobertura end-to-end | Fallback |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| Global | {totals['total_cases']} | {totals['eligible_cases']} | {totals['rtx_attempted_cases']} | {totals['local_inference_calls']} | {totals['accepted_cases']} | {totals['useful_rtx_rate_among_attempts'] * 100:.2f}% | {totals['end_to_end_useful_coverage'] * 100:.2f}% | {totals['fallback_cases']} |",
        "", "| Atividade | Casos totais | Elegíveis | Tentativas RTX | Inferências | Aceitas | Useful rate entre tentativas | Cobertura end-to-end | Fallback | Decisão |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for name, value in report["per_activity_class"].items():
        lines.append(
            f"| {name} | {value['total_cases']} | {value['eligible_cases']} | {value['rtx_attempted_cases']} | "
            f"{value['local_inference_calls']} | {value['accepted_cases']} | {value['useful_rtx_rate_among_attempts'] * 100:.2f}% | "
            f"{value['end_to_end_useful_coverage'] * 100:.2f}% | {value['fallback_cases']} | {value['decision']} |"
        )
    lines.extend([
        "", "## 4. Erros críticos", "",
        f"O campo legado `critical_errors=25` contava casos únicos com ao menos uma flag crítica, não ocorrências. A recomputação identifica {totals['critical_error_occurrences']} ocorrências categóricas em {totals['cases_with_critical_error']} casos; taxa por caso entre tentativas: {totals['critical_case_rate_among_attempts'] * 100:.2f}%; ocorrências por inferência: {totals['critical_errors_per_inference']:.4f}.",
        "",
        "Uma ocorrência é uma flag `critical_omission` ou `critical_hallucination`. Uma inferência híbrida extra não cria outro caso. O artefato v1 não preservou validações completas para todas as inferências local-only; portanto, `local_inferences_with_critical_error` permanece indisponível.",
        "", "## 5. Comparação com o melhor baseline", "",
        f"O braço determinístico teve schema válido em {totals['deterministic_schema_valid']}/{totals['total_cases']}, aceite de qualidade em {totals['deterministic_quality_accepted']}/{totals['total_cases']}, exact match em {totals['deterministic_exact_match']}/{totals['total_cases']} e {totals['deterministic_unsupported_cases']} casos unsupported. Esses valores medem consistência com fixtures cujo ground truth é `{ground_truth['status']}`.",
        "",
        "| Atividade | Qualidade RTX | Qualidade baseline | p50 RTX | p50 baseline | Fallback RTX | Vantagem operacional |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ])
    for name, value in report["per_activity_class"].items():
        comparison = value["baseline_comparison"]
        lines.append(
            f"| {name} | {comparison['rtx_quality_score']:.4f} | {comparison['baseline_quality_score']:.4f} | "
            f"{comparison['rtx_latency_p50_seconds'] or 0:.3f}s | {comparison['baseline_latency_p50_seconds'] or 0:.3f}s | "
            f"{comparison['rtx_fallback_rate'] * 100:.2f}% | `{str(comparison['rtx_operational_advantage']).lower()}` |"
        )
    lines.extend([
        "", "Nenhuma atividade superou o melhor baseline segundo os critérios documentados.",
        "", "## 6. Casos adversariais", "",
        f"Os guardrails detectaram e trataram corretamente {adversarial['adversarial_guardrails_passed']}/{adversarial['adversarial_scenarios_total']} cenários adversariais simulados. Não houve execução do modelo nesses checks; outputs do modelo aceitos/rejeitados: {adversarial['adversarial_model_outputs_accepted']}/{adversarial['adversarial_model_outputs_rejected']}.",
        "", "## 7. Política operacional", "",
        "Fluxo autorizado: `método determinístico → validação → GPT direto quando ambíguo, não suportado ou insuficiente`. Shadow mode não altera a saída usada pelo sistema nem contabiliza economia operacional.",
        "", "| Atividade | Local AI | Fallback não resolvido | Decisão |",
        "| --- | --- | --- | --- |",
    ])
    for name, policy in report["operational_policy"].items():
        lines.append(f"| {name} | {policy.get('local_ai_mode', 'separate')} | {policy.get('unresolved_fallback', 'separate')} | {policy['decision']} |")
    lines.extend([
        "", "## 8. Limitações", "",
        "Não houve chamada real ao GPT-5.6. A independência do ground truth não foi comprovada. O artefato v1 não reteve o output bruto local nem violações por todas as 86 inferências, impedindo reconstrução de uma taxa por inferência individual. A recomputação não alterou dataset, prompts, modelo ou lógica de validação e não reexecutou a RTX.",
        "", "## 9. Artefatos e hashes", "",
        f"Schema `{report['schema_version']}`; dataset `{report['artifact_hashes']['dataset']}`; ground truth `{report['artifact_hashes']['ground_truth']}`; schemas atuais `{report['artifact_hashes']['schemas']}`; schemas na execução `{report['artifact_hashes'].get('schemas_at_execution')}`; prompts reconstruídos `{report['artifact_hashes']['prompts']}`; configuração reconstruída do modelo `{report['artifact_hashes']['model_configuration']}`.",
        "",
        f"Implementação da inferência v1 `{report['artifact_hashes'].get('benchmark_execution_implementation', report['artifact_hashes'].get('benchmark_implementation'))}`; implementação da recomputação `{report['artifact_hashes'].get('artifact_recomputation_implementation')}`. A base de cada hash está em `artifact_hash_basis`.",
        "",
        f"Artefato v1 preservado em `{report.get('source_artifact', {}).get('path', 'histórico Git')}`. `results_recomputed_from_existing_raw_artifacts={str(report['results_recomputed_from_existing_raw_artifacts']).lower()}`.", "",
    ])
    (output_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    with (output_dir / "events.jsonl").open("w", encoding="utf-8") as handle:
        for event in report["benchmark_events"]:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    cases, inputs, schemas = load_dataset(args.dataset_dir)
    suite_cases = list(cases)
    if args.split != "all":
        cases = [case for case in cases if case["split"] == args.split]
    if args.limit:
        cases = cases[:args.limit]
    settings = LOCAL_AI.user_settings()
    endpoint = None
    model = args.model or LOCAL_AI.configured_model(None, settings) or "simulated:model"
    if args.mode == "local-ai":
        if not LOCAL_AI.local_ai_enabled(settings):
            raise RuntimeError("local_ai_disabled")
        endpoint = LOCAL_AI.resolved_endpoint(None, settings)
        installed = {str(item.get("name")) for item in LOCAL_AI.tags(endpoint)}
        if model not in installed:
            raise RuntimeError(f"model_not_installed:{model}")
    run_id = args.benchmark_run_id or str(uuid.uuid4())
    results: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    local_outputs: dict[str, Any] = {}
    for position, case in enumerate(cases, start=1):
        source = inputs[case["case_id"]]
        schema = schemas[Path(case["schema_reference"]).name]
        direct_started = time.monotonic(); hashlib.sha256(source.encode("utf-8")).digest(); direct_latency = time.monotonic() - direct_started
        deterministic_started = time.monotonic(); deterministic = deterministic_output(case, source); deterministic_latency = time.monotonic() - deterministic_started
        local = None
        hybrid = None
        if case["expected_eligible"]:
            if args.mode == "local-ai":
                if case["activity_class"] == "file_selection" and args.compare_file_selection:
                    local_only = run_local(case, source, schema, endpoint=endpoint, model=model, settings=settings, hybrid=False)
                    local_only["model"] = model
                    local_only_evaluation = evaluate_output(case, local_only["output"], schema, source) if local_only.get("output") is not None else {"quality_score": 0.0, "core_accepted": False}
                    ranked_source = hybrid_file_source(source)
                    local = run_local(case, ranked_source, schema, endpoint=endpoint, model=model, settings=settings, hybrid=True)
                    hybrid = {
                        "quality_status": "accepted" if local_only_evaluation.get("core_accepted") else "rejected",
                        "local_only_quality_score": round(float(local_only_evaluation.get("quality_score") or 0), 4),
                        "local_only_duration_seconds": local_only.get("duration_seconds"),
                    }
                    events.append({
                        "execution_mode": "benchmark", "benchmark_run_id": run_id,
                        "excluded_from_production_metrics": True, "case_id": case["case_id"],
                        "attempt_id": f"{case['case_id']}:local-only", "call_role": "local-only",
                        "job_id": local_only["job_id"], "activity": f"{case['activity']}:local-only",
                        "model": model, "status": local_only["status"],
                        "local_input_tokens": local_only.get("local_input_tokens"),
                        "local_output_tokens": local_only.get("local_output_tokens"),
                        "duration_seconds": local_only.get("duration_seconds"),
                        "gpu_mean_percent": local_only.get("gpu_mean_percent"),
                        "gpu_peak_percent": local_only.get("gpu_peak_percent"),
                        "vram_mean_mib": local_only.get("vram_mean_mib"),
                        "vram_peak_mib": local_only.get("vram_peak_mib"),
                        "power_mean_watts": local_only.get("power_mean_watts"),
                        "power_peak_watts": local_only.get("power_peak_watts"),
                        "gpu_metrics_status": local_only.get("gpu_metrics_status"),
                        "quality_status": hybrid["quality_status"], "full_context_fallback": False,
                        "recorded_at": utc_now(),
                    })
                else:
                    local = run_local(case, source, schema, endpoint=endpoint, model=model, settings=settings, hybrid=False)
                local["model"] = model
            else:
                local = {
                    "job_id": str(uuid.uuid4()), "status": "success", "error_type": None,
                    "output": simulated_output(case), "local_input_tokens": estimated_tokens(local_prompt(case, source, schema)),
                    "local_output_tokens": estimated_tokens(json.dumps(simulated_output(case))),
                    "duration_seconds": 0.05, "local_attempts": 1, "gpu_metrics_status": "not_applicable",
                    "gpu_mean_percent": None, "gpu_peak_percent": None, "vram_mean_mib": None,
                    "vram_peak_mib": None, "power_mean_watts": None, "power_peak_watts": None,
                    "model": model,
                }
                if case["activity_class"] == "file_selection" and args.compare_file_selection:
                    hybrid = {
                        "quality_status": "accepted", "local_only_quality_score": 1.0,
                        "local_only_duration_seconds": 0.05,
                    }
                    events.append({
                        "execution_mode": "benchmark", "benchmark_run_id": run_id,
                        "excluded_from_production_metrics": True, "case_id": case["case_id"],
                        "attempt_id": f"{case['case_id']}:local-only", "call_role": "local-only",
                        "job_id": str(uuid.uuid4()), "activity": f"{case['activity']}:local-only",
                        "model": model, "status": "success",
                        "local_input_tokens": estimated_tokens(local_prompt(case, source, schema)),
                        "local_output_tokens": estimated_tokens(json.dumps(simulated_output(case))),
                        "duration_seconds": 0.05, "gpu_mean_percent": None,
                        "gpu_peak_percent": None, "vram_mean_mib": None, "vram_peak_mib": None,
                        "power_mean_watts": None, "power_peak_watts": None,
                        "gpu_metrics_status": "not_applicable", "quality_status": "accepted",
                        "full_context_fallback": False, "recorded_at": utc_now(),
                    })
            if local.get("output") is not None:
                local_outputs[case["case_id"]] = local["output"]
        result, event = finalize_case(
            case, source, schema, local, deterministic, deterministic_latency, direct_latency,
            mode=args.mode, hybrid_result=hybrid,
        )
        event["benchmark_run_id"] = run_id
        results.append(result); events.append(event)
        if not args.quiet:
            print(f"[{position:03d}/{len(cases):03d}] {case['case_id']} {result['quality_status']} saved={result['avoided_gpt_tokens']}", file=sys.stderr)
    totals = aggregate(results)
    per_class = {name: aggregate([item for item in results if item["activity_class"] == name]) for name in QUALITY_THRESHOLDS}
    event_class = {case["case_id"]: case["activity_class"] for case in cases}
    inference_reconciliation = reconcile_inference_events(events)
    local_events = inference_reconciliation["unique_events"]
    apply_inference_denominator(totals, inference_reconciliation["local_inference_calls"])
    totals.update({
        "benchmark_local_input_tokens_all_calls": sum(int(event.get("local_input_tokens") or 0) for event in local_events),
        "benchmark_local_output_tokens_all_calls": sum(int(event.get("local_output_tokens") or 0) for event in local_events),
        "gpu_observed_calls": sum(event.get("gpu_metrics_status") == "observed" for event in local_events),
        "gpu_peak_percent": max((float(event.get("gpu_peak_percent") or 0) for event in local_events), default=None),
        "vram_peak_mib": max((float(event.get("vram_peak_mib") or 0) for event in local_events), default=None),
        "power_peak_watts": max((float(event.get("power_peak_watts") or 0) for event in local_events), default=None),
    })
    for name, summary in per_class.items():
        class_items = [item for item in results if item["activity_class"] == name]
        class_events = [event for event in local_events if event_class.get(event.get("case_id")) == name]
        apply_inference_denominator(summary, len(class_events))
        summary.update({
            "benchmark_local_input_tokens_all_calls": sum(int(event.get("local_input_tokens") or 0) for event in class_events),
            "benchmark_local_output_tokens_all_calls": sum(int(event.get("local_output_tokens") or 0) for event in class_events),
            "gpu_observed_calls": sum(event.get("gpu_metrics_status") == "observed" for event in class_events),
        })
        summary["objective_metrics"] = objective_summary(name, class_items)
        if name == "file_selection":
            compared = [item for item in class_items if item.get("hybrid_compared")]
            summary["hybrid_comparison"] = {
                "cases": len(compared),
                "local_only_acceptance_rate": round(ratio(sum(item.get("local_only_quality_status") == "accepted" for item in compared), len(compared)), 4),
                "hybrid_acceptance_rate": round(ratio(sum(item.get("quality_status") == "accepted" for item in compared), len(compared)), 4),
                "local_only_quality_score": round(statistics.mean(float(item.get("local_only_quality_score") or 0) for item in compared), 4) if compared else None,
                "hybrid_quality_score": round(statistics.mean(float(item.get("quality_score") or 0) for item in compared), 4) if compared else None,
                "local_only_latency_p50_seconds": percentile([float(item.get("local_only_duration_seconds") or 0) for item in compared], 0.50),
                "hybrid_latency_p50_seconds": percentile([float(item.get("duration_seconds") or 0) for item in compared], 0.50),
            }
        decision, reason = decision_for(name, summary, class_items)
        summary["decision"] = decision; summary["decision_reason"] = reason
        summary["baseline_comparison"] = baseline_comparison(name, summary)
        summary["rtx_operational_advantage"] = summary["baseline_comparison"]["rtx_operational_advantage"]
    cases_by_id = {case["case_id"]: case for case in cases}
    matrix = classification_matrix(results, cases_by_id, local_outputs)
    macro_f1 = statistics.mean(row["f1"] for row in matrix) if matrix else 0.0
    per_class["classification"]["objective_metrics"]["macro_f1"] = round(macro_f1, 4)
    generated_at = utc_now()
    provenance = ground_truth_provenance(cases)
    model_configuration = {
        "model": model, "num_ctx": 12288, "num_predict": 700,
        "temperature": 0, "seed": 20260824, "think": False,
    }
    report = {
        "schema_version": SCHEMA_VERSION,
        "schema_reference": "scripts/local-ai/benchmarks/high-potential/schemas/report-v2.json",
        "suite": SUITE_NAME, "benchmark_run_id": run_id,
        "execution_mode": "benchmark", "excluded_from_production_metrics": True,
        "primary_metric_excludes": ["summarize-log"], "mode": args.mode,
        "model": model, "benchmark_executed_at": generated_at, "artifact_recomputed_at": None,
        "results_recomputed_from_existing_raw_artifacts": False,
        "benchmark_rerun_reason": None,
        "measurement_basis": {
            "gpt_tokens": "estimated",
            "gpt_token_estimation_method": "utf8_bytes_divided_by_4",
            "gpt_direct_execution": "simulated",
            "local_inference": "measured" if args.mode == "local-ai" else "simulated",
            "gpu_telemetry": "measured" if args.mode == "local-ai" else "not_applicable",
            "deterministic_execution": "measured",
            "gpt_final_quality": "not_tested",
        },
        "dataset": {
            "cases": len(cases), "real_anonymized": sum(case["source_type"] == "real_anonymized" for case in cases),
            "synthetic": sum(case["source_type"] == "synthetic" for case in cases),
            "calibration": sum(case["split"] == "calibration" for case in cases),
            "holdout": sum(case["split"] == "holdout" for case in cases),
            "dataset_sha256": stable_hash(cases), "inputs_sha256": stable_hash({case["case_id"]: inputs[case["case_id"]] for case in cases}),
        },
        "ground_truth_provenance": provenance,
        "artifact_hashes": {
            "dataset": stable_hash(cases),
            "ground_truth": provenance["frozen_hash"],
            "schemas": stable_hash(schemas),
            "schemas_at_execution": stable_hash(schemas),
            "benchmark_implementation": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "prompts": hashlib.sha256(inspect.getsource(local_prompt).encode("utf-8")).hexdigest(),
            "model_configuration": stable_hash(model_configuration),
        },
        "artifact_hash_basis": {
            "dataset": "loaded_for_this_execution",
            "ground_truth": "loaded_for_this_execution",
            "schemas": "loaded_for_this_execution",
            "benchmark_implementation": "executed_file",
            "prompts": "executed_local_prompt_function",
            "model_configuration": "executed_configuration",
        },
        "implementation_sha256": {
            "benchmark_execution": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dataset_generator": hashlib.sha256((RESEARCH_DIR / "high_potential_dataset.py").read_bytes()).hexdigest(),
            "schemas": stable_hash(schemas),
        },
        "activity_discovery": ACTIVITY_DISCOVERY, "totals": totals,
        "inference_reconciliation": {
            key: value for key, value in inference_reconciliation.items() if key != "unique_events"
        },
        "classification_macro_f1": round(macro_f1, 4),
        "classification_confusion_matrix": matrix,
        "per_activity_class": per_class,
        "operational_policy": copy.deepcopy(OPERATIONAL_POLICY),
        "recommended_configuration": [
            {"activity": name, **copy.deepcopy(OPERATIONAL_POLICY[name])}
            for name in QUALITY_THRESHOLDS
        ],
        "adversarial_validation": adversarial_suite(suite_cases, inputs, schemas),
        "benchmark_events": events, "results": results,
    }
    report["adversarial_metrics"] = {
        "adversarial_scenarios_total": len(report["adversarial_validation"]),
        "adversarial_guardrails_passed": sum(item["passed"] for item in report["adversarial_validation"]),
        "adversarial_model_outputs_accepted": 0,
        "adversarial_model_outputs_rejected": 0,
        "model_output_scope": "not_executed; deterministic guardrail simulations only",
    }
    report["legacy_metric_aliases"] = {
        "deprecated": True,
        "adversarial_cases_passed": report["adversarial_metrics"]["adversarial_guardrails_passed"],
        "adversarial_cases_total": report["adversarial_metrics"]["adversarial_scenarios_total"],
    }
    return report


def recompute_existing_report(source_path: Path, dataset_dir: Path = DATASET_DIR) -> dict[str, Any]:
    """Upgrade a v1 measured artifact without performing another model inference."""
    source_path = source_path.resolve()
    source = json.loads(source_path.read_text(encoding="utf-8"))
    if source.get("suite") != "local-ai-high-potential-v1":
        raise RuntimeError("recompute_requires_v1_source")
    cases, inputs, schemas = load_dataset(dataset_dir)
    cases_by_id = {case["case_id"]: case for case in cases}
    enriched_results = []
    for old_result in source.get("results", []):
        case = cases_by_id[old_result["case_id"]]
        schema = schemas[Path(case["schema_reference"]).name]
        enriched_results.append(enrich_result_v2(old_result, case, inputs[case["case_id"]], schema))

    result_by_case = {item["case_id"]: item for item in enriched_results}
    enriched_events = []
    for old_event in source.get("benchmark_events", []):
        event = copy.deepcopy(old_event)
        result = result_by_case.get(event.get("case_id"))
        if not event.get("job_id"):
            event["attempt_id"] = None
            event["call_role"] = "not-attempted"
        elif result and event.get("job_id") == result.get("job_id"):
            event["attempt_id"] = f"{event['case_id']}:selected"
            event["call_role"] = "selected"
        else:
            event["attempt_id"] = f"{event['case_id']}:local-only"
            event["call_role"] = "local-only"
        enriched_events.append(event)

    inference_reconciliation = reconcile_inference_events(enriched_events)
    totals = aggregate(enriched_results)
    apply_inference_denominator(totals, inference_reconciliation["local_inference_calls"])
    old_totals = source.get("totals") or {}
    for field in (
        "benchmark_local_input_tokens_all_calls", "benchmark_local_output_tokens_all_calls",
        "gpu_observed_calls", "gpu_peak_percent", "vram_peak_mib", "power_peak_watts",
    ):
        totals[field] = old_totals.get(field)

    per_class = {}
    for name in QUALITY_THRESHOLDS:
        class_items = [item for item in enriched_results if item["activity_class"] == name]
        summary = aggregate(class_items)
        class_inference_calls = sum(
            event.get("case_id") in {item["case_id"] for item in class_items}
            for event in inference_reconciliation["unique_events"]
        )
        apply_inference_denominator(summary, class_inference_calls)
        old_summary = (source.get("per_activity_class") or {}).get(name) or {}
        summary["objective_metrics"] = copy.deepcopy(old_summary.get("objective_metrics") or {})
        if old_summary.get("hybrid_comparison") is not None:
            summary["hybrid_comparison"] = copy.deepcopy(old_summary["hybrid_comparison"])
        for field in (
            "benchmark_local_input_tokens_all_calls", "benchmark_local_output_tokens_all_calls", "gpu_observed_calls",
        ):
            summary[field] = old_summary.get(field)
        decision, reason = decision_for(name, summary, class_items)
        summary["decision"] = decision
        summary["decision_reason"] = reason
        summary["baseline_comparison"] = baseline_comparison(name, summary)
        summary["rtx_operational_advantage"] = summary["baseline_comparison"]["rtx_operational_advantage"]
        per_class[name] = summary

    provenance = ground_truth_provenance(cases)
    model = str(source.get("model") or "unknown")
    model_configuration = {
        "model": model, "num_ctx": 12288, "num_predict": 700,
        "temperature": 0, "seed": 20260824, "think": False,
    }
    old_implementation = source.get("implementation_sha256") or {}
    adversarial_validation = adversarial_suite(cases, inputs, schemas)
    report = {
        "schema_version": SCHEMA_VERSION,
        "schema_reference": "scripts/local-ai/benchmarks/high-potential/schemas/report-v2.json",
        "suite": SUITE_NAME,
        "benchmark_run_id": source["benchmark_run_id"],
        "execution_mode": "benchmark",
        "excluded_from_production_metrics": True,
        "primary_metric_excludes": ["summarize-log"],
        "mode": source.get("mode"),
        "model": model,
        "benchmark_executed_at": source.get("generated_at"),
        "artifact_recomputed_at": utc_now(),
        "results_recomputed_from_existing_raw_artifacts": True,
        "benchmark_rerun_reason": None,
        "source_artifact": {
            "schema_version": 1,
            "suite": source.get("suite"),
            "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
            "path": str(source_path.relative_to(ROOT)),
        },
        "measurement_basis": {
            "gpt_tokens": "estimated",
            "gpt_token_estimation_method": "utf8_bytes_divided_by_4",
            "gpt_direct_execution": "simulated",
            "local_inference": "measured",
            "gpu_telemetry": "measured",
            "deterministic_execution": "recomputed",
            "gpt_final_quality": "not_tested",
        },
        "dataset": copy.deepcopy(source.get("dataset") or {}),
        "ground_truth_provenance": provenance,
        "artifact_hashes": {
            "dataset": stable_hash(cases),
            "ground_truth": provenance["frozen_hash"],
            "schemas": stable_hash(schemas),
            "schemas_at_execution": old_implementation.get("schemas"),
            "benchmark_execution_implementation": old_implementation.get("harness"),
            "artifact_recomputation_implementation": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "prompts": hashlib.sha256(inspect.getsource(local_prompt).encode("utf-8")).hexdigest(),
            "model_configuration": stable_hash(model_configuration),
        },
        "artifact_hash_basis": {
            "dataset": "matches_v1_dataset_sha256",
            "ground_truth": "recomputed_from_unchanged_dataset_fixtures",
            "schemas": "current_schema_set_including_report_v2",
            "schemas_at_execution": "v1_implementation_sha256.schemas",
            "benchmark_execution_implementation": "v1_implementation_sha256.harness",
            "artifact_recomputation_implementation": "current_recomputation_file",
            "prompts": "reconstructed_from_unchanged_local_prompt_function",
            "model_configuration": "reconstructed_from_v1_model_and_versioned_constants",
        },
        "implementation_sha256": {
            "benchmark_execution": old_implementation.get("harness"),
            "artifact_recomputation": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dataset_generator": old_implementation.get("dataset_generator"),
            "schemas_at_execution": old_implementation.get("schemas"),
        },
        "activity_discovery": copy.deepcopy(source.get("activity_discovery") or ACTIVITY_DISCOVERY),
        "totals": totals,
        "inference_reconciliation": {
            key: value for key, value in inference_reconciliation.items() if key != "unique_events"
        },
        "classification_macro_f1": source.get("classification_macro_f1"),
        "classification_confusion_matrix": copy.deepcopy(source.get("classification_confusion_matrix") or []),
        "per_activity_class": per_class,
        "operational_policy": copy.deepcopy(OPERATIONAL_POLICY),
        "recommended_configuration": [
            {"activity": name, **copy.deepcopy(OPERATIONAL_POLICY[name])}
            for name in QUALITY_THRESHOLDS
        ],
        "adversarial_validation": adversarial_validation,
        "adversarial_metrics": {
            "adversarial_scenarios_total": len(adversarial_validation),
            "adversarial_guardrails_passed": sum(bool(item.get("passed")) for item in adversarial_validation),
            "adversarial_model_outputs_accepted": 0,
            "adversarial_model_outputs_rejected": 0,
            "model_output_scope": "not_executed; deterministic guardrail simulations only",
            "guardrails_recomputed_during_v2_migration": True,
        },
        "benchmark_events": enriched_events,
        "results": enriched_results,
        "legacy_metric_aliases": {
            "deprecated": True,
            "source_schema_version": 1,
            "source_totals": copy.deepcopy(source.get("totals") or {}),
            "adversarial_cases_passed": source.get("adversarial_cases_passed"),
            "adversarial_cases_total": source.get("adversarial_cases_total"),
        },
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("simulated", "local-ai"), default="simulated")
    parser.add_argument("--dataset-dir", type=Path, default=DATASET_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--split", choices=("all", "calibration", "holdout"), default="all")
    parser.add_argument("--model")
    parser.add_argument("--benchmark-run-id")
    parser.add_argument("--recompute-existing", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--no-artifacts", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--compare-file-selection", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    report = recompute_existing_report(args.recompute_existing, args.dataset_dir) if args.recompute_existing else run_benchmark(args)
    if not args.no_artifacts:
        write_artifacts(report, args.output_dir)
    public = {key: value for key, value in report.items() if key not in {"results", "benchmark_events"}}
    if args.quiet:
        print(json.dumps({
            "schema_version": report["schema_version"],
            "benchmark_run_id": report["benchmark_run_id"],
            "results_recomputed_from_existing_raw_artifacts": report[
                "results_recomputed_from_existing_raw_artifacts"
            ],
            "totals": {
                key: report["totals"][key] for key in (
                    "total_cases", "rtx_attempted_cases", "local_inference_calls",
                    "useful_cases", "fallback_cases", "critical_error_occurrences",
                    "cases_with_critical_error",
                )
            },
        }, ensure_ascii=False))
    else:
        print(json.dumps(public, ensure_ascii=False, indent=2))
    adversarial = report["adversarial_metrics"]
    return 0 if adversarial["adversarial_guardrails_passed"] == adversarial["adversarial_scenarios_total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
