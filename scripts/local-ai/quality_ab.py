#!/usr/bin/env python3
"""Offline Local AI compression benchmark where rejected outputs save zero tokens."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "local-ai.py"
ROUTING = ROOT / "routing.py"
HARNESS = Path(__file__)
TASK_MINIMUM_NET = {
    "review-diff": 700,
    "analyze-tests": 600,
    "inspect-files": 700,
    "summarize-log": 600,
}


def estimated_tokens(text: str) -> int:
    return math.ceil(len(text.encode("utf-8")) / 4)


def missing_requirements(output: str, requirements: list[Any]) -> list[str]:
    missing: list[str] = []
    for requirement in requirements:
        alternatives = list(requirement) if isinstance(requirement, (list, tuple)) else [str(requirement)]
        if not any(value in output for value in alternatives):
            missing.append("|".join(alternatives))
    return missing


def cases() -> list[dict[str, Any]]:
    review_noise = "\n".join(
        "\n".join([
            f"diff --git a/docs/label-{index}.md b/docs/label-{index}.md",
            f"--- a/docs/label-{index}.md",
            f"+++ b/docs/label-{index}.md",
            "@@ -1 +1 @@",
            f"-label {index}",
            f"+label {index} updated",
        ])
        for index in range(1, 34)
    )
    review = "\n".join([
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -20,3 +20,2 @@ export async function updateUser(request: Request) {",
        "-  if (user.id !== request.user.id) return forbidden();",
        "   return users.update(user.id, await request.json());",
        "diff --git a/src/cache.ts b/src/cache.ts",
        "--- a/src/cache.ts",
        "+++ b/src/cache.ts",
        "@@ -8 +8 @@ export function cacheFor(ttlSeconds: number) {",
        "-  return cache.setTtl(ttlSeconds);",
        "+  return cache.setTtl(ttlSeconds * 1000);",
        "}",
        review_noise,
    ])
    test_noise = "\n".join(f"PASS tests/unit/test_generated_{index}.py" for index in range(1, 141))
    tests = "\n".join([
        "FAIL tests/auth.test.ts::rejects_cross_user_role_change",
        "AssertionError: expected status 403, received 200",
        "  at tests/auth.test.ts:88:21",
        "FAIL tests/cache.test.ts::uses_ttl_in_milliseconds",
        "AssertionError: expected 30000, received 30",
        "  at tests/cache.test.ts:41:9",
        "WARN integration database retry used once",
        "2 failed, 140 passed",
        test_noise,
    ])
    inspect_noise = "\n".join(f"export const generated_{index} = {index};" for index in range(1, 181))
    inventory = "\n".join([
        "src/auth.ts",
        "export async function updateUser(request) { return users.update(request.params.id, await request.json()); }",
        "src/cache.ts",
        "export function cacheFor(ttlSeconds) { return cache.setTtl(ttlSeconds * 1000); }",
        "tests/auth.test.ts",
        "it('rejects cross-user changes', async () => expect(await updateUser(otherUser)).toHaveStatus(403));",
        "config/permissions.txt",
        "role changes require owner_id == requester_id",
        "src/generated.ts",
        inspect_noise,
    ])
    log_noise = "\n".join(
        f"1999-01-01T12:{index // 60:02d}:{index % 60:02d}Z api INFO request={index} status=200"
        for index in range(180)
    )
    log = "\n".join([
        log_noise,
        "1999-01-01T13:00:01Z api ERROR TypeError: Cannot read properties of undefined (reading 'id')",
        "    at updateUser (src/auth.ts:18:42)",
        "1999-01-01T13:00:02Z api WARN retrying database write once",
        "1999-01-01T13:00:03Z cache TIMEOUT CACHE_WRITE_TIMEOUT after 30000ms key=session",
        "1999-01-01T13:00:04Z api ERROR request_id=abc123 status=500",
    ])
    holdout_review_noise = "\n".join(
        f"+export const unchanged_label_{index} = '{index}';" for index in range(1, 130)
    )
    holdout_review = "\n".join([
        "diff --git a/src/permissions.ts b/src/permissions.ts",
        "--- a/src/permissions.ts",
        "+++ b/src/permissions.ts",
        "@@ -10,4 +10,3 @@ export function changeRole(actor, target) {",
        "-  if (actor.owner_id !== target.owner_id) return forbidden();",
        "   return roles.update(target.id, actor.requested_role);",
        "diff --git a/src/worker.ts b/src/worker.ts",
        "--- a/src/worker.ts",
        "+++ b/src/worker.ts",
        "@@ -4 +4 @@ export function retryDelay(timeoutMs) {",
        "-  return timeoutMs;",
        "+  return timeoutMs / 1000;",
        holdout_review_noise,
    ])
    holdout_test_noise = "\n".join(f"PASS tests/generated_{index}.test.ts" for index in range(1, 170))
    holdout_tests = "\n".join([
        "FAIL tests/permissions.test.ts::blocks_cross_owner_role_change",
        "AssertionError: expected forbidden status 403, received 200",
        "  at tests/permissions.test.ts:51:7",
        "FAIL tests/worker.test.ts::keeps_retry_delay_in_milliseconds",
        "AssertionError: expected 45000, received 45",
        "  at tests/worker.test.ts:29:11",
        "WARN queue retry budget exhausted once",
        "2 failed, 169 passed",
        holdout_test_noise,
    ])
    holdout_inventory_noise = "\n".join(
        f"export const generated_permission_{index} = {index};" for index in range(1, 210)
    )
    holdout_inventory = "\n".join([
        "src/permissions.ts",
        "export function changeRole(actor, target) { return roles.update(target.id, actor.requested_role); }",
        "src/worker.ts",
        "export function retryDelay(timeoutMs) { return timeoutMs / 1000; }",
        "tests/permissions.test.ts",
        "it('blocks cross-owner role changes', async () => expect(result.status).toBe(403));",
        "config/role-policy.txt",
        "role changes require actor.owner_id == target.owner_id",
        "src/generated-permissions.ts",
        holdout_inventory_noise,
    ])
    holdout_log_noise = "\n".join(
        f"1999-02-02T11:{index // 60:02d}:{index % 60:02d}Z worker INFO job={index} status=ok"
        for index in range(240)
    )
    holdout_log = "\n".join([
        holdout_log_noise,
        "1999-02-02T12:00:01Z worker ERROR PermissionError: owner_id mismatch",
        "    at changeRole (src/permissions.ts:11:17)",
        "1999-02-02T12:00:02Z worker WARN retry budget exhausted",
        "1999-02-02T12:00:03Z queue TIMEOUT ROLE_UPDATE_TIMEOUT after 45000ms job=role-7",
        "1999-02-02T12:00:04Z worker FATAL request_id=holdout42 status=500",
    ])
    return [
        {"id": "dev-review-diff", "split": "development", "task": "review-diff", "source": review, "required": [
            "src/auth.ts", "src/cache.ts", "request.user.id", "ttlSeconds", "* 1000",
        ]},
        {"id": "dev-analyze-tests", "split": "development", "task": "analyze-tests", "source": tests, "required": [
            "tests/auth.test.ts::rejects_cross_user_role_change", "403", "200",
            "tests/cache.test.ts::uses_ttl_in_milliseconds", "30000", "30", ("WARN", "warning"),
        ]},
        {"id": "dev-inspect-files", "split": "development", "task": "inspect-files", "source": inventory, "required": [
            "src/auth.ts", "src/cache.ts", "tests/auth.test.ts", "config/permissions.txt",
        ]},
        {"id": "dev-summarize-log", "split": "development", "task": "summarize-log", "source": log, "required": [
            "TypeError", "src/auth.ts:18:42", ("WARN", "warning"), "CACHE_WRITE_TIMEOUT", "30000", "request_id", "500",
        ]},
        {"id": "holdout-review-diff", "split": "holdout", "task": "review-diff", "source": holdout_review, "required": [
            "src/permissions.ts", "src/worker.ts", "owner_id", "timeoutMs", "/ 1000",
        ]},
        {"id": "holdout-analyze-tests", "split": "holdout", "task": "analyze-tests", "source": holdout_tests, "required": [
            "tests/permissions.test.ts::blocks_cross_owner_role_change", "403", "200",
            "tests/worker.test.ts::keeps_retry_delay_in_milliseconds", "45000", "45", ("WARN", "warning"),
        ]},
        {"id": "holdout-inspect-files", "split": "holdout", "task": "inspect-files", "source": holdout_inventory, "required": [
            "src/permissions.ts", "src/worker.ts", "tests/permissions.test.ts", "config/role-policy.txt",
        ]},
        {"id": "holdout-summarize-log", "split": "holdout", "task": "summarize-log", "source": holdout_log, "required": [
            "PermissionError", "src/permissions.ts:11:17", ("WARN", "warning"),
            "ROLE_UPDATE_TIMEOUT", "45000", "request_id", "500",
        ]},
    ]


def sha256_json(value: Any) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def prompt_bundle_sha256(test_cases: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for task in sorted({str(case["task"]) for case in test_cases}):
        path = ROOT / "prompts" / f"{task}.md"
        digest.update(task.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def input_size_band(tokens: int) -> str:
    if tokens < 1200:
        return "lt_1200"
    if tokens < 3000:
        return "1200_2999"
    if tokens < 6000:
        return "3000_5999"
    return "gte_6000"


def wilson_interval(successes: int, observations: int, z: float = 1.96) -> list[float] | None:
    if observations <= 0:
        return None
    proportion = successes / observations
    denominator = 1 + z * z / observations
    center = (proportion + z * z / (2 * observations)) / denominator
    margin = z * math.sqrt(
        proportion * (1 - proportion) / observations + z * z / (4 * observations * observations)
    ) / denominator
    return [round(max(0, center - margin) * 100, 1), round(min(1, center + margin) * 100, 1)]


def run_case(
    model: str,
    verifier_model: str,
    case: dict[str, Any],
    repetition: int,
    order_index: int,
) -> dict[str, Any]:
    source = str(case["source"])
    control_tokens = estimated_tokens(source)
    environment = dict(os.environ)
    environment["LOCAL_AI_TELEMETRY_ENABLED"] = "1"
    environment["LOCAL_AI_FORCE"] = "1"
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="local-ai-quality-ab-") as directory:
        telemetry_path = Path(directory) / "telemetry.json"
        environment["LOCAL_AI_TELEMETRY_PATH"] = str(telemetry_path)
        completed = subprocess.run(
            [
                sys.executable, str(HELPER), str(case["task"]),
                "--model", model, "--verifier-model", verifier_model,
                "--context-tokens", "8192",
                "--input-max-chars", "50000", "--output-tokens", "1200",
                "--diagnostic-capture",
            ],
            input=source,
            text=True,
            capture_output=True,
            cwd=ROOT,
            env=environment,
            timeout=600,
            check=False,
        )
        try:
            state = json.loads(telemetry_path.read_text(encoding="utf-8"))
            job = (state.get("latest_jobs") or [])[-1]
        except (OSError, json.JSONDecodeError, IndexError, TypeError):
            job = {}
    output = completed.stdout.strip()
    captured: dict[str, Any] = {}
    try:
        decoded = json.loads(output) if output else {}
        captured = decoded if isinstance(decoded, dict) else {}
    except json.JSONDecodeError:
        captured = {}
    candidate = captured.get("candidate") if "candidate" in captured else captured
    candidate = candidate if isinstance(candidate, dict) else {}
    gate_report = captured.get("gate_report") if isinstance(captured.get("gate_report"), dict) else {}
    candidate_json = json.dumps(candidate, ensure_ascii=False, sort_keys=True, separators=(",", ":")) if candidate else ""
    control_tokens = max(0, int(job.get("context_input_tokens") or control_tokens))
    candidate_tokens = max(0, int(job.get("context_output_tokens") or (estimated_tokens(candidate_json) if candidate_json else 0)))
    missing = missing_requirements(candidate_json, case["required"])
    gate_accepted = job.get("quality_accepted") is True
    oracle_accepted = bool(candidate) and not missing
    quality_accepted = gate_accepted and oracle_accepted
    raw_saved = max(0, control_tokens - candidate_tokens)
    validation_tokens = max(0, int(job.get("quality_validation_tokens") or 0))
    validation_measured = job.get("quality_validation_tokens_measured") is True
    net_candidate = max(0, raw_saved - validation_tokens) if validation_measured else 0
    minimum_net = TASK_MINIMUM_NET[str(case["task"])]
    efficient = quality_accepted and validation_measured and net_candidate >= minimum_net
    useful_saved = net_candidate if efficient else 0
    technical_failure = job.get("status") == "failed"
    return {
        "fixture_id": case["id"],
        "fixture_split": case["split"],
        "fixture_sha256": sha256_json({"source": source, "required": case["required"]}),
        "task": case["task"],
        "repetition": repetition,
        "order_index": order_index,
        "input_chars": len(source),
        "input_size_band": input_size_band(control_tokens),
        "gate_accepted": gate_accepted,
        "oracle_accepted": oracle_accepted,
        "quality_accepted": quality_accepted,
        "false_accept": gate_accepted and not oracle_accepted,
        "false_reject": not gate_accepted and oracle_accepted,
        "efficient": efficient,
        "selected_for_primary_model_treatment": efficient,
        "primary_model_use_confirmed": False,
        "control_tokens": control_tokens,
        "candidate_tokens": candidate_tokens,
        "effective_tokens_sent_to_primary": candidate_tokens if efficient else control_tokens,
        "gross_useful_tokens_avoided": raw_saved if quality_accepted else 0,
        "quality_validation_tokens": validation_tokens,
        "quality_validation_tokens_measured": validation_measured,
        "local_input_tokens": max(0, int(job.get("local_input_tokens") or 0)),
        "local_output_tokens": max(0, int(job.get("local_output_tokens") or 0)),
        "useful_tokens_avoided": useful_saved,
        "confirmed_end_to_end_useful_tokens_avoided": 0,
        "latency_seconds": round(time.monotonic() - started, 3),
        "technical_failure": technical_failure,
        "fallback_to_original_context": not efficient,
        "original_context_recovered_after_candidate": False,
        "rejection_reason": None if efficient else (
            "technical_failure" if technical_failure else
            "fixture_facts_omitted" if missing else
            "quality_gate_false_reject" if not gate_accepted and oracle_accepted else
            "quality_gate_rejected" if not gate_accepted else
            "validation_cost_unmeasured" if not validation_measured else
            "insufficient_token_reduction"
        ),
        "missing_fact_count": len(missing),
        "missing_requirements": missing,
        "candidate_sha256": hashlib.sha256(candidate_json.encode("utf-8")).hexdigest() if candidate_json else None,
        "gate_report": gate_report,
        "token_count_method": job.get("token_count_method") or "estimated_utf8_bytes_div_4",
        "generator_model": job.get("model") or model,
        "verifier_model": job.get("verifier_model") or verifier_model,
        "error_type": job.get("error_type"),
        "quality_score_percent": job.get("quality_score_percent"),
        "generation_attempts": job.get("local_attempts"),
        "verification_attempts": job.get("quality_verification_attempts"),
    }


def summarize_results(
    results: list[dict[str, Any]],
    *,
    model: str,
    verifier_model: str,
    repetitions: int,
    fixture_hash: str,
    prompt_hash: str,
    condition_label: str = "candidate",
    order_seed: int = 0,
    execution_order: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def aggregate(items: list[dict[str, Any]]) -> dict[str, Any]:
        control = sum(int(item["control_tokens"]) for item in items)
        useful = sum(int(item["useful_tokens_avoided"]) for item in items)
        reductions = [
            (int(item["useful_tokens_avoided"]) / int(item["control_tokens"]) * 100)
            if int(item["control_tokens"]) > 0 else 0
            for item in items
        ]
        gains = sorted(int(item["useful_tokens_avoided"]) for item in items)

        def percentile(values: list[int], fraction: float) -> float:
            if not values:
                return 0
            position = (len(values) - 1) * fraction
            lower = math.floor(position)
            upper = math.ceil(position)
            if lower == upper:
                return float(values[lower])
            return values[lower] + (values[upper] - values[lower]) * (position - lower)

        gate_evaluated = [
            item for item in items
            if int(item.get("verification_attempts") or 0) > 0 or item.get("gate_report")
        ]
        measured = sum(item["quality_validation_tokens_measured"] is True for item in gate_evaluated)
        return {
            "observations": len(items),
            "gate_evaluated_observations": len(gate_evaluated),
            "gate_accepted_observations": sum(
                item.get("gate_accepted", item.get("quality_accepted")) is True for item in items
            ),
            "oracle_accepted_observations": sum(
                item.get("oracle_accepted", item.get("quality_accepted")) is True for item in items
            ),
            "quality_accepted_observations": sum(item["quality_accepted"] is True for item in items),
            "efficient_observations": sum(item["efficient"] is True for item in items),
            "false_accepts": sum(item.get("false_accept") is True for item in items),
            "false_rejects": sum(item.get("false_reject") is True for item in items),
            "technical_failures": sum(item.get("technical_failure") is True for item in items),
            "fallbacks": sum(
                item.get("fallback_to_original_context", not item.get("efficient")) is True for item in items
            ),
            "control_tokens": control,
            "effective_tokens_sent_to_primary": sum(int(item["effective_tokens_sent_to_primary"]) for item in items),
            "gross_useful_tokens_avoided": sum(int(item["gross_useful_tokens_avoided"]) for item in items),
            "quality_validation_tokens_total": sum(int(item["quality_validation_tokens"]) for item in items),
            "local_input_tokens_total": sum(int(item.get("local_input_tokens") or 0) for item in items),
            "local_output_tokens_total": sum(int(item.get("local_output_tokens") or 0) for item in items),
            "useful_tokens_avoided": useful,
            "confirmed_end_to_end_useful_tokens_avoided": 0,
            "token_weighted_useful_reduction_percent": round(useful / control * 100, 1) if control else 0,
            "median_useful_reduction_percent": round(statistics.median(reductions), 1) if reductions else 0,
            "gate_acceptance_rate_percent": round(
                sum(item.get("gate_accepted", item.get("quality_accepted")) is True for item in items)
                / len(items) * 100,
                1,
            ) if items else 0,
            "candidate_selection_rate_percent": round(
                sum(item["efficient"] is True for item in items) / len(items) * 100, 1,
            ) if items else 0,
            "quality_validation_cost_coverage_percent": round(measured / len(gate_evaluated) * 100, 1)
            if gate_evaluated else None,
            "net_gain_tokens_distribution": {
                "zero_observations": sum(value == 0 for value in gains),
                "minimum": gains[0] if gains else 0,
                "p25": round(percentile(gains, 0.25), 1),
                "median": round(percentile(gains, 0.5), 1),
                "p75": round(percentile(gains, 0.75), 1),
                "maximum": gains[-1] if gains else 0,
            },
        }

    totals = aggregate(results)
    per_task = {
        task: aggregate([item for item in results if item["task"] == task])
        for task in sorted({str(item["task"]) for item in results})
    }
    per_split = {
        split: aggregate([item for item in results if item.get("fixture_split", "unspecified") == split])
        for split in sorted({str(item.get("fixture_split", "unspecified")) for item in results})
    }
    per_input_size_band = {
        band: aggregate([item for item in results if item.get("input_size_band", "unspecified") == band])
        for band in sorted({str(item.get("input_size_band", "unspecified")) for item in results})
    }

    # Cluster bootstrap by fixture so repetitions of the same source are not
    # incorrectly treated as independent evidence.
    fixture_ids = sorted({
        str(item.get("fixture_id") or f"{item.get('task')}:{item.get('repetition')}") for item in results
    })
    clusters = {
        fixture_id: [
            item for item in results
            if str(item.get("fixture_id") or f"{item.get('task')}:{item.get('repetition')}") == fixture_id
        ]
        for fixture_id in fixture_ids
    }
    bootstrap_values: list[float] = []
    rng = random.Random(order_seed)
    if fixture_ids:
        for _ in range(2000):
            sample = [item for _fixture in fixture_ids for item in clusters[rng.choice(fixture_ids)]]
            sample_control = sum(int(item["control_tokens"]) for item in sample)
            sample_useful = sum(int(item["useful_tokens_avoided"]) for item in sample)
            bootstrap_values.append(sample_useful / sample_control * 100 if sample_control else 0)
        bootstrap_values.sort()
    bootstrap_interval = (
        [round(bootstrap_values[49], 1), round(bootstrap_values[1949], 1)]
        if len(bootstrap_values) == 2000 else None
    )
    methods = sorted({str(item["token_count_method"]) for item in results})
    accepted = sum(item["quality_accepted"] is True for item in results)
    efficient = sum(item["efficient"] is True for item in results)
    return {
        "suite": "local-ai-quality-benchmark-v4",
        "benchmark_kind": "offline_context_compression_with_fidelity_gate",
        "end_to_end_primary_model_evaluated": False,
        "operational_savings_proven": False,
        "condition_label": condition_label,
        "generator_model": model,
        "verifier_model": verifier_model,
        "independent_verifier": verifier_model != model,
        "fixture_suite_sha256": fixture_hash,
        "prompt_bundle_sha256": prompt_hash,
        "helper_sha256": file_sha256(HELPER),
        "harness_sha256": file_sha256(HARNESS),
        "routing_sha256": file_sha256(ROUTING),
        "parameters": {
            "context_tokens": 8192,
            "input_max_chars": 50000,
            "output_tokens": 1200,
            "temperature": 0,
            "order_seed": order_seed,
        },
        "execution_order": execution_order or [],
        "token_count_methods": methods,
        "fixture_cases": len(results) // repetitions if repetitions else 0,
        "repetitions": repetitions,
        "observations": len(results),
        "quality_accepted_observations": accepted,
        "efficient_observations": efficient,
        "quality_acceptance_rate_percent": round(accepted / len(results) * 100, 1) if results else 0,
        "efficiency_rate_percent": round(efficient / len(results) * 100, 1) if results else 0,
        **totals,
        "quality_validated_validation_tokens": sum(
            int(item["quality_validation_tokens"])
            for item in results if item["quality_accepted"] is True
        ),
        # Compatibility with the v2 report consumer; this is the token-weighted metric.
        "useful_reduction_percent": totals["token_weighted_useful_reduction_percent"],
        "confirmed_end_to_end_useful_reduction_percent": 0,
        "latency_seconds": round(sum(float(item["latency_seconds"]) for item in results), 3),
        "uncertainty": {
            "method": "fixture_cluster_bootstrap_2000_and_wilson_95",
            "token_weighted_useful_reduction_percent_95_interval": bootstrap_interval,
            "candidate_selection_rate_percent_95_interval": wilson_interval(efficient, len(results)),
        },
        "per_task": per_task,
        "per_split": per_split,
        "per_input_size_band": per_input_size_band,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--verifier-model", help="independent installed verifier model; defaults to --model")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument(
        "--split",
        action="append",
        choices=("development", "holdout"),
        help="fixture split to execute; repeat for both (default: both)",
    )
    parser.add_argument("--condition-label", default="candidate")
    parser.add_argument("--order-seed", type=int, default=20260824)
    parser.add_argument(
        "--output",
        type=Path,
        help="write the full metadata-only benchmark report to a private JSON file",
    )
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")
    verifier_model = args.verifier_model or args.model
    splits = set(args.split or ("development", "holdout"))
    test_cases = [case for case in cases() if case["split"] in splits]
    results: list[dict[str, Any]] = []
    execution_order: list[dict[str, Any]] = []
    order_index = 0
    for repetition in range(1, args.repetitions + 1):
        ordered = list(test_cases)
        random.Random(args.order_seed + repetition).shuffle(ordered)
        if repetition % 2 == 0:
            ordered.reverse()
        for case in ordered:
            order_index += 1
            execution_order.append({
                "order_index": order_index,
                "repetition": repetition,
                "fixture_id": case["id"],
            })
            results.append(run_case(
                args.model,
                verifier_model,
                case,
                repetition,
                order_index,
            ))
    report = summarize_results(
        results,
        model=args.model,
        verifier_model=verifier_model,
        repetitions=args.repetitions,
        fixture_hash=sha256_json(test_cases),
        prompt_hash=prompt_bundle_sha256(test_cases),
        condition_label=args.condition_label,
        order_seed=args.order_seed,
        execution_order=execution_order,
    )
    if args.output is not None:
        args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args.output.chmod(0o660)
        printed = {key: value for key, value in report.items() if key != "results"}
        printed["results_file"] = str(args.output)
    else:
        printed = report
    print(json.dumps(printed, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
