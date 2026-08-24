#!/usr/bin/env python3
"""Offline Local AI compression benchmark where rejected outputs save zero tokens."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "local-ai.py"


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
    return [
        {"task": "review-diff", "source": review, "required": [
            "src/auth.ts", "src/cache.ts", "request.user.id", "ttlSeconds", "* 1000",
        ]},
        {"task": "analyze-tests", "source": tests, "required": [
            "tests/auth.test.ts::rejects_cross_user_role_change", "403", "200",
            "tests/cache.test.ts::uses_ttl_in_milliseconds", "30000", "30", ("WARN", "warning"),
        ]},
        {"task": "inspect-files", "source": inventory, "required": [
            "src/auth.ts", "src/cache.ts", "tests/auth.test.ts", "config/permissions.txt",
        ]},
        {"task": "summarize-log", "source": log, "required": [
            "TypeError", "src/auth.ts:18:42", ("WARN", "warning"), "CACHE_WRITE_TIMEOUT", "30000", "request_id", "500",
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
    digest.update(HELPER.read_bytes())
    return digest.hexdigest()


def run_case(model: str, verifier_model: str, case: dict[str, Any], repetition: int) -> dict[str, Any]:
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
    control_tokens = max(0, int(job.get("context_input_tokens") or control_tokens))
    candidate_tokens = max(0, int(job.get("context_output_tokens") or (estimated_tokens(output) if output else 0)))
    missing = missing_requirements(output, case["required"])
    quality_accepted = job.get("quality_accepted") is True and not missing
    raw_saved = max(0, int(job.get("gross_useful_context_tokens_avoided") or 0))
    validation_tokens = max(0, int(job.get("quality_validation_tokens") or 0))
    useful_saved = max(0, int(job.get("useful_context_tokens_avoided") or 0))
    validation_measured = job.get("quality_validation_tokens_measured") is True
    efficient = quality_accepted and validation_measured and useful_saved >= 600
    return {
        "task": case["task"],
        "repetition": repetition,
        "quality_accepted": quality_accepted,
        "efficient": efficient,
        "control_tokens": control_tokens,
        "candidate_tokens": candidate_tokens,
        "effective_tokens_sent_to_primary": candidate_tokens if efficient else control_tokens,
        "gross_useful_tokens_avoided": raw_saved if quality_accepted else 0,
        "quality_validation_tokens": validation_tokens,
        "quality_validation_tokens_measured": validation_measured,
        "local_input_tokens": max(0, int(job.get("local_input_tokens") or 0)),
        "local_output_tokens": max(0, int(job.get("local_output_tokens") or 0)),
        "useful_tokens_avoided": useful_saved if efficient else 0,
        "latency_seconds": round(time.monotonic() - started, 3),
        "rejection_reason": None if efficient else (
            "fixture_facts_omitted" if missing else
            "quality_gate_rejected" if not quality_accepted else
            "validation_cost_unmeasured" if not validation_measured else
            "insufficient_token_reduction"
        ),
        "missing_fact_count": len(missing),
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
) -> dict[str, Any]:
    control = sum(int(item["control_tokens"]) for item in results)
    effective = sum(int(item["effective_tokens_sent_to_primary"]) for item in results)
    useful = sum(int(item["useful_tokens_avoided"]) for item in results)
    gross_useful = sum(int(item["gross_useful_tokens_avoided"]) for item in results)
    validation_tokens = sum(int(item["quality_validation_tokens"]) for item in results)
    local_input_tokens = sum(int(item.get("local_input_tokens") or 0) for item in results)
    local_output_tokens = sum(int(item.get("local_output_tokens") or 0) for item in results)
    validated_validation_tokens = sum(
        int(item["quality_validation_tokens"])
        for item in results
        if item["quality_accepted"] is True
    )
    reductions = [
        (int(item["useful_tokens_avoided"]) / int(item["control_tokens"]) * 100)
        if int(item["control_tokens"]) > 0 else 0
        for item in results
    ]
    per_task: dict[str, dict[str, Any]] = {}
    for task in sorted({str(item["task"]) for item in results}):
        task_results = [item for item in results if item["task"] == task]
        task_control = sum(int(item["control_tokens"]) for item in task_results)
        task_useful = sum(int(item["useful_tokens_avoided"]) for item in task_results)
        task_reductions = [
            (int(item["useful_tokens_avoided"]) / int(item["control_tokens"]) * 100)
            if int(item["control_tokens"]) > 0 else 0
            for item in task_results
        ]
        per_task[task] = {
            "observations": len(task_results),
            "quality_accepted_observations": sum(item["quality_accepted"] is True for item in task_results),
            "efficient_observations": sum(item["efficient"] is True for item in task_results),
            "control_tokens": task_control,
            "useful_tokens_avoided": task_useful,
            "token_weighted_useful_reduction_percent": round(task_useful / task_control * 100, 1) if task_control else 0,
            "median_useful_reduction_percent": round(statistics.median(task_reductions), 1) if task_reductions else 0,
        }
    methods = sorted({str(item["token_count_method"]) for item in results})
    accepted = sum(item["quality_accepted"] is True for item in results)
    efficient = sum(item["efficient"] is True for item in results)
    return {
        "suite": "local-ai-quality-benchmark-v3",
        "benchmark_kind": "offline_context_compression_with_fidelity_gate",
        "end_to_end_primary_model_evaluated": False,
        "generator_model": model,
        "verifier_model": verifier_model,
        "independent_verifier": verifier_model != model,
        "fixture_suite_sha256": fixture_hash,
        "prompt_bundle_sha256": prompt_hash,
        "token_count_methods": methods,
        "fixture_cases": len(results) // repetitions if repetitions else 0,
        "repetitions": repetitions,
        "observations": len(results),
        "quality_accepted_observations": accepted,
        "efficient_observations": efficient,
        "quality_acceptance_rate_percent": round(accepted / len(results) * 100, 1) if results else 0,
        "efficiency_rate_percent": round(efficient / len(results) * 100, 1) if results else 0,
        "control_tokens": control,
        "effective_tokens_sent_to_primary": effective,
        "gross_useful_tokens_avoided": gross_useful,
        "quality_validation_tokens_total": validation_tokens,
        "local_input_tokens_total": local_input_tokens,
        "local_output_tokens_total": local_output_tokens,
        "quality_validated_validation_tokens": validated_validation_tokens,
        "useful_tokens_avoided": useful,
        "token_weighted_useful_reduction_percent": round(useful / control * 100, 1) if control else 0,
        "median_useful_reduction_percent": round(statistics.median(reductions), 1) if reductions else 0,
        # Compatibility with the v2 report consumer; this is the token-weighted metric.
        "useful_reduction_percent": round(useful / control * 100, 1) if control else 0,
        "latency_seconds": round(sum(float(item["latency_seconds"]) for item in results), 3),
        "per_task": per_task,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--verifier-model", help="independent installed verifier model; defaults to --model")
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")
    verifier_model = args.verifier_model or args.model
    test_cases = cases()
    results = [
        run_case(args.model, verifier_model, case, repetition)
        for repetition in range(1, args.repetitions + 1)
        for case in test_cases
    ]
    report = summarize_results(
        results,
        model=args.model,
        verifier_model=verifier_model,
        repetitions=args.repetitions,
        fixture_hash=sha256_json(test_cases),
        prompt_hash=prompt_bundle_sha256(test_cases),
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
