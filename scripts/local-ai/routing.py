#!/usr/bin/env python3
"""Deterministic Local AI routing policy and privacy-safe decision metadata."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


ROUTING_DECISIONS = {
    "DETERMINISTIC",
    "LOCAL_AI_ELIGIBLE",
    "LOCAL_AI_USED",
    "LOCAL_AI_SKIPPED",
    "LOCAL_AI_UNAVAILABLE",
    "LOCAL_AI_NOT_BENEFICIAL",
    "ROUTING_MISSED_OPPORTUNITY",
    "LOCAL_AI_UNNECESSARY_CALL",
}


@dataclass(frozen=True)
class TaskProfile:
    min_input_tokens: int
    expected_reduction: float
    min_expected_saved_tokens: int
    default_compressibility: str


# These starting values come from the bounded helper's current 4,096-token
# context and the validated 91-93 tok/s local model.  They are intentionally
# task-specific: a small repeated-error report can be useful sooner than a diff
# or generic file triage, while structured data remains deterministic first.
TASK_PROFILES: dict[str, TaskProfile] = {
    "analyze-tests": TaskProfile(900, 0.80, 600, "high"),
    "classify-error": TaskProfile(800, 0.70, 500, "high"),
    "inspect-files": TaskProfile(1200, 0.65, 700, "medium"),
    "review-diff": TaskProfile(1200, 0.65, 700, "medium"),
    # Repository memory is only delegated after deterministic index/search
    # retrieval. Its threshold matches bounded file triage; a small focused
    # memory note should go straight to the primary model.
    "summarize-memory": TaskProfile(1200, 0.65, 700, "medium"),
    "summarize-log": TaskProfile(900, 0.80, 600, "high"),
}


def estimate_tokens(input_chars: int) -> int:
    """Use the same conservative, deterministic character estimate as the helper fallback."""
    return max(0, math.ceil(max(0, input_chars) / 4))


def expected_tokens_saved(input_tokens: int, profile: TaskProfile, compressibility: str) -> int:
    reduction = profile.expected_reduction
    if compressibility == "medium":
        reduction = min(reduction, 0.60)
    elif compressibility == "low":
        reduction = min(reduction, 0.25)
    return max(0, round(input_tokens * reduction))


def assess_routing(
    task: str,
    input_chars: int,
    *,
    availability: str = "available",
    deterministic_sufficient: bool = False,
    compressibility: str | None = None,
) -> dict[str, Any]:
    """Classify a candidate without calling Ollama or retaining its source content."""
    input_tokens = estimate_tokens(input_chars)
    profile = TASK_PROFILES.get(task)
    effective_compressibility = compressibility or (profile.default_compressibility if profile else "low")
    result: dict[str, Any] = {
        "task_type": task,
        "input_chars": max(0, input_chars),
        "estimated_input_tokens": input_tokens,
        "compressibility": effective_compressibility,
        "compatible_helper": profile is not None,
        "eligible": False,
        "available": availability == "available",
        "expected_tokens_saved": 0,
        "decision": "LOCAL_AI_SKIPPED",
        "reason": "no_compatible_helper",
    }
    if deterministic_sufficient:
        result.update({
            "decision": "DETERMINISTIC",
            "reason": "deterministic_tool_sufficient",
        })
        return result
    if profile is None:
        return result

    expected = expected_tokens_saved(input_tokens, profile, effective_compressibility)
    result.update({
        "eligible": True,
        "expected_tokens_saved": expected,
        "minimum_input_tokens": profile.min_input_tokens,
        "minimum_expected_saved_tokens": profile.min_expected_saved_tokens,
    })
    if effective_compressibility == "low":
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "low_expected_compressibility",
        })
        return result
    if input_tokens < profile.min_input_tokens:
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "input_below_task_threshold",
        })
        return result
    if expected < profile.min_expected_saved_tokens:
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "expected_savings_below_threshold",
        })
        return result
    if availability != "available":
        result.update({
            "decision": "LOCAL_AI_UNAVAILABLE",
            "reason": "local_ai_unavailable" if availability == "unavailable" else "local_ai_availability_unknown",
        })
        return result
    result.update({
        "decision": "LOCAL_AI_ELIGIBLE",
        "reason": f"{task.replace('-', '_')}_expected_context_reduction",
    })
    return result


def terminal_decision(assessment: dict[str, Any], outcome: str = "auto") -> dict[str, Any]:
    """Turn an assessment into a recorded final outcome without inventing a call."""
    final = dict(assessment)
    if outcome == "used":
        final.update({"decision": "LOCAL_AI_USED", "reason": "local_ai_completed"})
    elif outcome == "unnecessary":
        final.update({"decision": "LOCAL_AI_UNNECESSARY_CALL", "reason": "local_ai_call_not_beneficial"})
    elif outcome == "skipped" and assessment.get("decision") == "LOCAL_AI_ELIGIBLE":
        final.update({"decision": "ROUTING_MISSED_OPPORTUNITY", "reason": "eligible_available_helper_not_called"})
    return final
