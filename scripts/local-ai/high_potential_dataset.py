#!/usr/bin/env python3
"""Build the public, anonymized high-potential Local AI benchmark dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "scripts" / "local-ai" / "benchmarks" / "high-potential"
ACTIVITY_CLASSES = {
    "structured_extraction": ("extract-structured",),
    "classification": ("classify-task", "classify-diff"),
    "file_selection": ("triage-files", "select-context"),
    "error_clustering": ("cluster-errors", "deduplicate-errors"),
    "diff_summary": ("summarize-diff",),
}
CLASS_WEIGHTS = {
    "structured_extraction": 1.20,
    "classification": 1.40,
    "file_selection": 1.10,
    "error_clustering": 0.80,
    "diff_summary": 1.00,
}
ADVERSARIAL_TAGS = [
    "malformed_local_json",
    "critical_field_omitted",
    "numeric_value_changed",
    "invented_file_path",
    "critical_file_marked_irrelevant",
    "similar_errors_distinct_causes",
    "different_errors_same_cause",
    "comment_only_diff",
    "small_critical_diff",
    "large_mechanical_diff",
    "too_small_for_rtx",
    "rtx_unavailable",
    "sampler_none",
    "inference_timeout",
    "same_task_retry",
    "rejected_then_full_fallback",
    "deterministic_beats_rtx",
    "token_reduction_with_quality_loss",
    "local_output_expands_context",
    "duplicate_job_id",
]


def estimated_tokens(text: str) -> int:
    return math.ceil(len(text.encode("utf-8")) / 4)


def object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def schemas() -> dict[str, dict[str, Any]]:
    string_array = {"type": "array", "items": {"type": "string"}}
    confidence = {"type": "number", "minimum": 0, "maximum": 1}
    return {
        "extract-errors": object_schema({
            "errors": {
                "type": "array",
                "items": object_schema({
                    "name": {"type": "string"}, "path": {"type": "string"},
                    "line": {"type": "integer"}, "exit_code": {"type": "integer"},
                }, ["name", "path", "line", "exit_code"]),
            },
        }, ["errors"]),
        "extract-diff-symbols": object_schema({
            "files": string_array,
            "symbols": string_array,
        }, ["files", "symbols"]),
        "extract-commands": object_schema({
            "commands": {
                "type": "array",
                "items": object_schema({
                    "command": {"type": "string"}, "exit_code": {"type": "integer"},
                    "status": {"type": "string", "enum": ["success", "failed"]},
                }, ["command", "exit_code", "status"]),
            },
        }, ["commands"]),
        "extract-metrics": object_schema({
            "metrics": {
                "type": "array",
                "items": object_schema({
                    "name": {"type": "string"}, "value": {"type": "number"},
                    "unit": {"type": "string"},
                }, ["name", "value", "unit"]),
            },
        }, ["metrics"]),
        "extract-components": object_schema({
            "components": {
                "type": "array",
                "items": object_schema({
                    "name": {"type": "string"}, "dependency": {"type": "string"},
                    "configuration": {"type": "string"},
                }, ["name", "dependency", "configuration"]),
            },
        }, ["components"]),
        "extract-telemetry": object_schema({
            "events": {
                "type": "array",
                "items": object_schema({
                    "job_id": {"type": "string"}, "task": {"type": "string"},
                    "duration_seconds": {"type": "number"}, "status": {"type": "string"},
                }, ["job_id", "task", "duration_seconds", "status"]),
            },
        }, ["events"]),
        "classification": object_schema({
            "labels": {"type": "array", "items": {"type": "string"}},
            "eligible": {"type": "boolean"},
            "requires_primary_review": {"type": "boolean"},
            "abstain": {"type": "boolean"},
            "confidence": confidence,
        }, ["labels", "eligible", "requires_primary_review", "abstain", "confidence"]),
        "file-selection": object_schema({
            "selected_files": string_array,
            "needs_full_context": {"type": "boolean"},
            "confidence": confidence,
        }, ["selected_files", "needs_full_context", "confidence"]),
        "error-clustering": object_schema({
            "clusters": {
                "type": "array",
                "items": object_schema({
                    "cluster_id": {"type": "string"}, "error_ids": string_array,
                    "representative_id": {"type": "string"}, "root_cause": {"type": "string"},
                }, ["cluster_id", "error_ids", "representative_id", "root_cause"]),
            },
        }, ["clusters"]),
        "diff-summary": object_schema({
            "observed": {
                "type": "array",
                "items": object_schema({
                    "kind": {"type": "string", "enum": [
                        "behavior_added", "behavior_removed", "behavior_modified", "test_changed",
                        "configuration_changed", "contract_changed", "comment_only", "observable_risk",
                    ]},
                    "file": {"type": "string"}, "symbol": {"type": "string"},
                    "evidence": {"type": "string"},
                }, ["kind", "file", "symbol", "evidence"]),
            },
            "inferred": string_array,
            "unknown": string_array,
        }, ["observed", "inferred", "unknown"]),
    }


def pad(lines: list[str], index: int, prefix: str) -> str:
    """Create stable size bands without allowing one giant fixture to dominate."""
    band = index % 5
    counts = (0, 140, 260, 420, 650)
    count = counts[band]
    noise = [f"{prefix} routine_record_{item:04d}=unchanged" for item in range(count)]
    return "\n".join([*lines, *noise])


def extraction_case(index: int) -> tuple[str, str, dict[str, Any], list[str], list[str]]:
    kind = index % 6
    if kind == 0:
        name = ("AssertionError", "RuntimeError", "ValueError")[index % 3]
        path = ("scripts/local-ai/test_local_ai.py", "ia-bridge/usage.test.js", "homeassistant/tests/test_chat_rtx_dashboard_layout.py")[index % 3]
        line, code = 40 + index, 1 + index % 2
        source = pad([
            f"FAIL public_fixture_{index}", f"{name}: expected benchmark invariant",
            f"  at {path}:{line}:7", f"process exited with code {code}",
        ], index, "PASS")
        expected = {"errors": [{"name": name, "path": path, "line": line, "exit_code": code}]}
        return "extract-errors", source, expected, [name, path, str(line), str(code)], []
    if kind == 1:
        path = ("scripts/local-ai/routing.py", "scripts/local-ai/telemetry.py", "ia-bridge/usage.js")[index % 3]
        symbol = ("assess_routing", "_add_totals", "scanLocalAiTelemetry")[index % 3]
        source = pad([
            f"diff --git a/{path} b/{path}", f"--- a/{path}", f"+++ b/{path}",
            "@@ -1,2 +1,3 @@", f" def {symbol}(...):", "+    benchmark_mode = True",
        ], index, "+# generated context")
        expected = {"files": [path], "symbols": [symbol]}
        return "extract-diff-symbols", source, expected, [path, symbol], []
    if kind == 2:
        command = ("make validate-local-ai", "node --test ia-bridge/usage.test.js", "make validate-homeassistant")[index % 3]
        code = 0 if index % 4 else 2
        status = "success" if code == 0 else "failed"
        source = pad([f"$ {command}", f"command status: {status}", f"exit code: {code}"], index, "output")
        expected = {"commands": [{"command": command, "exit_code": code, "status": status}]}
        return "extract-commands", source, expected, [command, str(code)], []
    if kind == 3:
        gpu, vram, duration = 42 + index, 6200 + index * 3, round(1.25 + index / 10, 2)
        source = pad([
            f"gpu_peak_percent={gpu}", f"vram_peak_mib={vram}", f"duration_seconds={duration}",
        ], index, "metric_noise")
        expected = {"metrics": [
            {"name": "gpu_peak_percent", "value": gpu, "unit": "%"},
            {"name": "vram_peak_mib", "value": vram, "unit": "MiB"},
            {"name": "duration_seconds", "value": duration, "unit": "s"},
        ]}
        return "extract-metrics", source, expected, [str(gpu), str(vram), str(duration)], []
    if kind == 4:
        name, dependency, configuration = (
            ("local-ai", "Ollama", "LOCAL_AI_MODEL"),
            ("ai-bridge", "Codex CLI", "WORKDIR"),
            ("Home Assistant", "ai-bridge", "sensor.codex_usage_raw"),
        )[index % 3]
        source = pad([
            f"Component: {name}", f"Depends on: {dependency}", f"Configuration: {configuration}",
        ], index, "Appendix")
        expected = {"components": [{"name": name, "dependency": dependency, "configuration": configuration}]}
        return "extract-components", source, expected, [name, dependency, configuration], []
    job = f"00000000-0000-4000-8000-{index:012d}"
    task, duration, status = "review-diff", round(2.5 + index / 10, 2), "success"
    source = pad([
        json.dumps({"id": job, "task": task, "duration_seconds": duration, "status": status}),
    ], index, "telemetry metadata")
    expected = {"events": [{"job_id": job, "task": task, "duration_seconds": duration, "status": status}]}
    return "extract-telemetry", source, expected, [job, task, str(duration)], []


def classification_case(index: int) -> tuple[str, str, dict[str, Any], list[str], list[str]]:
    activity = "classify-task" if index % 2 == 0 else "classify-diff"
    variants = [
        ("Corrija um valor em JSON já estruturado.", ["DETERMINISTIC", "TOO_SMALL"], False, False, False),
        ("diff --git a/docs/guide.md b/docs/guide.md\n+# Example\n+```python\n+print('code block')\n+```", ["DOCUMENTATION"], False, False, False),
        ("diff --git a/src/auth.ts b/src/auth.ts\n-allow_all()\n+require_owner()", ["CODE", "POTENTIALLY_DESTRUCTIVE", "PRIMARY_REVIEW_REQUIRED"], False, True, False),
        ("Agrupe 900 linhas repetidas de falhas, mantendo causas distintas.", ["RTX_ELIGIBLE", "PRIMARY_REVIEW_REQUIRED"], True, True, False),
        ("diff --git a/tests/routing.test.py b/tests/routing.test.py\n+def test_abstain(): pass", ["TEST"], False, False, False),
        ("Atualize 80 arquivos trocando mecanicamente uma chave já validada.", ["DETERMINISTIC"], False, False, False),
        ("A descrição está incompleta e não informa tipo, tamanho ou risco.", ["ABSTAIN", "PRIMARY_REVIEW_REQUIRED"], False, True, True),
        ("diff --git a/scripts/local-ai/telemetry.py b/scripts/local-ai/telemetry.py\n+event['benchmark']=True", ["CODE", "TELEMETRY", "PRIMARY_REVIEW_REQUIRED"], False, True, False),
        ("diff --git a/homeassistant/configuration.yaml b/homeassistant/configuration.yaml\n+feature: true", ["CONFIGURATION", "PRIMARY_REVIEW_REQUIRED"], False, True, False),
        ("Resuma 4.000 tokens de inventário de arquivos previamente filtrado.", ["RTX_ELIGIBLE"], True, False, False),
    ]
    text, labels, eligible, primary, abstain = variants[index % len(variants)]
    source = "\n".join([f"ACTIVITY: {activity}", text]) if "POTENTIALLY_DESTRUCTIVE" in labels else pad(
        [f"ACTIVITY: {activity}", text], index, "neutral context"
    )
    expected = {
        "labels": labels, "eligible": eligible,
        "requires_primary_review": primary, "abstain": abstain,
    }
    forbidden = ["RTX_ELIGIBLE"] if "POTENTIALLY_DESTRUCTIVE" in labels or abstain else []
    return activity, source, expected, labels, forbidden


FILE_TOPICS = [
    ("ajustar roteamento Local AI", ["scripts/local-ai/routing.py", "scripts/local-ai/test_routing.py"]),
    ("alterar telemetria e agregação", ["scripts/local-ai/telemetry.py", "scripts/local-ai/test_local_ai.py", "ia-bridge/usage.js", "ia-bridge/usage.test.js"]),
    ("alterar painel uso-rtx", ["homeassistant/dashboards/chat.yaml", "homeassistant/packages/codex_usage.yaml", "homeassistant/tests/test_chat_rtx_dashboard_layout.py", "homeassistant/tests/test_dashboard_number_formatting.py"]),
    ("alterar benchmark A/B", ["scripts/local-ai/quality_ab.py", "scripts/local-ai/test_quality_ab.py", "docs/LOCAL_AI_BENCHMARK_2026-08-16.md"]),
    ("alterar bridge Codex", ["ia-bridge/server.js", "ia-bridge/usage.js", "ia-bridge/usage.test.js"]),
]


def file_selection_case(index: int) -> tuple[str, str, dict[str, Any], list[str], list[str]]:
    activity = "triage-files" if index % 2 == 0 else "select-context"
    task, critical = FILE_TOPICS[index % len(FILE_TOPICS)]
    candidates = list(dict.fromkeys([
        *critical,
        "scripts/local-ai/README.md", "docs/LOCAL_AI_RTX_4070.md", "Makefile",
        "homeassistant/dashboards/vehicle_primary.yaml", "nodered/package.json",
    ]))
    noise_counts = (0, 90, 150, 230, 320)
    candidates.extend(
        f"generated/unrelated_{item:03d}.txt"
        for item in range(noise_counts[index % len(noise_counts)])
    )
    candidates.sort(key=lambda path: hashlib.sha256(f"{index}:{path}".encode()).hexdigest())
    rows = [f"{path} | public repository candidate | imports=unknown" for path in candidates]
    needs_full_context = len(critical) >= 4 and index % 5 == 4
    source = "\n".join([
        f"TASK: {task}",
        f"CONTRACTS_SPAN_MULTIPLE_LAYERS: {str(needs_full_context).lower()}",
        "CANDIDATES:", *rows,
    ])
    expected = {
        "selected_files": critical,
        "needs_full_context": needs_full_context,
    }
    return activity, source, expected, critical, []


def error_clustering_case(index: int) -> tuple[str, str, dict[str, Any], list[str], list[str]]:
    activity = "cluster-errors" if index % 2 == 0 else "deduplicate-errors"
    patterns = [
        ([
            "E1 | 2026-08-24T10:00:00Z RuntimeError timeout at worker.py:42 request_id=A1",
            "E2 | 2026-08-24T10:00:03Z RuntimeError timeout at worker.py:42 request_id=B9",
            "E3 | ValueError invalid schema at parser.py:18",
        ], [["E1", "E2"], ["E3"]], "timeout_vs_schema"),
        ([
            "E1 | ConnectionError timeout connecting database at db.py:20",
            "E2 | ValidationError timeout must be positive at config.py:20",
            "E3 | ConnectionError timeout connecting database at db.py:21",
        ], [["E1", "E3"], ["E2"]], "similar_words_distinct_causes"),
        ([
            "E1 | HTTP 503 from queue; root=QUEUE_DOWN",
            "E2 | retry exhausted in worker; root=QUEUE_DOWN",
            "E3 | stale cache entry; root=CACHE_TTL",
        ], [["E1", "E2"], ["E3"]], "different_symptoms_same_cause"),
        ([
            "E1 | infra DNS lookup failed host=service-a",
            "E2 | code NameError service_a is undefined",
            "E3 | infra DNS lookup failed host=service-b",
        ], [["E1"], ["E2"], ["E3"]], "infrastructure_vs_code"),
        ([
            "E1 | AssertionError expected 403 got 200 at auth.test.ts:88",
            "E2 | AssertionError expected 403 got 200 at auth.test.ts:88 retry=2",
            "E3 | AssertionError expected 30 got 30000 at ttl.test.ts:44",
        ], [["E1", "E2"], ["E3"]], "retry_deduplication"),
    ]
    errors, groups, root = patterns[index % len(patterns)]
    noise_counts = (0, 90, 150, 230, 320)
    noise_count = noise_counts[index % len(noise_counts)]
    errors.extend(f"N{item:03d} | INFO unrelated successful operation" for item in range(noise_count))
    source = "\n".join(["ERROR RECORDS:", *errors])
    expected = {"clusters": [
        {"cluster_id": f"C{position + 1}", "error_ids": group,
         "representative_id": group[0], "root_cause": root if position == 0 else f"distinct_{position + 1}"}
        for position, group in enumerate(groups)
    ]}
    critical = ["!".join(pair) for pair in groups if len(pair) > 1]
    forbidden = ["E1=E2"] if root == "similar_words_distinct_causes" else []
    return activity, source, expected, critical, forbidden


DIFF_VARIANTS = [
    ("scripts/local-ai/routing.py", "assess_routing", "behavior_modified", "-minimum = 800", "+minimum = 1200"),
    ("scripts/local-ai/telemetry.py", "_add_totals", "behavior_added", " context = total", "+benchmark = excluded"),
    ("ia-bridge/usage.js", "scanLocalAiTelemetry", "behavior_modified", "-return totals;", "+return sanitizedTotals;"),
    ("homeassistant/dashboards/chat.yaml", "uso-rtx", "configuration_changed", "-title: RTX", "+title: RTX 4070"),
    ("scripts/local-ai/test_routing.py", "test_routing", "test_changed", "-assert old", "+assert new"),
    ("docs/LOCAL_AI_RTX_4070.md", "routing-contract", "contract_changed", "-minimum 800", "+minimum 1200"),
    ("scripts/local-ai/local-ai.py", "validate_structured_response", "observable_risk", "-validate(response)", "+return response"),
    ("docs/example.md", "comments", "comment_only", "-# old comment", "+# clearer comment"),
    ("src/public-auth-example.ts", "authorize", "behavior_removed", "-if (!owner) return forbidden();", "+return update();"),
    ("config/public-example.yaml", "retry_limit", "configuration_changed", "-retry_limit: 2", "+retry_limit: 20"),
]


def diff_summary_case(index: int) -> tuple[str, str, dict[str, Any], list[str], list[str]]:
    path, symbol, kind, removed, added = DIFF_VARIANTS[index % len(DIFF_VARIANTS)]
    noise_count = (0, 25, 50, 80, 120)[index % 5]
    noise = []
    for item in range(noise_count):
        noise.extend([
            f"-generated label {item}", f"+generated label {item} updated",
        ])
    source = "\n".join([
        f"diff --git a/{path} b/{path}", f"--- a/{path}", f"+++ b/{path}",
        f"@@ {symbol} @@", removed, added, *noise,
    ])
    observed = [{"kind": kind, "file": path, "symbol": symbol, "evidence": added[1:] if added.startswith("+") else added}]
    expected = {
        "observed": observed, "inferred": [],
        "unknown": ["tests_passed", "regression_safety", "production_usage"],
    }
    forbidden = ["tests passed", "no regressions", "safe", "used in production", "performance improved"]
    return "summarize-diff", source, expected, [path, symbol, kind], forbidden


def build_dataset() -> tuple[list[dict[str, Any]], dict[str, str]]:
    builders = [
        ("structured_extraction", extraction_case),
        ("classification", classification_case),
        ("file_selection", file_selection_case),
        ("error_clustering", error_clustering_case),
        ("diff_summary", diff_summary_case),
    ]
    dataset: list[dict[str, Any]] = []
    inputs: dict[str, str] = {}
    adversarial_index = 0
    for class_name, builder in builders:
        for index in range(20):
            activity, source, expected, critical, forbidden = builder(index)
            case_id = f"{class_name}-{index + 1:02d}"
            source_type = "real_anonymized" if index < 14 else "synthetic"
            split = "calibration" if index < 12 else "holdout"
            small = estimated_tokens(source) < 800 or index % 10 == 0
            tag = []
            if source_type == "synthetic" and adversarial_index < len(ADVERSARIAL_TAGS):
                tag = [ADVERSARIAL_TAGS[adversarial_index]]
                adversarial_index += 1
            schema_name = activity
            if class_name == "structured_extraction":
                schema_name = extraction_case(index)[0]
            elif class_name == "classification":
                schema_name = "classification"
            elif class_name == "file_selection":
                schema_name = "file-selection"
            elif class_name == "error_clustering":
                schema_name = "error-clustering"
            elif class_name == "diff_summary":
                schema_name = "diff-summary"
            baseline = estimated_tokens(source)
            size_band = "small" if baseline < 800 else "medium" if baseline < 3000 else "large"
            expected_eligible = not small and size_band != "small"
            case = {
                "case_id": case_id,
                "activity": activity,
                "activity_class": class_name,
                "source_type": source_type,
                "split": split,
                "input_reference": f"inputs.json#{case_id}",
                "schema_reference": f"schemas/{schema_name}.json",
                "expected_output": expected,
                "critical_facts": critical,
                "forbidden_inferences": forbidden,
                "baseline_tokens": baseline,
                "weight": round(CLASS_WEIGHTS[class_name] * (0.5 if size_band == "small" else 1.0), 2),
                "expected_eligible": expected_eligible,
                "size_band": size_band,
                "adversarial_tags": tag,
            }
            dataset.append(case)
            inputs[case_id] = source
    if len(dataset) != 100:
        raise RuntimeError(f"expected 100 cases, built {len(dataset)}")
    if sum(case["source_type"] == "real_anonymized" for case in dataset) != 70:
        raise RuntimeError("dataset must contain exactly 70 real-anonymized cases")
    return dataset, inputs


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    dataset, inputs = build_dataset()
    expected_files: dict[Path, str] = {
        args.output_dir / "dataset.jsonl": "".join(
            json.dumps(case, ensure_ascii=False, sort_keys=True) + "\n" for case in dataset
        ),
        args.output_dir / "inputs.json": json.dumps(inputs, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    }
    expected_files.update({
        args.output_dir / "schemas" / f"{name}.json": json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        for name, schema in schemas().items()
    })
    if args.check:
        mismatches = [str(path.relative_to(ROOT)) for path, content in expected_files.items()
                      if not path.is_file() or path.read_text(encoding="utf-8") != content]
        if mismatches:
            print("dataset files are stale: " + ", ".join(mismatches))
            return 1
        print("High-potential benchmark dataset is reproducible (100 cases).")
        return 0
    for path, content in expected_files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"Wrote {len(dataset)} cases to {args.output_dir.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
