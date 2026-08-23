#!/usr/bin/env python3
"""Paired Local AI quality benchmark where rejected summaries save zero tokens."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
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


def run_case(model: str, case: dict[str, Any]) -> dict[str, Any]:
    source = str(case["source"])
    control_tokens = estimated_tokens(source)
    environment = dict(os.environ)
    environment["LOCAL_AI_TELEMETRY_ENABLED"] = "0"
    started = time.monotonic()
    completed = subprocess.run(
        [
            sys.executable, str(HELPER), str(case["task"]),
            "--model", model, "--context-tokens", "8192",
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
    output = completed.stdout.strip()
    candidate_tokens = estimated_tokens(output) if output else 0
    missing = missing_requirements(output, case["required"])
    quality_accepted = completed.returncode == 0 and not missing
    raw_saved = max(0, control_tokens - candidate_tokens)
    efficient = quality_accepted and raw_saved >= 600
    return {
        "task": case["task"],
        "quality_accepted": quality_accepted,
        "efficient": efficient,
        "control_tokens": control_tokens,
        "candidate_tokens": candidate_tokens,
        "effective_tokens_sent_to_primary": candidate_tokens if efficient else control_tokens,
        "useful_tokens_avoided": raw_saved if efficient else 0,
        "latency_seconds": round(time.monotonic() - started, 3),
        "rejection_reason": None if efficient else (
            "quality_gate_or_inference_rejected" if completed.returncode != 0 else
            "fixture_facts_omitted" if missing else "insufficient_token_reduction"
        ),
        "missing_fact_count": len(missing),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    results = [run_case(args.model, case) for case in cases()]
    control = sum(int(item["control_tokens"]) for item in results)
    effective = sum(int(item["effective_tokens_sent_to_primary"]) for item in results)
    useful = sum(int(item["useful_tokens_avoided"]) for item in results)
    print(json.dumps({
        "suite": "local-ai-quality-ab-v2",
        "model": args.model,
        "cases": len(results),
        "quality_accepted_cases": sum(item["quality_accepted"] is True for item in results),
        "efficient_cases": sum(item["efficient"] is True for item in results),
        "control_tokens": control,
        "effective_tokens_sent_to_primary": effective,
        "useful_tokens_avoided": useful,
        "useful_reduction_percent": round(useful / control * 100, 1) if control else 0,
        "latency_seconds": round(sum(float(item["latency_seconds"]) for item in results), 3),
        "results": results,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
