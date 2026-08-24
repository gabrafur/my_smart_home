#!/usr/bin/env python3
"""Calibrate independent Local AI fidelity verifiers against deterministic labels."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import random
import statistics
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "local-ai.py"
SPEC = importlib.util.spec_from_file_location("local_ai_calibration", HELPER)
assert SPEC and SPEC.loader
LOCAL_AI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCAL_AI)


def calibration_cases() -> list[dict[str, Any]]:
    return [
        {
            "id": "review-diff-guard-direction",
            "task": "review-diff",
            "source": "\n".join([
                "diff --git a/src/auth.ts b/src/auth.ts",
                "--- a/src/auth.ts",
                "+++ b/src/auth.ts",
                "@@ -20,2 +20 @@ export async function updateUser(request) {",
                "-  if (user.id !== request.user.id) return forbidden();",
                "   return users.update(user.id, await request.json());",
                "diff --git a/src/cache.ts b/src/cache.ts",
                "+  return cache.setTtl(ttlSeconds * 1000);",
            ]),
            "positive": {
                "summary": "src/auth.ts removes the request.user.id ownership guard; src/cache.ts changes ttlSeconds with * 1000.",
                "findings": [
                    {"file": "src/auth.ts", "severity": "high", "reason": "request.user.id guard was removed"},
                    {"file": "src/cache.ts", "severity": "medium", "reason": "ttlSeconds is multiplied by * 1000"},
                ],
                "suspected_files": ["src/auth.ts", "src/cache.ts"],
                "risks": ["cross-user update", "TTL unit change"],
                "recommended_actions": ["restore the guard and test the TTL unit"],
                "confidence": "high",
            },
            "negative_remove": "request.user.id",
        },
        {
            "id": "analyze-tests-exact-values",
            "task": "analyze-tests",
            "source": "\n".join([
                "FAIL tests/auth.test.ts::rejects_cross_user_role_change",
                "AssertionError: expected status 403, received 200",
                "FAIL tests/cache.test.ts::uses_ttl_in_milliseconds",
                "AssertionError: expected 30000, received 30",
                "WARN integration database retry used once",
            ]),
            "positive": {
                "summary": "Two failures and one WARN.",
                "failures": [
                    {"test": "tests/auth.test.ts::rejects_cross_user_role_change", "error": "expected 403, received 200", "likely_cause": "authorization regression"},
                    {"test": "tests/cache.test.ts::uses_ttl_in_milliseconds", "error": "expected 30000, received 30", "likely_cause": "TTL unit mismatch"},
                ],
                "warnings": ["WARN integration database retry used once"],
                "recommended_actions": ["inspect the two failing paths"],
                "confidence": "high",
            },
            "negative_remove": "30000",
        },
        {
            "id": "inspect-files-complete-inventory",
            "task": "inspect-files",
            "source": "\n".join([
                "src/auth.ts", "export function updateUser() {}",
                "src/cache.ts", "export function cacheFor() {}",
                "tests/auth.test.ts", "it('rejects cross-user changes', () => {})",
                "config/permissions.txt", "owner check required",
            ]),
            "positive": {
                "summary": "Four relevant files.",
                "files": [
                    {"path": "src/auth.ts", "role": "authorization", "relevant_items": ["updateUser"]},
                    {"path": "src/cache.ts", "role": "cache", "relevant_items": ["cacheFor"]},
                    {"path": "tests/auth.test.ts", "role": "test", "relevant_items": ["cross-user"]},
                    {"path": "config/permissions.txt", "role": "policy", "relevant_items": ["owner check"]},
                ],
                "suspected_files": ["src/auth.ts"],
                "recommended_actions": ["review authorization"],
                "confidence": "high",
            },
            "negative_remove": "config/permissions.txt",
        },
        {
            "id": "summarize-log-distinct-signals",
            "task": "summarize-log",
            "source": "\n".join([
                "api ERROR TypeError at src/auth.ts:18:42",
                "api WARN retrying database write once",
                "cache TIMEOUT CACHE_WRITE_TIMEOUT after 30000ms",
                "api ERROR request_id=abc123 status=500",
            ]),
            "positive": {
                "summary": "ERROR TypeError, WARN, TIMEOUT CACHE_WRITE_TIMEOUT and request_id status 500 are present.",
                "errors": [
                    "TypeError at src/auth.ts:18:42",
                    "WARN retrying database write once",
                    "CACHE_WRITE_TIMEOUT after 30000ms",
                    "request_id=abc123 status=500",
                ],
                "suspected_files": ["src/auth.ts"],
                "recommended_actions": ["inspect the failing request and cache timeout"],
                "confidence": "high",
            },
            "negative_remove": "CACHE_WRITE_TIMEOUT",
        },
    ]


def replace_nested(value: Any, old: str, new: str) -> Any:
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [replace_nested(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: replace_nested(item, old, new) for key, item in value.items()}
    return value


def response_usage(response: dict[str, Any] | None) -> tuple[int, bool]:
    if not isinstance(response, dict):
        return 0, False
    input_tokens, output_tokens, measured = LOCAL_AI.response_token_usage([response])
    return input_tokens + output_tokens, measured


def run_observation(
    *,
    endpoint: str,
    verifier_model: str,
    case: dict[str, Any],
    expected_usable: bool,
    candidate: dict[str, Any],
    repetition: int,
    order_index: int,
) -> dict[str, Any]:
    started = time.monotonic()
    accepted = False
    report: dict[str, Any] = {}
    response: dict[str, Any] | None = None
    try:
        report, response = LOCAL_AI.verify_candidate_quality(
            str(case["task"]),
            str(case["source"]),
            candidate,
            endpoint=endpoint,
            model=verifier_model,
            request_call=LOCAL_AI.request,
            minimum_score=90,
            context_tokens=8192,
        )
        accepted = True
    except LOCAL_AI.QualityRejected as error:
        report = error.report
        response = error.response
    tokens, measured = response_usage(response)
    return {
        "fixture_id": case["id"],
        "task": case["task"],
        "verifier_model": verifier_model,
        "variant": "known_positive" if expected_usable else "known_negative",
        "expected_usable": expected_usable,
        "gate_accepted": accepted,
        "false_accept": accepted and not expected_usable,
        "false_reject": not accepted and expected_usable,
        "quality_score_percent": report.get("coverage_score"),
        "gate_report": report,
        "quality_validation_tokens": tokens,
        "quality_validation_tokens_measured": measured,
        "latency_seconds": round(time.monotonic() - started, 3),
        "repetition": repetition,
        "order_index": order_index,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verifier-model", action="append", required=True)
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--order-seed", type=int, default=20260824)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    settings = LOCAL_AI.user_settings()
    endpoint = LOCAL_AI.resolved_endpoint(None, settings)
    fixtures = calibration_cases()
    conditions: list[tuple[str, dict[str, Any], bool, dict[str, Any]]] = []
    for verifier_model in args.verifier_model:
        for case in fixtures:
            positive = copy.deepcopy(case["positive"])
            negative = replace_nested(positive, str(case["negative_remove"]), "<OMITTED_CRITICAL_FACT>")
            conditions.extend([
                (verifier_model, case, True, positive),
                (verifier_model, case, False, negative),
            ])

    results: list[dict[str, Any]] = []
    order_index = 0
    for repetition in range(1, args.repetitions + 1):
        ordered = list(conditions)
        random.Random(args.order_seed + repetition).shuffle(ordered)
        if repetition % 2 == 0:
            ordered.reverse()
        for verifier_model, case, expected, candidate in ordered:
            order_index += 1
            results.append(run_observation(
                endpoint=endpoint,
                verifier_model=verifier_model,
                case=case,
                expected_usable=expected,
                candidate=candidate,
                repetition=repetition,
                order_index=order_index,
            ))

    by_model: dict[str, Any] = {}
    for verifier_model in args.verifier_model:
        model_results = [item for item in results if item["verifier_model"] == verifier_model]
        observations = len(model_results)
        by_model[verifier_model] = {
            "observations": observations,
            "false_accepts": sum(item["false_accept"] for item in model_results),
            "false_rejects": sum(item["false_reject"] for item in model_results),
            "accuracy_percent": round(
                sum(item["gate_accepted"] == item["expected_usable"] for item in model_results)
                / observations * 100,
                1,
            ) if observations else 0,
            "quality_validation_tokens": sum(item["quality_validation_tokens"] for item in model_results),
            "measurement_coverage_percent": round(
                sum(item["quality_validation_tokens_measured"] for item in model_results)
                / observations * 100,
                1,
            ) if observations else 0,
            "median_latency_seconds": round(
                statistics.median(item["latency_seconds"] for item in model_results), 3,
            ) if observations else 0,
        }

    report = {
        "suite": "local-ai-independent-gate-calibration-v1",
        "deterministic_oracle": True,
        "generator_involved": False,
        "fixture_suite_sha256": hashlib.sha256(
            json.dumps(fixtures, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
        "helper_sha256": hashlib.sha256(HELPER.read_bytes()).hexdigest(),
        "verifier_models": args.verifier_model,
        "repetitions": args.repetitions,
        "order_seed": args.order_seed,
        "by_model": by_model,
        "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
