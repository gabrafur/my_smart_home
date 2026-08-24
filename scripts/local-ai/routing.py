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
    "LOCAL_AI_FAILED",
    "LOCAL_AI_QUALITY_REJECTED",
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
    max_input_tokens: int | None = None
    quality_validated: bool = True
    requires_economic_precheck: bool = False


# These starting values come from the bounded helper's effective 8,192-token
# context and the validated local model.  They are intentionally
# task-specific: a small repeated-error report can be useful sooner than a diff
# or generic file triage, while structured data remains deterministic first.
TASK_PROFILES: dict[str, TaskProfile] = {
    "analyze-tests": TaskProfile(900, 0.80, 600, "high", quality_validated=False),
    "classify-error": TaskProfile(800, 0.70, 500, "high", quality_validated=False),
    "inspect-files": TaskProfile(1200, 0.65, 700, "medium", 3000, False),
    "review-diff": TaskProfile(1200, 0.65, 700, "medium", 3000, False),
    # Repository memory is only delegated after deterministic index/search
    # retrieval. Its threshold matches bounded file triage; a small focused
    # memory note should go straight to the primary model.
    "summarize-memory": TaskProfile(1200, 0.65, 700, "medium", 6000, False),
    # Long-form documentation follows the bounded, moderately compressible
    # profile of a reviewed file set. Arbitrary prose is never routed by size
    # alone; the caller still has to identify it as documentation.
    "summarize-document": TaskProfile(1200, 0.65, 700, "medium", 3000, False),
    # The v4 holdout found positive net savings only in the 3,000–5,999-token
    # log band. Smaller log candidates remain diagnostic-only until new
    # evidence establishes a lower profitable threshold.
    "summarize-log": TaskProfile(3000, 0.80, 600, "high", requires_economic_precheck=True),
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

    result.update({
        "minimum_input_tokens": profile.min_input_tokens,
        "minimum_expected_saved_tokens": profile.min_expected_saved_tokens,
    })
    if profile.max_input_tokens is not None and input_tokens > profile.max_input_tokens:
        result.update({
            "bounded_input_limit_tokens": profile.max_input_tokens,
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "input_exceeds_bounded_context",
        })
        return result
    if not profile.quality_validated:
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "task_quality_not_validated",
        })
        return result

    expected = expected_tokens_saved(input_tokens, profile, effective_compressibility)
    if effective_compressibility == "low":
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "low_expected_compressibility",
        })
        return result
    if input_tokens < profile.min_input_tokens:
        result["expected_tokens_saved"] = expected
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "input_below_task_threshold",
        })
        return result
    if expected < profile.min_expected_saved_tokens:
        result["expected_tokens_saved"] = expected
        result.update({
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "expected_savings_below_threshold",
        })
        return result
    result.update({
        "eligible": True,
        "expected_tokens_saved": expected,
    })
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


def apply_economic_precheck(
    assessment: dict[str, Any],
    *,
    context_input_tokens: int,
    model_input_tokens: int,
    quality_gate_type: str = "llm-verifier",
) -> dict[str, Any]:
    """Reject calls whose best conservative net estimate cannot clear the task floor.

    The fidelity verifier sees the deterministically selected model input plus
    the candidate and rubric.  Profiles without meaningful preprocessing would
    otherwise pay roughly the entire source again merely to discover after
    inference that no net saving was possible.
    """
    result = dict(assessment)
    task = str(result.get("task_type") or "")
    profile = TASK_PROFILES.get(task)
    if (
        profile is None
        or not profile.requires_economic_precheck
        or result.get("decision") != "LOCAL_AI_ELIGIBLE"
    ):
        return result

    raw_tokens = max(0, int(context_input_tokens))
    selected_tokens = max(0, int(model_input_tokens))
    # The candidate and compact verifier response are estimates, while the
    # selected source tokens are measured with the same tokenizer as the raw
    # context. Keep a fixed rubric allowance so borderline calls fail closed.
    estimated_candidate_tokens = max(120, min(800, round(selected_tokens * 0.20)))
    # The extractive log-anchor gate is ordinary local code: it sends no
    # additional context to a model and therefore has zero inference tokens.
    # Keep the candidate itself in the estimate because that is the context
    # ultimately delivered to the primary model.
    estimated_gate_tokens = (
        0
        if quality_gate_type == "deterministic-log-anchors-v1"
        else selected_tokens + estimated_candidate_tokens + 240
    )
    estimated_net_tokens = max(
        0,
        raw_tokens - estimated_candidate_tokens - estimated_gate_tokens,
    )
    result.update({
        "model_input_tokens": selected_tokens,
        "estimated_candidate_tokens": estimated_candidate_tokens,
        "estimated_validation_tokens": estimated_gate_tokens,
        "quality_gate_type": quality_gate_type,
        "expected_net_tokens_saved": estimated_net_tokens,
    })
    if estimated_net_tokens < profile.min_expected_saved_tokens:
        result.update({
            "eligible": False,
            "expected_tokens_saved": 0,
            "decision": "LOCAL_AI_NOT_BENEFICIAL",
            "reason": "insufficient_expected_net_savings",
        })
    return result


def terminal_decision(assessment: dict[str, Any], outcome: str = "auto") -> dict[str, Any]:
    """Turn an assessment into a recorded final outcome without inventing a call."""
    final = dict(assessment)
    if outcome == "used":
        final.update({"decision": "LOCAL_AI_USED", "reason": "local_ai_completed"})
    elif outcome == "failed":
        final.update({"decision": "LOCAL_AI_FAILED", "reason": "local_ai_call_failed"})
    elif outcome == "quality-rejected":
        final.update({"decision": "LOCAL_AI_QUALITY_REJECTED", "reason": "quality_gate_rejected"})
    elif outcome == "unnecessary":
        final.update({"decision": "LOCAL_AI_UNNECESSARY_CALL", "reason": "local_ai_call_not_beneficial"})
    elif outcome == "skipped" and assessment.get("decision") == "LOCAL_AI_ELIGIBLE":
        final.update({"decision": "ROUTING_MISSED_OPPORTUNITY", "reason": "eligible_available_helper_not_called"})
    return final
