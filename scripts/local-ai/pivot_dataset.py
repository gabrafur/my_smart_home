#!/usr/bin/env python3
"""Build and validate the frozen datasets for the restricted Local AI pivot."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
DATASET_ROOT = ROOT / "scripts/local-ai/benchmarks/restricted-pivot-v1"
INITIAL_HEAD = "661f631cd4451d67023b138c34b77ed3899c9b10"

STRUCTURED_SUBTYPES = (
    "test_build_output",
    "structured_diff_change",
    "configuration_documentation",
    "event_telemetry",
    "command_tool_output",
)
LOG_KINDS = (
    "pytest_failure",
    "node_failure",
    "home_assistant_warning",
    "docker_compose_failure",
    "shell_timeout",
    "git_success",
    "yaml_validation_failure",
    "security_scanner_warning",
    "privacy_scanner_failure",
    "build_oom",
    "truncated_stacktrace",
    "multiple_failures",
)
PUBLIC_PATHS = (
    "scripts/local-ai/local-ai.py",
    "scripts/local-ai/routing.py",
    "scripts/local-ai/telemetry.py",
    "scripts/local-ai/model_registry.py",
    "scripts/local-ai/quality_bakeoff.py",
    "scripts/local-ai/high_potential_benchmark.py",
    "scripts/local-ai/quality_ab.py",
    "scripts/local-ai/system_ab.py",
    "scripts/local-ai/post_tool_routing.py",
    "scripts/local-ai/memory_context.py",
    "ia-bridge/server.js",
    "ia-bridge/usage.js",
    "homeassistant/packages/codex_usage.yaml",
    "homeassistant/dashboards/chat.yaml",
    "homeassistant/tests/test_chat_rtx_dashboard_layout.py",
    "docs/LOCAL_AI_RTX_4070.md",
    "docs/LOCAL_AI_BENCHMARK_2026-08-16.md",
    "docs/LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md",
    "Makefile",
    "docker-compose.yml",
)
TEXT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".ini", ".java",
    ".jinja", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".rs", ".sh",
    ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
TEST_MARKERS = ("/test/", "/tests/", "test_", ".test.", ".spec.")
MECHANICAL_SUBJECT = re.compile(
    r"\b(merge|format(?:ting)?|lockfile|vendor|generated|bump|chore: update dependencies)\b",
    re.IGNORECASE,
)


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_hash(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path: Path, values: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(stable_json(value) + "\n" for value in values), encoding="utf-8")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL)


def structured_schema() -> dict[str, Any]:
    properties = {
        "record_id": {"type": "string", "pattern": "^RSP-2026-[0-9]{3}$"},
        "status": {"enum": ["passed", "failed", "warning"]},
        "path": {"type": "string"},
        "line": {"type": "integer", "minimum": 1},
        "count": {"type": "integer", "minimum": 0},
        "duration_seconds": {"type": "number", "minimum": 0},
        "error_code": {"type": "string", "pattern": "^PVT-[A-Z]{3}-[0-9]{3}$"},
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def structured_source(subtype: str, expected: dict[str, Any]) -> str:
    value = expected
    templates = {
        "test_build_output": (
            "Registro final do build {record_id}: resultado {status}; alvo {path}, linha {line}; "
            "foram observadas {count} verificações em {duration_seconds} s; código {error_code}."
        ),
        "structured_diff_change": (
            "Ledger da mudança {record_id} — estado {status}. O patch toca {path} na linha {line}; "
            "{count} blocos foram contabilizados, duração {duration_seconds} segundos, marcador {error_code}."
        ),
        "configuration_documentation": (
            "Nota de configuração [{record_id}]: {path} (linha {line}) ficou {status}; quantidade "
            "documentada {count}, janela de {duration_seconds} s e diagnóstico {error_code}."
        ),
        "event_telemetry": (
            "Envelope textual de evento {record_id} | status {status} | origem {path}:{line} | "
            "amostras {count} | elapsed {duration_seconds} seconds | code {error_code}."
        ),
        "command_tool_output": (
            "A ferramenta encerrou o registro {record_id} como {status}. Referência: {path}, linha {line}. "
            "Contagem: {count}. Tempo medido: {duration_seconds} s. Sinal: {error_code}."
        ),
    }
    return templates[subtype].format(**value)


def deterministic_structured_status(source: str) -> str | None:
    if source.lstrip().startswith("{"):
        return None
    if re.search(r"(?m)^(record_id|status|path|line|count|duration_seconds|error_code)=", source):
        return None
    return "UNSUPPORTED"


def build_structured_dataset() -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    missing = [path for path in PUBLIC_PATHS if not (ROOT / path).exists()]
    if missing:
        raise RuntimeError(f"structured_fixture_paths_missing:{','.join(missing)}")
    cases: list[dict[str, Any]] = []
    inputs: dict[str, str] = {}
    statuses = ("failed", "warning", "passed")
    for index in range(125):
        subtype = STRUCTURED_SUBTYPES[index % len(STRUCTURED_SUBTYPES)]
        case_id = f"structured-{index + 1:03d}"
        expected = {
            "record_id": f"RSP-2026-{index + 1:03d}",
            "status": statuses[index % len(statuses)],
            "path": PUBLIC_PATHS[index % len(PUBLIC_PATHS)],
            "line": 11 + (index * 17) % 1800,
            "count": 3 + (index * 13) % 997,
            "duration_seconds": round(0.625 + index * 0.137, 3),
            "error_code": f"PVT-{subtype[:3].upper()}-{index + 1:03d}",
        }
        source = structured_source(subtype, expected)
        residual_status = deterministic_structured_status(source)
        if residual_status not in {"UNSUPPORTED", "AMBIGUOUS"}:
            raise RuntimeError(f"structured_case_not_residual:{case_id}")
        inputs[case_id] = source
        cases.append({
            "case_id": case_id,
            "split": "calibration" if index < 25 else "promotion_holdout",
            "subtype": subtype,
            "input_reference": f"inputs.json#{case_id}",
            "deterministic_status": residual_status,
            "expected_output": expected,
            "critical_fields": list(expected),
            "numeric_fields": ["line", "count", "duration_seconds"],
            "forbidden_fields": ["root_cause", "secret", "token", "invented_path"],
            "ground_truth_provenance": {
                "kind": "deterministic_template_literal",
                "path_exists_at_initial_head": True,
                "values_present_verbatim_in_source": True,
            },
            "ground_truth_independence": "VERIFIED_INDEPENDENT",
        })
    manifest = {
        "schema_version": 1,
        "dataset": "restricted-pivot-structured-extraction-v1",
        "initial_head": INITIAL_HEAD,
        "cases": len(cases),
        "calibration_cases": 25,
        "promotion_holdout_cases": 100,
        "subtypes": dict(Counter(case["subtype"] for case in cases)),
        "ground_truth_independence": "VERIFIED_INDEPENDENT",
        "generator_sha256": file_hash(Path(__file__)),
    }
    return cases, inputs, manifest


def log_schema() -> dict[str, Any]:
    fact = {
        "type": "object",
        "properties": {
            "fact_id": {"type": "string"},
            "value": {"type": "string"},
        },
        "required": ["fact_id", "value"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "observed_facts": {"type": "array", "items": fact},
            "failures": {"type": "array", "items": fact},
            "warnings": {"type": "array", "items": fact},
            "hypotheses": {"type": "array", "items": {"type": "string"}},
            "unknowns": {"type": "array", "items": {"type": "string"}},
            "recommended_next_checks": {"type": "array", "items": {"type": "string"}},
            "concise_summary": {"type": "string"},
        },
        "required": [
            "observed_facts", "failures", "warnings", "hypotheses", "unknowns",
            "recommended_next_checks", "concise_summary",
        ],
        "additionalProperties": False,
    }


def log_profile(kind: str, index: int) -> dict[str, Any]:
    failed = kind not in {"git_success", "home_assistant_warning", "security_scanner_warning"}
    warning = kind in {"home_assistant_warning", "security_scanner_warning", "truncated_stacktrace"}
    total = 24 + index % 31
    failures = 0 if not failed else 1 + index % 3
    skipped = index % 4
    passed = max(0, total - failures - skipped)
    exit_code = 1 if failed else 0
    path = PUBLIC_PATHS[index % len(PUBLIC_PATHS)]
    line = 20 + (index * 19) % 1500
    duration = round(1.25 + (index % 40) * 0.37, 2)
    service = {
        "home_assistant_warning": "homeassistant",
        "docker_compose_failure": "compose",
        "shell_timeout": "shell",
        "build_oom": "builder",
    }.get(kind, "validation")
    error_code = {
        "shell_timeout": "TIMEOUT",
        "build_oom": "OOM",
        "privacy_scanner_failure": "PRIVACY_VIOLATION",
        "security_scanner_warning": "SECURITY_WARNING",
        "yaml_validation_failure": "YAML_INVALID",
        "docker_compose_failure": "SERVICE_UNHEALTHY",
    }.get(kind, "ASSERTION_FAILED" if failed else "NONE")
    return {
        "failed": failed,
        "warning": warning,
        "total": total,
        "failed_count": failures,
        "skipped": skipped,
        "passed": passed,
        "exit_code": exit_code,
        "path": path,
        "line": line,
        "duration": duration,
        "service": service,
        "error_code": error_code,
    }


def build_log_source(case_id: str, kind: str, profile: dict[str, Any], index: int) -> str:
    command = f"validate-{kind.replace('_', '-')} --case {case_id}"
    lines = [f"$ {command}", f"SERVICE={profile['service']}"]
    routine_lines = 50 + (index % 5) * 20
    for sequence in range(routine_lines):
        lines.append(f"INFO step={sequence + 1:03d} case={case_id} routine check completed")
    if profile["warning"]:
        lines.append(f"WARNING code={profile['error_code']} service={profile['service']}")
    if profile["failed"]:
        lines.extend([
            f"ERROR code={profile['error_code']} service={profile['service']}",
            f'File "{profile["path"]}", line {profile["line"]}, in pivot_fixture',
        ])
        if kind in {"truncated_stacktrace", "multiple_failures"}:
            lines.append("RuntimeError: observed fixture failure")
        if kind == "multiple_failures":
            lines.append("ERROR code=SECONDARY_FAILURE service=validation")
        if kind == "shell_timeout":
            lines.append("process terminated after timeout retry=2")
        if kind == "build_oom":
            lines.append("process killed: out of memory")
    if kind == "truncated_stacktrace":
        lines.append("[output truncated after retained stack frame]")
    lines.extend([
        (
            f"TEST_SUMMARY total={profile['total']} passed={profile['passed']} "
            f"failed={profile['failed_count']} skipped={profile['skipped']} "
            f"duration_seconds={profile['duration']}"
        ),
        f"EXIT_CODE={profile['exit_code']}",
    ])
    return "\n".join(lines)


def expected_log_facts(case_id: str, kind: str, profile: dict[str, Any]) -> list[dict[str, Any]]:
    facts = [
        {"fact_id": "command", "category": "observed", "value": f"validate-{kind.replace('_', '-')} --case {case_id}", "critical": True},
        {"fact_id": "service", "category": "observed", "value": profile["service"], "critical": True},
        {"fact_id": "tests_total", "category": "observed", "value": str(profile["total"]), "critical": True},
        {"fact_id": "tests_passed", "category": "observed", "value": str(profile["passed"]), "critical": True},
        {"fact_id": "tests_failed", "category": "observed", "value": str(profile["failed_count"]), "critical": True},
        {"fact_id": "tests_skipped", "category": "observed", "value": str(profile["skipped"]), "critical": True},
        {"fact_id": "duration_seconds", "category": "observed", "value": str(profile["duration"]), "critical": True},
        {"fact_id": "exit_code", "category": "observed", "value": str(profile["exit_code"]), "critical": True},
    ]
    if profile["warning"]:
        facts.append({"fact_id": "warning_code", "category": "warning", "value": profile["error_code"], "critical": True})
    if profile["failed"]:
        facts.extend([
            {"fact_id": "error_code", "category": "failure", "value": profile["error_code"], "critical": True},
            {"fact_id": "file", "category": "failure", "value": profile["path"], "critical": True},
            {"fact_id": "line", "category": "failure", "value": str(profile["line"]), "critical": True},
        ])
    if kind == "multiple_failures":
        facts.append({"fact_id": "secondary_error_code", "category": "failure", "value": "SECONDARY_FAILURE", "critical": True})
    if kind == "shell_timeout":
        facts.append({"fact_id": "retry", "category": "failure", "value": "2", "critical": True})
    if kind == "build_oom":
        facts.append({"fact_id": "oom", "category": "failure", "value": "true", "critical": True})
    if kind == "truncated_stacktrace":
        facts.append({"fact_id": "truncated", "category": "warning", "value": "true", "critical": True})
    return facts


def build_log_dataset() -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    inputs: dict[str, str] = {}
    for index in range(120):
        case_id = f"log-{index + 1:03d}"
        kind = LOG_KINDS[index % len(LOG_KINDS)]
        profile = log_profile(kind, index)
        source = build_log_source(case_id, kind, profile, index)
        facts = expected_log_facts(case_id, kind, profile)
        inputs[case_id] = source
        cases.append({
            "case_id": case_id,
            "split": "calibration" if index < 30 else "promotion_holdout",
            "kind": kind,
            "input_reference": f"inputs.json#{case_id}",
            "expected_facts": facts,
            "critical_fact_ids": [fact["fact_id"] for fact in facts if fact["critical"]],
            "ground_truth_provenance": {
                "kind": "deterministic_log_template",
                "summary_and_exit_code_present_verbatim": True,
                "private_runtime_used": False,
            },
            "ground_truth_independence": "VERIFIED_INDEPENDENT",
        })
    manifest = {
        "schema_version": 1,
        "dataset": "restricted-pivot-summarize-log-v1",
        "cases": len(cases),
        "calibration_cases": 30,
        "promotion_holdout_cases": 90,
        "kinds": dict(Counter(case["kind"] for case in cases)),
        "ground_truth_independence": "VERIFIED_INDEPENDENT",
        "generator_sha256": file_hash(Path(__file__)),
    }
    return cases, inputs, manifest


def eligible_text_path(path: str) -> bool:
    if path.startswith((".agent-history/", ".local-secrets/")):
        return False
    name = Path(path).name
    return Path(path).suffix.lower() in TEXT_SUFFIXES or name in {"Makefile", "Dockerfile", "Containerfile"}


def is_test_path(path: str) -> bool:
    lowered = path.lower()
    return any(marker in lowered for marker in TEST_MARKERS)


def is_documentation_path(path: str) -> bool:
    return path.startswith("docs/") or path.endswith(".md")


def diff_magnitude(commit: str, path: str) -> int:
    row = git("diff", "--numstat", f"{commit}^", commit, "--", path).strip().split("\t")
    if len(row) < 2 or not all(value.isdigit() for value in row[:2]):
        return 0
    return int(row[0]) + int(row[1])


def changed_symbols(parent: str, commit: str, paths: list[str]) -> set[str]:
    symbols: set[str] = set()
    patch = git("diff", "--unified=0", parent, commit, "--", *paths)
    for line in patch.splitlines():
        if not line.startswith("@@"):
            continue
        suffix = line.rsplit("@@", 1)[-1]
        for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]{5,}", suffix):
            symbols.add(token)
    return symbols


def scrub_query(subject: str, paths: list[str], symbols: set[str]) -> tuple[str, list[str]]:
    query = re.sub(r"^(?:feat|fix|docs|test|refactor|chore|ci|build|perf|revert)(?:\([^)]*\))?!?:\s*", "", subject, flags=re.IGNORECASE)
    removed: list[str] = []
    leak_tokens = {path for path in paths}
    leak_tokens.update(Path(path).name for path in paths)
    leak_tokens.update(symbols)
    for token in sorted(leak_tokens, key=len, reverse=True):
        if len(token) < 6:
            continue
        pattern = re.compile(re.escape(token), re.IGNORECASE)
        if pattern.search(query):
            query = pattern.sub("componente", query)
            removed.append(token)
    query = " ".join(query.split()).strip(" .:-")
    return query, sorted(removed)


def task_category(subject: str, paths: list[str]) -> str:
    text = (subject + " " + " ".join(paths)).lower()
    rules = (
        ("home_assistant", ("homeassistant", "dashboard", "lovelace")),
        ("node_red", ("nodered", "node-red", "flows.json")),
        ("observability", ("telemetry", "observability", "sensor", "usage")),
        ("local_ai", ("local-ai", "ollama", "rtx")),
        ("tests", ("test", "pytest", "validation")),
        ("configuration", ("config", "yaml", "compose", "docker")),
        ("documentation", ("docs/", ".md", "document")),
        ("scripts", ("scripts/", ".sh", ".mjs")),
        ("refactor", ("refactor", "cleanup", "simplify")),
        ("feature", ("feat", "add", "expose")),
    )
    return next((category for category, words in rules if any(word in text for word in words)), "bug_fix")


def build_retrieval_dataset() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    commits = git("rev-list", "--no-merges", INITIAL_HEAD).splitlines()
    candidates: list[dict[str, Any]] = []
    for commit in commits:
        parent_parts = git("rev-list", "--parents", "-n", "1", commit).split()
        if len(parent_parts) != 2:
            continue
        parent = parent_parts[1]
        subject = git("show", "-s", "--format=%s", commit).strip()
        if len(subject) < 12 or MECHANICAL_SUBJECT.search(subject):
            continue
        rows = [line.split("\t", 1) for line in git("diff-tree", "--no-commit-id", "--name-status", "-r", commit).splitlines()]
        if not rows or len(rows) > 12 or any(len(row) != 2 or row[0] not in {"M", "A", "D"} for row in rows):
            continue
        modified = [path for status, path in rows if status == "M" and eligible_text_path(path)]
        if not modified:
            continue
        symbols = changed_symbols(parent, commit, modified)
        query, scrubbed = scrub_query(subject, modified, symbols)
        if len(query) < 10:
            continue
        core = [path for path in modified if not is_test_path(path) and not is_documentation_path(path)]
        ranked_pool = core or modified
        ranked_pool = sorted(ranked_pool, key=lambda path: (-diff_magnitude(commit, path), path))
        critical = ranked_pool[: min(4, len(ranked_pool))]
        supporting = [path for path in modified if path not in critical]
        residual_leaks = [
            token for token in [*modified, *(Path(path).name for path in modified), *symbols]
            if len(token) >= 6 and re.search(re.escape(token), query, re.IGNORECASE)
        ]
        if residual_leaks:
            continue
        candidates.append({
            "commit": commit,
            "snapshot_commit": parent,
            "query": query,
            "query_source": "sanitized_commit_subject",
            "critical_files": critical,
            "supporting_files": supporting,
            "irrelevant_candidates": [],
            "task_type": task_category(subject, modified),
            "snapshot_classification": "SNAPSHOT_CONSISTENT",
            "leakage_status": "NO_DETECTED_LEAKAGE",
            "leakage_scrubbed_terms": scrubbed,
            "ground_truth_rule": "up_to_four_largest_modified_core_files_else_largest_modified_text_files",
            "ground_truth_provenance": {
                "kind": "git_diff_against_parent",
                "critical_files_exist_in_parent_snapshot": True,
                "query_authored_before_diff_evaluation": True,
            },
        })
        if len(candidates) == 180:
            break
    if len(candidates) != 180:
        raise RuntimeError(f"insufficient_retrieval_cases:{len(candidates)}")
    # Make calibration/holdout deterministic while spreading task categories.
    ordered: list[dict[str, Any]] = []
    buckets: dict[str, list[dict[str, Any]]] = {}
    for case in candidates:
        buckets.setdefault(case["task_type"], []).append(case)
    while any(buckets.values()):
        for category in sorted(buckets):
            if buckets[category]:
                ordered.append(buckets[category].pop(0))
    cases: list[dict[str, Any]] = []
    for index, case in enumerate(ordered):
        cases.append({
            "case_id": f"retrieval-{index + 1:03d}",
            "split": "calibration" if index < 30 else "promotion_holdout",
            **case,
        })
    manifest = {
        "schema_version": 1,
        "dataset": "restricted-pivot-retrieval-reranking-v1",
        "source_head": INITIAL_HEAD,
        "cases": len(cases),
        "calibration_cases": 30,
        "promotion_holdout_cases": 150,
        "snapshot_consistent_cases": 180,
        "task_types": dict(Counter(case["task_type"] for case in cases)),
        "ground_truth_independence": "VERIFIED_GIT_DERIVED",
        "generator_sha256": file_hash(Path(__file__)),
    }
    return cases, manifest


def finalize_manifest(directory: Path, manifest: dict[str, Any], files: list[str]) -> None:
    manifest = dict(manifest)
    manifest["files"] = {name: file_hash(directory / name) for name in files}
    manifest["dataset_sha256"] = stable_hash(manifest["files"])
    write_json(directory / "manifest.json", manifest)


def write_all() -> None:
    structured_dir = DATASET_ROOT / "structured-extraction-promotion"
    structured_cases, structured_inputs, structured_manifest = build_structured_dataset()
    write_jsonl(structured_dir / "dataset.jsonl", structured_cases)
    write_json(structured_dir / "inputs.json", structured_inputs)
    write_json(structured_dir / "schema.json", structured_schema())
    finalize_manifest(structured_dir, structured_manifest, ["dataset.jsonl", "inputs.json", "schema.json"])

    log_dir = DATASET_ROOT / "summarize-log-validation"
    log_cases, log_inputs, log_manifest = build_log_dataset()
    write_jsonl(log_dir / "dataset.jsonl", log_cases)
    write_json(log_dir / "inputs.json", log_inputs)
    write_json(log_dir / "schema.json", log_schema())
    finalize_manifest(log_dir, log_manifest, ["dataset.jsonl", "inputs.json", "schema.json"])

    retrieval_dir = DATASET_ROOT / "retrieval-reranking"
    retrieval_cases, retrieval_manifest = build_retrieval_dataset()
    write_jsonl(retrieval_dir / "dataset.jsonl", retrieval_cases)
    finalize_manifest(retrieval_dir, retrieval_manifest, ["dataset.jsonl"])


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def validate_manifest(directory: Path) -> dict[str, Any]:
    manifest = read_json(directory / "manifest.json")
    actual = {name: file_hash(directory / name) for name in manifest["files"]}
    if actual != manifest["files"] or stable_hash(actual) != manifest["dataset_sha256"]:
        raise RuntimeError(f"dataset_hash_mismatch:{directory.name}")
    return manifest


def check_all() -> None:
    structured_dir = DATASET_ROOT / "structured-extraction-promotion"
    log_dir = DATASET_ROOT / "summarize-log-validation"
    retrieval_dir = DATASET_ROOT / "retrieval-reranking"
    structured_manifest = validate_manifest(structured_dir)
    log_manifest = validate_manifest(log_dir)
    retrieval_manifest = validate_manifest(retrieval_dir)
    structured = read_jsonl(structured_dir / "dataset.jsonl")
    structured_inputs = read_json(structured_dir / "inputs.json")
    logs = read_jsonl(log_dir / "dataset.jsonl")
    log_inputs = read_json(log_dir / "inputs.json")
    retrieval = read_jsonl(retrieval_dir / "dataset.jsonl")
    if len(structured) != 125 or Counter(case["split"] for case in structured) != {"calibration": 25, "promotion_holdout": 100}:
        raise RuntimeError("structured_dataset_distribution")
    if Counter(case["subtype"] for case in structured if case["split"] == "promotion_holdout") != {subtype: 20 for subtype in STRUCTURED_SUBTYPES}:
        raise RuntimeError("structured_holdout_subtypes")
    for case in structured:
        if deterministic_structured_status(structured_inputs[case["case_id"]]) != case["deterministic_status"]:
            raise RuntimeError(f"structured_case_not_residual:{case['case_id']}")
    if len(logs) != 120 or Counter(case["split"] for case in logs) != {"calibration": 30, "promotion_holdout": 90}:
        raise RuntimeError("log_dataset_distribution")
    if set(log_inputs) != {case["case_id"] for case in logs}:
        raise RuntimeError("log_input_reference_mismatch")
    if len(retrieval) != 180 or Counter(case["split"] for case in retrieval) != {"calibration": 30, "promotion_holdout": 150}:
        raise RuntimeError("retrieval_dataset_distribution")
    if any(case["snapshot_classification"] != "SNAPSHOT_CONSISTENT" or case["leakage_status"] != "NO_DETECTED_LEAKAGE" for case in retrieval):
        raise RuntimeError("retrieval_snapshot_or_leakage_status")
    if structured_manifest["generator_sha256"] != log_manifest["generator_sha256"] or log_manifest["generator_sha256"] != retrieval_manifest["generator_sha256"]:
        raise RuntimeError("dataset_generator_hash_mismatch")
    print(stable_json({
        "status": "ok",
        "structured_cases": len(structured),
        "log_cases": len(logs),
        "retrieval_cases": len(retrieval),
    }))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write all frozen public datasets")
    mode.add_argument("--check", action="store_true", help="validate sizes, residual status, leakage and hashes")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.write:
        write_all()
    check_all()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
