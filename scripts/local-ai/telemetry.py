#!/usr/bin/env python3
"""Best-effort, private telemetry for bounded Local AI calls.

The recorder deliberately stores metadata only: it never persists source input,
model output, credentials, prompts, or raw command output.  It is safe for the
inference to succeed even when the recorder or GPU probe is unavailable.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import stat
import subprocess
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


MAX_EVENT_LOG_BYTES = 2_000_000
MAX_RECENT_JOBS = 40
MAX_RECENT_DECISIONS = 40
MAX_RECENT_MEMORY_DECISIONS = 40
MAX_SEEN_IDS = 10_000
MAX_SEEN_DECISION_IDS = 10_000
MAX_SEEN_MEMORY_DECISION_IDS = 10_000
MAX_DAILY_RETENTION_DAYS = 400
PRIVATE_METADATA_MODE = 0o660  # owner + bridge group; never world-readable


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def new_event_id() -> str:
    return str(uuid.uuid4())


def _ensure_private_mode(path: Path) -> None:
    """Avoid chmod on correctly secured files owned by the other writer."""
    if stat.S_IMODE(path.stat().st_mode) != PRIVATE_METADATA_MODE:
        os.chmod(path, PRIVATE_METADATA_MODE)


def private_telemetry_path(script_root: Path, configured_path: str | None = None) -> Path | None:
    """Resolve the single private state store used by the CLI and global MCP."""
    configured = os.getenv("LOCAL_AI_TELEMETRY_PATH") or configured_path
    if configured:
        return Path(configured).expanduser()
    project_root = script_root.parent.parent
    history = project_root / ".agent-history"
    return history / "local-ai-telemetry.json" if history.is_dir() else None


def _number(value: Any) -> float | int | None:
    try:
        numeric = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if not numeric == numeric:  # NaN
        return None
    return int(numeric) if numeric.is_integer() else numeric


def _event_totals() -> dict[str, float | int]:
    return {
        "calls": 0,
        "operational_calls": 0,
        "operational_successful_calls": 0,
        "operational_failed_calls": 0,
        "operational_quality_rejected_calls": 0,
        "operational_not_beneficial_calls": 0,
        "operational_quality_validated_calls": 0,
        "operational_quality_validated_measured_calls": 0,
        "diagnostic_calls": 0,
        "unclassified_calls": 0,
        "successful_calls": 0,
        "failed_calls": 0,
        "quality_rejected_calls": 0,
        "not_beneficial_calls": 0,
        "quality_validated_calls": 0,
        "quality_validated_measured_calls": 0,
        "fallbacks_reported": 0,
        "duration_seconds": 0.0,
        "local_input_tokens": 0,
        "local_output_tokens": 0,
        "context_input_tokens": 0,
        "attempted_context_input_tokens": 0,
        "context_output_tokens": 0,
        "context_overhead_tokens": 0,
        "openai_context_tokens_avoided": 0,
        "quality_validated_context_input_tokens": 0,
        "quality_validated_context_output_tokens": 0,
        "gross_useful_context_tokens_avoided": 0,
        "quality_validation_input_tokens": 0,
        "quality_validation_output_tokens": 0,
        "quality_validation_tokens": 0,
        "quality_validated_validation_tokens": 0,
        "quality_validation_measured_calls": 0,
        "quality_validation_unmeasured_calls": 0,
        "quality_validation_unmeasured_gross_tokens": 0,
        "useful_context_tokens_avoided": 0,
    }


def _routing_totals() -> dict[str, float | int]:
    return {
        "tasks": 0,
        "deterministic_tasks": 0,
        "eligible_tasks": 0,
        "eligible_and_available_tasks": 0,
        "used_tasks": 0,
        "failed_tasks": 0,
        "quality_rejected_tasks": 0,
        "skipped_tasks": 0,
        "unavailable_tasks": 0,
        "availability_unknown_tasks": 0,
        "confirmed_unavailable_tasks": 0,
        "not_beneficial_tasks": 0,
        "missed_opportunities": 0,
        "unnecessary_calls": 0,
        "potential_tokens_avoidable": 0,
        "actual_tokens_avoided": 0,
        "gross_useful_tokens_avoided": 0,
        "quality_validation_tokens": 0,
        "quality_validated_validation_tokens": 0,
        "quality_validation_measured_calls": 0,
        "quality_validation_unmeasured_calls": 0,
        "quality_validation_unmeasured_gross_tokens": 0,
        "missed_potential_tokens_avoidable": 0,
        "useful_tokens_avoided": 0,
    }


def _memory_totals() -> dict[str, float | int]:
    """Metrics for retrieval context only; never mix them with tool-output savings."""
    return {
        "retrieval_calls": 0,
        "retrieval_skips": 0,
        "files_found": 0,
        "memory_tokens_available": 0,
        "memory_tokens_retrieved": 0,
        "memory_tokens_sent_to_local_ai": 0,
        "memory_tokens_sent_to_primary_model": 0,
        "memory_tokens_avoided": 0,
        "compression_events": 0,
        "memory_overload_incidents": 0,
        "local_ai_unavailable": 0,
        "local_ai_not_beneficial": 0,
    }


def _initial_state() -> dict[str, Any]:
    return {
        "schema_version": 16,
        "updated_at": None,
        "totals": _event_totals(),
        "daily": {},
        "models": {},
        "seen_event_ids": [],
        "active_jobs": {},
        "latest_jobs": [],
        "routing": {
            "totals": _routing_totals(),
            "seen_decision_ids": [],
            "latest_decisions": [],
        },
        "memory": {
            "totals": _memory_totals(),
            "seen_decision_ids": [],
            "latest_decisions": [],
            "startup_context": None,
        },
    }


def _safe_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback
    return loaded if isinstance(loaded, dict) else fallback


def _counts_as_context_replacement(event: dict[str, Any]) -> bool:
    """Identify analysis attempts intended to replace raw OpenAI context."""
    explicit = event.get("context_replacement")
    if explicit is not None:
        return explicit is True
    # Schema v1 predates the explicit flag. Its normal analysis jobs were
    # context replacements, while benchmark cases were diagnostics only.
    return event.get("status") == "success" and not str(event.get("task") or "").startswith("benchmark:")


def _migrate_complete_v1_history(state: dict[str, Any]) -> None:
    """Rebuild v1 aggregates when every recorded job is still in latest_jobs."""
    if int(state.get("schema_version") or 1) >= 2:
        return
    latest = state.get("latest_jobs")
    calls = int((state.get("totals") or {}).get("calls") or 0)
    if not isinstance(latest, list) or calls > len(latest):
        # Never invent a partial historical total. A future explicit migration
        # can use the append-only event log if the bounded recent list is incomplete.
        return
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for event in latest:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or "")
        if not event_id or event_id in seen:
            continue
        seen.add(event_id)
        unique.append(event)
    if len(unique) != calls:
        return
    state["totals"] = _event_totals()
    state["daily"] = {}
    state["models"] = {}
    for event in unique:
        _add_totals(state, event)
        day = str(event.get("finished_at") or event.get("started_at") or utc_now())[:10]
        daily_entry = state["daily"].setdefault(day, {"totals": _event_totals()})
        _add_totals(daily_entry, event)
        model = str(event.get("model") or "unknown")
        model_entry = state["models"].setdefault(model, {"totals": _event_totals()})
        _add_totals(model_entry, event)
    state["schema_version"] = 2


def _ensure_routing_state(state: dict[str, Any]) -> None:
    """Upgrade metadata in place without rebuilding unknown historical routing."""
    routing = state.setdefault("routing", {})
    if not isinstance(routing, dict):
        routing = {}
        state["routing"] = routing
    previous_schema = int(state.get("schema_version") or 1)
    totals = routing.setdefault("totals", _routing_totals())
    for key, value in _routing_totals().items():
        totals.setdefault(key, value)
    routing.setdefault("seen_decision_ids", [])
    routing.setdefault("latest_decisions", [])
    daily = state.get("daily")
    if isinstance(daily, dict):
        for entry in daily.values():
            if not isinstance(entry, dict):
                continue
            daily_routing = entry.get("routing")
            if not isinstance(daily_routing, dict):
                continue
            # Schema 3 initially wrote the daily totals under an unnecessary
            # nested key. Flatten it so bridge aggregation is consistent with
            # the total routing shape and preserve every already-recorded item.
            nested = daily_routing.pop("totals", None)
            if isinstance(nested, dict):
                for key, value in nested.items():
                    if _number(value) is not None:
                        daily_routing[key] = value
            for key, value in _routing_totals().items():
                daily_routing.setdefault(key, value)
    if previous_schema < 5:
        decisions = [
            item for item in routing.get("latest_decisions", [])
            if isinstance(item, dict) and item.get("decision") == "LOCAL_AI_UNAVAILABLE"
        ]

        def backfill(target: dict[str, Any], candidates: list[dict[str, Any]]) -> None:
            recorded = int(_number(target.get("unavailable_tasks")) or 0)
            # Only claim a complete split when the bounded decision history
            # contains every unavailable event represented by this aggregate.
            if recorded != len(candidates):
                return
            target["availability_unknown_tasks"] = sum(
                str(item.get("reason") or "") == "local_ai_availability_unknown"
                for item in candidates
            )
            target["confirmed_unavailable_tasks"] = recorded - int(target["availability_unknown_tasks"])

        backfill(totals, decisions)
        if isinstance(daily, dict):
            for day, entry in daily.items():
                if not isinstance(entry, dict) or not isinstance(entry.get("routing"), dict):
                    continue
                backfill(
                    entry["routing"],
                    [item for item in decisions if str(item.get("timestamp") or "")[:10] == day],
                )
    if previous_schema < 6:
        failed_decisions = [
            item for item in routing.get("latest_decisions", [])
            if isinstance(item, dict)
            and item.get("decision") == "LOCAL_AI_USED"
            and item.get("reason") == "local_ai_call_failed"
        ]

        def reclassify(target: dict[str, Any], candidates: list[dict[str, Any]]) -> None:
            count = min(int(_number(target.get("used_tasks")) or 0), len(candidates))
            target["used_tasks"] = int(_number(target.get("used_tasks")) or 0) - count
            target["failed_tasks"] = int(_number(target.get("failed_tasks")) or 0) + count

        reclassify(totals, failed_decisions)
        if isinstance(daily, dict):
            for day, entry in daily.items():
                if not isinstance(entry, dict) or not isinstance(entry.get("routing"), dict):
                    continue
                reclassify(
                    entry["routing"],
                    [item for item in failed_decisions if str(item.get("timestamp") or "")[:10] == day],
                )
        for item in failed_decisions:
            item["decision"] = "LOCAL_AI_FAILED"
    state["schema_version"] = max(7, previous_schema)


def _ensure_memory_state(state: dict[str, Any]) -> None:
    """Add retrieval telemetry without reinterpreting historical Local AI jobs."""
    memory = state.setdefault("memory", {})
    if not isinstance(memory, dict):
        memory = {}
        state["memory"] = memory
    totals = memory.setdefault("totals", _memory_totals())
    for key, value in _memory_totals().items():
        totals.setdefault(key, value)
    memory.setdefault("seen_decision_ids", [])
    memory.setdefault("latest_decisions", [])
    memory.setdefault("startup_context", None)
    daily = state.get("daily")
    if isinstance(daily, dict):
        for entry in daily.values():
            if not isinstance(entry, dict):
                continue
            daily_memory = entry.get("memory")
            if not isinstance(daily_memory, dict):
                continue
            nested = daily_memory.pop("totals", None)
            if isinstance(nested, dict):
                daily_memory.update({key: value for key, value in nested.items() if _number(value) is not None})
            for key, value in _memory_totals().items():
                daily_memory.setdefault(key, value)
    state["schema_version"] = max(4, int(state.get("schema_version") or 1))


def _backfill_attempted_context_inputs(state: dict[str, Any], path: Path) -> None:
    """Recover A/B denominators only when the retained event log is complete."""
    if int(state.get("schema_version") or 1) >= 8:
        return
    events_path = path.with_name("local-ai-events.jsonl")
    terminal: dict[str, dict[str, Any]] = {}
    try:
        for line in events_path.read_text(encoding="utf-8").splitlines():
            event = json.loads(line)
            if not isinstance(event, dict) or event.get("status") not in {"success", "discarded", "failed"}:
                continue
            event_id = str(event.get("id") or "")
            if event_id:
                terminal[event_id] = event
    except (OSError, json.JSONDecodeError):
        state["schema_version"] = 8
        return

    def backfill(target: dict[str, Any], candidates: list[dict[str, Any]]) -> None:
        if int(_number(target.get("calls")) or 0) != len(candidates):
            return
        target["attempted_context_input_tokens"] = round(sum(
            float(_number(event.get("context_input_tokens")) or 0)
            for event in candidates
            if _counts_as_context_replacement(event)
        ), 3)

    events = list(terminal.values())
    totals = state.get("totals")
    if isinstance(totals, dict):
        backfill(totals, events)
    daily = state.get("daily")
    if isinstance(daily, dict):
        for day, entry in daily.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                backfill(
                    entry["totals"],
                    [event for event in events if str(event.get("finished_at") or event.get("started_at") or "")[:10] == day],
                )
    models = state.get("models")
    if isinstance(models, dict):
        for model, entry in models.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                backfill(entry["totals"], [event for event in events if str(event.get("model") or "unknown") == model])
    state["schema_version"] = 8


def _ensure_quality_cost_accounting(state: dict[str, Any]) -> None:
    """Start conservative net accounting without inventing legacy gate costs."""
    if int(state.get("schema_version") or 1) >= 9:
        return

    event_targets: list[dict[str, Any]] = []
    if isinstance(state.get("totals"), dict):
        event_targets.append(state["totals"])
    for collection_name in ("daily", "models"):
        collection = state.get(collection_name)
        if not isinstance(collection, dict):
            continue
        for entry in collection.values():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                event_targets.append(entry["totals"])
    for totals in event_targets:
        legacy_useful = max(0, float(_number(totals.get("useful_context_tokens_avoided")) or 0))
        totals["gross_useful_context_tokens_avoided"] = legacy_useful
        totals["quality_validation_input_tokens"] = 0
        totals["quality_validation_output_tokens"] = 0
        totals["quality_validation_tokens"] = 0
        totals["quality_validated_validation_tokens"] = 0
        totals["quality_validation_measured_calls"] = 0
        totals["quality_validation_unmeasured_calls"] = int(
            _number(totals.get("quality_validated_calls")) or 0
        ) + int(_number(totals.get("quality_rejected_calls")) or 0)
        totals["quality_validation_unmeasured_gross_tokens"] = legacy_useful
        # Legacy events did not split generation from verifier tokens. Their
        # gross saving stays visible, but cannot be claimed as net saving.
        totals["useful_context_tokens_avoided"] = 0

    routing_targets: list[dict[str, Any]] = []
    routing = state.get("routing")
    if isinstance(routing, dict) and isinstance(routing.get("totals"), dict):
        routing_targets.append(routing["totals"])
    daily = state.get("daily")
    if isinstance(daily, dict):
        for entry in daily.values():
            if isinstance(entry, dict) and isinstance(entry.get("routing"), dict):
                routing_targets.append(entry["routing"])
    for totals in routing_targets:
        legacy_useful = max(0, float(_number(totals.get("useful_tokens_avoided")) or 0))
        totals["gross_useful_tokens_avoided"] = legacy_useful
        totals["quality_validation_tokens"] = 0
        totals["quality_validated_validation_tokens"] = 0
        totals["quality_validation_measured_calls"] = 0
        totals["quality_validation_unmeasured_calls"] = int(
            _number(totals.get("used_tasks")) or 0
        ) + int(_number(totals.get("quality_rejected_tasks")) or 0)
        totals["quality_validation_unmeasured_gross_tokens"] = legacy_useful
        totals["useful_tokens_avoided"] = 0

    for job in state.get("latest_jobs", []):
        if not isinstance(job, dict) or job.get("quality_accepted") is not True:
            continue
        legacy_useful = max(0, int(_number(job.get("useful_context_tokens_avoided")) or 0))
        job["gross_useful_context_tokens_avoided"] = legacy_useful
        job["quality_validation_tokens_measured"] = False
        job["useful_context_tokens_avoided"] = 0
    if isinstance(routing, dict):
        for decision in routing.get("latest_decisions", []):
            if not isinstance(decision, dict) or decision.get("quality_accepted") is not True:
                continue
            legacy_useful = max(0, int(_number(decision.get("useful_tokens_avoided")) or 0))
            decision["gross_useful_tokens_avoided"] = legacy_useful
            decision["quality_validation_tokens_measured"] = False
            decision["useful_tokens_avoided"] = 0
    state["schema_version"] = 9


def _ensure_bounded_context_accounting(state: dict[str, Any]) -> None:
    """Revoke savings from results that replaced context the model never saw."""
    if int(state.get("schema_version") or 1) >= 10:
        return

    bounded_tasks = {"inspect-files", "review-diff", "summarize-document", "summarize-memory"}
    unsafe_jobs = [
        job for job in state.get("latest_jobs", [])
        if isinstance(job, dict)
        and job.get("status") == "success"
        and job.get("quality_accepted") is True
        and job.get("input_truncated") is True
        and str(job.get("task") or "") in bounded_tasks
        and _counts_as_context_replacement(job)
    ]

    def subtract(target: dict[str, Any], key: str, value: Any, *, count: bool = False) -> None:
        amount = _number(value)
        if amount is None:
            return
        remaining = float(_number(target.get(key)) or 0) - float(amount)
        target[key] = max(0, int(round(remaining))) if count else round(remaining, 3)

    def reclassify_event_totals(target: dict[str, Any], jobs: list[dict[str, Any]]) -> None:
        for job in jobs:
            subtract(target, "successful_calls", 1, count=True)
            target["quality_rejected_calls"] = int(_number(target.get("quality_rejected_calls")) or 0) + 1
            subtract(target, "quality_validated_calls", 1, count=True)
            for target_key, source_key in (
                ("context_input_tokens", "context_input_tokens"),
                ("context_output_tokens", "context_output_tokens"),
                ("context_overhead_tokens", "context_overhead_tokens"),
                ("openai_context_tokens_avoided", "openai_context_tokens_avoided"),
                ("quality_validated_context_input_tokens", "context_input_tokens"),
                ("quality_validated_context_output_tokens", "context_output_tokens"),
                ("gross_useful_context_tokens_avoided", "gross_useful_context_tokens_avoided"),
                ("quality_validated_validation_tokens", "quality_validation_tokens"),
                ("useful_context_tokens_avoided", "useful_context_tokens_avoided"),
            ):
                subtract(target, target_key, job.get(source_key))

    totals = state.get("totals")
    if isinstance(totals, dict):
        reclassify_event_totals(totals, unsafe_jobs)
    daily = state.get("daily")
    if isinstance(daily, dict):
        for day, entry in daily.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                reclassify_event_totals(
                    entry["totals"],
                    [job for job in unsafe_jobs if str(job.get("finished_at") or "")[:10] == day],
                )
    models = state.get("models")
    if isinstance(models, dict):
        for model, entry in models.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                reclassify_event_totals(
                    entry["totals"],
                    [job for job in unsafe_jobs if str(job.get("model") or "unknown") == model],
                )

    unsafe_seconds = {
        (str(job.get("finished_at") or "")[:19], str(job.get("task") or ""))
        for job in unsafe_jobs
    }
    routing = state.get("routing")
    unsafe_decisions: list[dict[str, Any]] = []
    if isinstance(routing, dict):
        unsafe_decisions = [
            decision for decision in routing.get("latest_decisions", [])
            if isinstance(decision, dict)
            and decision.get("decision") == "LOCAL_AI_USED"
            and (str(decision.get("timestamp") or "")[:19], str(decision.get("task_type") or ""))
            in unsafe_seconds
        ]

        def reclassify_routing_totals(target: dict[str, Any], decisions: list[dict[str, Any]]) -> None:
            for decision in decisions:
                subtract(target, "used_tasks", 1, count=True)
                target["quality_rejected_tasks"] = int(
                    _number(target.get("quality_rejected_tasks")) or 0
                ) + 1
                for target_key, source_key in (
                    ("actual_tokens_avoided", "actual_tokens_avoided"),
                    ("gross_useful_tokens_avoided", "gross_useful_tokens_avoided"),
                    ("quality_validated_validation_tokens", "quality_validation_tokens"),
                    ("useful_tokens_avoided", "useful_tokens_avoided"),
                ):
                    subtract(target, target_key, decision.get(source_key))

        if isinstance(routing.get("totals"), dict):
            reclassify_routing_totals(routing["totals"], unsafe_decisions)
        if isinstance(daily, dict):
            for day, entry in daily.items():
                if isinstance(entry, dict) and isinstance(entry.get("routing"), dict):
                    reclassify_routing_totals(
                        entry["routing"],
                        [
                            decision for decision in unsafe_decisions
                            if str(decision.get("timestamp") or "")[:10] == day
                        ],
                    )

    for job in unsafe_jobs:
        job.update({
            "status": "discarded",
            "error_type": "QualityRejected",
            "quality_accepted": False,
            "quality_score_percent": 0,
            "gross_useful_context_tokens_avoided": 0,
            "useful_context_tokens_avoided": 0,
        })
    for decision in unsafe_decisions:
        decision.update({
            "decision": "LOCAL_AI_QUALITY_REJECTED",
            "reason": "input_truncated_before_quality_gate",
            "actual_tokens_avoided": 0,
            "gross_useful_tokens_avoided": 0,
            "useful_tokens_avoided": 0,
            "quality_accepted": False,
            "quality_score_percent": 0,
        })
    state["schema_version"] = 10


def _ensure_operational_accounting(state: dict[str, Any], path: Path) -> None:
    """Separate real context replacements from benchmarks and legacy residue."""
    if int(state.get("schema_version") or 1) >= 16:
        return

    events_path = path.with_name("local-ai-events.jsonl")
    terminal: dict[str, dict[str, Any]] = {}
    try:
        for line in events_path.read_text(encoding="utf-8").splitlines():
            event = json.loads(line)
            if not isinstance(event, dict) or event.get("status") not in {"success", "discarded", "failed"}:
                continue
            event_id = str(event.get("id") or "")
            if event_id:
                terminal[event_id] = event
    except (OSError, json.JSONDecodeError):
        terminal = {}

    def classify(target: dict[str, Any], candidates: list[dict[str, Any]]) -> None:
        nested_rebuild = target.pop("totals", None)
        if (
            isinstance(nested_rebuild, dict)
            and int(_number(target.get("calls")) or 0) == 0
            and int(_number(nested_rebuild.get("calls")) or 0) > 0
        ):
            target.update(nested_rebuild)
        calls = int(_number(target.get("calls")) or 0)
        complete = calls == len(candidates)
        operational = [event for event in candidates if _counts_as_context_replacement(event)] if complete else []
        bounded_tasks = {"inspect-files", "review-diff", "summarize-document", "summarize-memory"}

        def effective_status(event: dict[str, Any]) -> str:
            if (
                event.get("status") == "success"
                and event.get("quality_accepted") is True
                and event.get("input_truncated") is True
                and str(event.get("task") or "") in bounded_tasks
            ):
                return "discarded"
            return str(event.get("status") or "")

        diagnostic = [
            event for event in candidates
            if not _counts_as_context_replacement(event)
            and str(event.get("task") or "").startswith("benchmark:")
        ] if complete else []
        target["operational_calls"] = len(operational)
        target["operational_successful_calls"] = sum(effective_status(event) == "success" for event in operational)
        target["operational_failed_calls"] = sum(effective_status(event) == "failed" for event in operational)
        target["operational_quality_rejected_calls"] = sum(
            effective_status(event) == "discarded"
            and event.get("discard_reason") != "insufficient_net_savings"
            for event in operational
        )
        target["operational_not_beneficial_calls"] = sum(
            effective_status(event) == "discarded"
            and event.get("discard_reason") == "insufficient_net_savings"
            for event in operational
        )
        target["operational_quality_validated_calls"] = sum(
            effective_status(event) == "success" and event.get("quality_accepted") is True
            for event in operational
        )
        target["operational_quality_validated_measured_calls"] = sum(
            effective_status(event) == "success"
            and event.get("quality_accepted") is True
            and event.get("quality_validation_tokens_measured") is True
            for event in operational
        )
        target["diagnostic_calls"] = len(diagnostic)
        target["unclassified_calls"] = max(0, calls - len(operational) - len(diagnostic))
        target["quality_validated_measured_calls"] = sum(
            effective_status(event) == "success"
            and event.get("quality_accepted") is True
            and event.get("quality_validation_tokens_measured") is True
            for event in operational
        ) if complete else 0
        if complete:
            rebuilt = {"totals": _event_totals()}
            for event in candidates:
                normalized = dict(event)
                if effective_status(event) == "discarded" and event.get("status") == "success":
                    normalized.update({
                        "status": "discarded",
                        "quality_accepted": False,
                        "discard_reason": "quality_gate_rejected",
                        "gross_useful_context_tokens_avoided": 0,
                        "useful_context_tokens_avoided": 0,
                    })
                _add_totals(rebuilt, normalized)
            target.update(rebuilt["totals"])

    events = list(terminal.values())
    totals = state.get("totals")
    if isinstance(totals, dict):
        classify(totals, events)
    daily = state.get("daily")
    if isinstance(daily, dict):
        for day, entry in daily.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                classify(
                    entry["totals"],
                    [event for event in events if str(event.get("finished_at") or event.get("started_at") or "")[:10] == day],
                )
    models = state.get("models")
    if isinstance(models, dict):
        for model, entry in models.items():
            if isinstance(entry, dict) and isinstance(entry.get("totals"), dict):
                classify(entry["totals"], [
                    event for event in events if str(event.get("model") or "unknown") == model
                ])
    state["schema_version"] = 16


@contextlib.contextmanager
def _locked_state(path: Path) -> Iterator[dict[str, Any]]:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "a+", encoding="utf-8") as lock:
        _ensure_private_mode(lock_path)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = _safe_json(path, _initial_state())
        _migrate_complete_v1_history(state)
        _ensure_routing_state(state)
        _ensure_memory_state(state)
        _backfill_attempted_context_inputs(state, path)
        _ensure_quality_cost_accounting(state)
        _ensure_bounded_context_accounting(state)
        _ensure_operational_accounting(state, path)
        try:
            yield state
        finally:
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            _ensure_private_mode(temporary)
            temporary.replace(path)
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _append_event(path: Path, event: dict[str, Any]) -> None:
    events_path = path.with_name("local-ai-events.jsonl")
    events_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    with open(events_path, "a", encoding="utf-8") as destination:
        _ensure_private_mode(events_path)
        fcntl.flock(destination.fileno(), fcntl.LOCK_EX)
        destination.write(line)
        destination.flush()
        os.fsync(destination.fileno())
        fcntl.flock(destination.fileno(), fcntl.LOCK_UN)
    try:
        if events_path.stat().st_size > MAX_EVENT_LOG_BYTES:
            lines = events_path.read_text(encoding="utf-8").splitlines()[-400:]
            temporary = events_path.with_suffix(".jsonl.tmp")
            temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
            _ensure_private_mode(temporary)
            temporary.replace(events_path)
    except OSError:
        pass


def _add_totals(target: dict[str, Any], event: dict[str, Any]) -> None:
    totals = target.setdefault("totals", _event_totals())
    for key, value in _event_totals().items():
        totals.setdefault(key, value)
    if "attempted_context_input_tokens" not in totals:
        # Older aggregates did not retain rejected inputs. Preserve their
        # accepted baseline and apply A/B semantics to every new attempt.
        totals["attempted_context_input_tokens"] = totals.get(
            "quality_validated_context_input_tokens", 0,
        )
    totals["calls"] = int(totals.get("calls", 0)) + 1
    successful = event.get("status") == "success"
    not_beneficial = (
        event.get("status") == "discarded"
        and event.get("discard_reason") == "insufficient_net_savings"
    )
    quality_rejected = event.get("status") == "discarded" and not not_beneficial
    operational = _counts_as_context_replacement(event)
    diagnostic = not operational and str(event.get("task") or "").startswith("benchmark:")
    if operational:
        totals["operational_calls"] = int(totals.get("operational_calls", 0)) + 1
        operational_key = (
            "operational_successful_calls" if successful else
            "operational_quality_rejected_calls" if quality_rejected else
            "operational_not_beneficial_calls" if not_beneficial else
            "operational_failed_calls"
        )
        totals[operational_key] = int(totals.get(operational_key, 0)) + 1
    elif diagnostic:
        totals["diagnostic_calls"] = int(totals.get("diagnostic_calls", 0)) + 1
    else:
        totals["unclassified_calls"] = int(totals.get("unclassified_calls", 0)) + 1
    outcome_key = (
        "successful_calls" if successful else
        "quality_rejected_calls" if quality_rejected else
        "not_beneficial_calls" if not_beneficial else
        "failed_calls"
    )
    totals[outcome_key] = int(totals.get(outcome_key, 0)) + 1
    quality_validated = successful and event.get("quality_accepted") is True
    quality_tokens_measured = event.get("quality_validation_tokens_measured") is True
    if quality_tokens_measured:
        totals["quality_validation_measured_calls"] = int(
            totals.get("quality_validation_measured_calls", 0)
        ) + 1
    elif event.get("quality_accepted") is not None or event.get("quality_verification_attempts"):
        totals["quality_validation_unmeasured_calls"] = int(
            totals.get("quality_validation_unmeasured_calls", 0)
        ) + 1
    if quality_validated:
        totals["quality_validated_calls"] = int(totals.get("quality_validated_calls", 0)) + 1
        if operational:
            totals["operational_quality_validated_calls"] = int(
                totals.get("operational_quality_validated_calls", 0)
            ) + 1
        if quality_tokens_measured:
            totals["quality_validated_measured_calls"] = int(
                totals.get("quality_validated_measured_calls", 0)
            ) + 1
            if operational:
                totals["operational_quality_validated_measured_calls"] = int(
                    totals.get("operational_quality_validated_measured_calls", 0)
                ) + 1
    if event.get("fallback_reported") is True:
        totals["fallbacks_reported"] = int(totals.get("fallbacks_reported", 0)) + 1
    for key in (
        "duration_seconds",
        "local_input_tokens",
        "local_output_tokens",
        "quality_validation_input_tokens",
        "quality_validation_output_tokens",
        "quality_validation_tokens",
    ):
        value = _number(event.get(key))
        if value is not None and value > 0:
            totals[key] = round(float(totals.get(key, 0)) + float(value), 3)
    if _counts_as_context_replacement(event):
        attempted_input = _number(event.get("context_input_tokens"))
        if attempted_input is not None and attempted_input > 0:
            totals["attempted_context_input_tokens"] = round(
                float(totals.get("attempted_context_input_tokens", 0)) + float(attempted_input), 3,
            )
    if successful and _counts_as_context_replacement(event):
        for key in ("context_input_tokens", "context_output_tokens", "context_overhead_tokens"):
            value = _number(event.get(key))
            if value is not None and value > 0:
                totals[key] = round(float(totals.get(key, 0)) + float(value), 3)
        avoided = _number(event.get("openai_context_tokens_avoided"))
        if avoided is not None and avoided != 0:
            totals["openai_context_tokens_avoided"] = round(
                float(totals.get("openai_context_tokens_avoided", 0)) + float(avoided),
                3,
            )
        if quality_validated:
            for source, target_key in (
                ("context_input_tokens", "quality_validated_context_input_tokens"),
                ("context_output_tokens", "quality_validated_context_output_tokens"),
            ):
                value = _number(event.get(source))
                if value is not None and value > 0:
                    totals[target_key] = round(float(totals.get(target_key, 0)) + float(value), 3)
            gross_useful = _number(event.get("gross_useful_context_tokens_avoided"))
            if gross_useful is None:
                gross_useful = _number(event.get("useful_context_tokens_avoided"))
            if gross_useful is not None and gross_useful > 0:
                totals["gross_useful_context_tokens_avoided"] = round(
                    float(totals.get("gross_useful_context_tokens_avoided", 0)) + float(gross_useful), 3,
                )
            if quality_tokens_measured:
                validation_tokens = _number(event.get("quality_validation_tokens")) or 0
                totals["quality_validated_validation_tokens"] = round(
                    float(totals.get("quality_validated_validation_tokens", 0)) + float(validation_tokens), 3,
                )
                useful = _number(event.get("useful_context_tokens_avoided"))
            else:
                useful = 0
                if gross_useful is not None and gross_useful > 0:
                    totals["quality_validation_unmeasured_gross_tokens"] = round(
                        float(totals.get("quality_validation_unmeasured_gross_tokens", 0))
                        + float(gross_useful),
                        3,
                    )
            if useful is not None and useful > 0:
                totals["useful_context_tokens_avoided"] = round(
                    float(totals.get("useful_context_tokens_avoided", 0)) + float(useful), 3,
                )


def _add_routing_totals(target: dict[str, Any], decision: dict[str, Any]) -> None:
    nested = target.get("totals")
    totals = nested if isinstance(nested, dict) else target
    for key, value in _routing_totals().items():
        totals.setdefault(key, value)
    totals["tasks"] = int(totals.get("tasks", 0)) + 1
    status = str(decision.get("decision") or "LOCAL_AI_SKIPPED")
    quality_tokens_measured = decision.get("quality_validation_tokens_measured") is True
    if quality_tokens_measured:
        totals["quality_validation_measured_calls"] += 1
    elif decision.get("quality_accepted") is not None:
        totals["quality_validation_unmeasured_calls"] += 1
    validation_tokens = _number(decision.get("quality_validation_tokens"))
    if validation_tokens is not None and validation_tokens > 0:
        totals["quality_validation_tokens"] = round(
            float(totals.get("quality_validation_tokens", 0)) + float(validation_tokens), 3,
        )
    if status == "DETERMINISTIC":
        totals["deterministic_tasks"] += 1
    elif status == "LOCAL_AI_USED":
        totals["eligible_tasks"] += 1
        totals["eligible_and_available_tasks"] += 1
        totals["used_tasks"] += 1
    elif status == "LOCAL_AI_FAILED":
        totals["eligible_tasks"] += 1
        totals["eligible_and_available_tasks"] += 1
        totals["failed_tasks"] += 1
    elif status == "LOCAL_AI_QUALITY_REJECTED":
        totals["eligible_tasks"] += 1
        totals["eligible_and_available_tasks"] += 1
        totals["quality_rejected_tasks"] += 1
    elif status == "ROUTING_MISSED_OPPORTUNITY":
        totals["eligible_tasks"] += 1
        totals["eligible_and_available_tasks"] += 1
        totals["missed_opportunities"] += 1
    elif status == "LOCAL_AI_ELIGIBLE":
        totals["eligible_tasks"] += 1
        totals["eligible_and_available_tasks"] += 1
    elif status == "LOCAL_AI_UNAVAILABLE":
        totals["eligible_tasks"] += 1
        totals["unavailable_tasks"] += 1
        if str(decision.get("reason") or "") == "local_ai_availability_unknown":
            totals["availability_unknown_tasks"] += 1
        else:
            totals["confirmed_unavailable_tasks"] += 1
    elif status == "LOCAL_AI_NOT_BENEFICIAL":
        totals["not_beneficial_tasks"] += 1
    elif status == "LOCAL_AI_UNNECESSARY_CALL":
        totals["unnecessary_calls"] += 1
    else:
        totals["skipped_tasks"] += 1

    if status in {"LOCAL_AI_USED", "LOCAL_AI_FAILED", "LOCAL_AI_QUALITY_REJECTED", "ROUTING_MISSED_OPPORTUNITY", "LOCAL_AI_ELIGIBLE"}:
        expected = _number(decision.get("expected_tokens_saved"))
        if expected is not None and expected > 0:
            totals["potential_tokens_avoidable"] = round(
                float(totals.get("potential_tokens_avoidable", 0)) + float(expected), 3,
            )
            if status == "ROUTING_MISSED_OPPORTUNITY":
                totals["missed_potential_tokens_avoidable"] = round(
                    float(totals.get("missed_potential_tokens_avoidable", 0)) + float(expected), 3,
                )
    if status in {"LOCAL_AI_USED", "LOCAL_AI_UNNECESSARY_CALL"}:
        actual = _number(decision.get("actual_tokens_avoided"))
        if actual is not None:
            totals["actual_tokens_avoided"] = round(
                float(totals.get("actual_tokens_avoided", 0)) + float(actual), 3,
            )
    if status == "LOCAL_AI_USED" and decision.get("quality_accepted") is True:
        gross_useful = _number(decision.get("gross_useful_tokens_avoided"))
        if gross_useful is None:
            gross_useful = _number(decision.get("useful_tokens_avoided"))
        if gross_useful is not None and gross_useful > 0:
            totals["gross_useful_tokens_avoided"] = round(
                float(totals.get("gross_useful_tokens_avoided", 0)) + float(gross_useful), 3,
            )
        if quality_tokens_measured:
            totals["quality_validated_validation_tokens"] = round(
                float(totals.get("quality_validated_validation_tokens", 0))
                + float(validation_tokens or 0),
                3,
            )
            useful = _number(decision.get("useful_tokens_avoided"))
        else:
            useful = 0
            if gross_useful is not None and gross_useful > 0:
                totals["quality_validation_unmeasured_gross_tokens"] = round(
                    float(totals.get("quality_validation_unmeasured_gross_tokens", 0))
                    + float(gross_useful),
                    3,
                )
        if useful is not None and useful > 0:
            totals["useful_tokens_avoided"] = round(
                float(totals.get("useful_tokens_avoided", 0)) + float(useful), 3,
            )


def _add_memory_totals(target: dict[str, Any], decision: dict[str, Any]) -> None:
    nested = target.get("totals")
    totals = nested if isinstance(nested, dict) else target
    for key, value in _memory_totals().items():
        totals.setdefault(key, value)
    status = str(decision.get("decision") or "MEMORY_RETRIEVAL_SKIPPED")
    available = _number(decision.get("memory_tokens_available"))
    if available is not None:
        # The corpus is a snapshot, not a per-retrieval saving.  Retain the
        # largest observed public corpus instead of summing it repeatedly.
        totals["memory_tokens_available"] = max(float(totals.get("memory_tokens_available", 0)), available)
    if status == "MEMORY_RETRIEVAL_SKIPPED":
        totals["retrieval_skips"] += 1
        return

    totals["retrieval_calls"] += 1
    for key in ("files_found", "memory_tokens_retrieved", "memory_tokens_sent_to_local_ai", "memory_tokens_sent_to_primary_model"):
        value = _number(decision.get(key))
        if value is not None and value > 0:
            totals[key] = round(float(totals.get(key, 0)) + value, 3)
    if status == "MEMORY_LOCAL_AI_USED":
        totals["compression_events"] += 1
        avoided = _number(decision.get("memory_tokens_avoided"))
        if avoided is not None:
            totals["memory_tokens_avoided"] = round(float(totals.get("memory_tokens_avoided", 0)) + avoided, 3)
    elif status == "MEMORY_LOCAL_AI_UNAVAILABLE":
        totals["local_ai_unavailable"] += 1
    elif status == "MEMORY_LOCAL_AI_NOT_BENEFICIAL":
        totals["local_ai_not_beneficial"] += 1
    if decision.get("memory_overload") is True:
        totals["memory_overload_incidents"] += 1


def _prune_daily(state: dict[str, Any]) -> None:
    daily = state.get("daily")
    if not isinstance(daily, dict) or len(daily) <= MAX_DAILY_RETENTION_DAYS:
        return
    for day in sorted(daily)[:-MAX_DAILY_RETENTION_DAYS]:
        daily.pop(day, None)


class TelemetryRecorder:
    """Persist idempotent aggregate and recent-job data without blocking inference."""

    def __init__(self, state_path: Path | None):
        self.state_path = state_path

    @property
    def enabled(self) -> bool:
        return self.state_path is not None and os.getenv("LOCAL_AI_TELEMETRY_ENABLED", "1") != "0"

    def started(self, event: dict[str, Any]) -> None:
        if not self.enabled or self.state_path is None:
            return
        public = {
            key: event.get(key)
            for key in ("id", "started_at", "task", "model", "endpoint", "status", "chat_id", "chat_name")
        }
        try:
            with _locked_state(self.state_path) as state:
                state.setdefault("active_jobs", {})[str(event["id"])] = public
                state["updated_at"] = utc_now()
            _append_event(self.state_path, public)
        except (OSError, KeyError, TypeError):
            pass

    def finished(self, event: dict[str, Any]) -> None:
        if not self.enabled or self.state_path is None:
            return
        try:
            with _locked_state(self.state_path) as state:
                event_id = str(event["id"])
                state.setdefault("active_jobs", {}).pop(event_id, None)
                seen = [str(value) for value in state.setdefault("seen_event_ids", [])]
                if event_id not in seen:
                    _add_totals(state, event)
                    day = str(event.get("finished_at") or event.get("started_at") or utc_now())[:10]
                    daily = state.setdefault("daily", {})
                    daily_entry = daily.setdefault(day, {"totals": _event_totals()})
                    _add_totals(daily_entry, event)
                    model = str(event.get("model") or "unknown")
                    models = state.setdefault("models", {})
                    model_entry = models.setdefault(model, {"totals": _event_totals()})
                    _add_totals(model_entry, event)
                    seen.append(event_id)
                    state["seen_event_ids"] = seen[-MAX_SEEN_IDS:]
                    latest = state.setdefault("latest_jobs", [])
                    latest.append(event)
                    state["latest_jobs"] = latest[-MAX_RECENT_JOBS:]
                state["updated_at"] = utc_now()
            _append_event(self.state_path, event)
        except (OSError, KeyError, TypeError):
            pass

    def routing_decision(self, decision: dict[str, Any]) -> None:
        """Persist a final routing outcome, never the source material it evaluated."""
        if not self.enabled or self.state_path is None:
            return
        allowed = (
            "id", "timestamp", "task_type", "input_chars", "estimated_input_tokens",
            "compressibility", "compatible_helper", "eligible", "available",
            "expected_tokens_saved", "actual_tokens_avoided", "decision", "reason",
            "minimum_input_tokens", "minimum_expected_saved_tokens", "model",
            "quality_accepted", "quality_score_percent", "useful_tokens_avoided",
            "gross_useful_tokens_avoided", "quality_validation_tokens",
            "quality_validation_tokens_measured",
        )
        public = {key: decision.get(key) for key in allowed if key in decision}
        public["event_type"] = "routing_decision"
        try:
            with _locked_state(self.state_path) as state:
                routing = state.setdefault("routing", {})
                seen = [str(value) for value in routing.setdefault("seen_decision_ids", [])]
                decision_id = str(public["id"])
                if decision_id not in seen:
                    _add_routing_totals(routing, public)
                    day = str(public.get("timestamp") or utc_now())[:10]
                    daily = state.setdefault("daily", {})
                    daily_entry = daily.setdefault(day, {"totals": _event_totals(), "routing": _routing_totals()})
                    _add_routing_totals(daily_entry.setdefault("routing", _routing_totals()), public)
                    seen.append(decision_id)
                    routing["seen_decision_ids"] = seen[-MAX_SEEN_DECISION_IDS:]
                    latest = routing.setdefault("latest_decisions", [])
                    latest.append(public)
                    routing["latest_decisions"] = latest[-MAX_RECENT_DECISIONS:]
                    _prune_daily(state)
                state["updated_at"] = utc_now()
            _append_event(self.state_path, public)
        except (OSError, KeyError, TypeError):
            pass

    def memory_decision(self, decision: dict[str, Any]) -> None:
        """Persist retrieval metadata only; source paths, text and summaries stay out."""
        if not self.enabled or self.state_path is None:
            return
        allowed = (
            "id", "timestamp", "topic", "files_found", "memory_tokens_available",
            "memory_tokens_retrieved", "memory_tokens_sent_to_local_ai",
            "memory_tokens_sent_to_primary_model", "memory_tokens_avoided",
            "decision", "reason", "available", "expected_tokens_saved",
            "minimum_input_tokens", "minimum_expected_saved_tokens", "model",
            "memory_overload", "canonical_source_conflict", "token_count_method", "estimated",
        )
        public = {key: decision.get(key) for key in allowed if key in decision}
        public["event_type"] = "memory_routing_decision"
        try:
            with _locked_state(self.state_path) as state:
                memory = state.setdefault("memory", {})
                seen = [str(value) for value in memory.setdefault("seen_decision_ids", [])]
                decision_id = str(public["id"])
                if decision_id not in seen:
                    _add_memory_totals(memory, public)
                    day = str(public.get("timestamp") or utc_now())[:10]
                    daily = state.setdefault("daily", {})
                    daily_entry = daily.setdefault(day, {"totals": _event_totals(), "memory": _memory_totals()})
                    _add_memory_totals(daily_entry.setdefault("memory", _memory_totals()), public)
                    seen.append(decision_id)
                    memory["seen_decision_ids"] = seen[-MAX_SEEN_MEMORY_DECISION_IDS:]
                    latest = memory.setdefault("latest_decisions", [])
                    latest.append(public)
                    memory["latest_decisions"] = latest[-MAX_RECENT_MEMORY_DECISIONS:]
                    _prune_daily(state)
                state["updated_at"] = utc_now()
            _append_event(self.state_path, public)
        except (OSError, KeyError, TypeError):
            pass

    def startup_context(self, snapshot: dict[str, Any], memory_tokens_available: int = 0) -> None:
        """Store a bounded, observable startup-context snapshot without raw instructions."""
        if not self.enabled or self.state_path is None:
            return
        allowed = (
            "project_doc_max_bytes", "loaded_instruction_bytes", "global_agents_tokens",
            "repo_agents_tokens", "nested_agents_tokens", "repo_memory_tokens",
            "auto_loaded_docs_tokens", "global_instructions_tokens",
            "other_startup_context_tokens", "local_codex_memories_enabled",
            "local_codex_memory_tokens", "observable_startup_context_tokens",
            "total_startup_context_tokens", "token_count_method", "estimated",
        )
        public = {key: snapshot.get(key) for key in allowed if key in snapshot}
        public["measured_at"] = utc_now()
        try:
            with _locked_state(self.state_path) as state:
                memory = state.setdefault("memory", {})
                memory["startup_context"] = public
                totals = memory.setdefault("totals", _memory_totals())
                totals["memory_tokens_available"] = max(
                    float(totals.get("memory_tokens_available", 0)), max(0, int(memory_tokens_available)),
                )
                state["updated_at"] = utc_now()
        except (OSError, TypeError, ValueError):
            pass

    def sampled(self, event_id: str, sample: dict[str, Any]) -> None:
        """Publish the latest non-sensitive GPU sample for a job still in progress."""
        if not self.enabled or self.state_path is None:
            return
        live_sample = {
            key: sample.get(key)
            for key in ("at", "gpu_util_percent", "vram_mib", "vram_total_mib", "power_watts")
        }
        try:
            with _locked_state(self.state_path) as state:
                job = state.setdefault("active_jobs", {}).get(str(event_id))
                if isinstance(job, dict):
                    job["live_gpu"] = live_sample
                    state["updated_at"] = utc_now()
        except (OSError, TypeError):
            pass


class RemoteGpuSampler:
    """Sample WSL GPU state only while a Local AI request is in progress."""

    def __init__(
        self,
        probe: dict[str, Any] | None,
        interval_seconds: float = 1.5,
        on_sample: callable | None = None,
    ):
        self.probe = probe if isinstance(probe, dict) and probe.get("enabled", True) else None
        self.interval_seconds = max(1.0, interval_seconds)
        self.on_sample = on_sample
        self.snapshots: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _ssh_command(self, remote_command: str) -> list[str] | None:
        if not self.probe:
            return None
        required = ("container", "ssh_user", "ssh_host", "ssh_key_path", "wsl_nvidia_smi")
        if any(not self.probe.get(key) for key in required):
            return None
        known_hosts_path = self.probe.get("ssh_known_hosts_path")
        if not known_hosts_path:
            known_hosts_path = str(Path(str(self.probe["ssh_key_path"])).parent / "known_hosts")
        return [
            "docker", "exec", str(self.probe["container"]), "ssh",
            "-i", str(self.probe["ssh_key_path"]),
            "-p", str(self.probe.get("ssh_port", 22)),
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=4",
            "-o", f"UserKnownHostsFile={known_hosts_path}",
            "-o", "StrictHostKeyChecking=yes",
            f"{self.probe['ssh_user']}@{self.probe['ssh_host']}", remote_command,
        ]

    def _sample_once(self) -> None:
        nvidia = self.probe.get("wsl_nvidia_smi") if self.probe else None
        command = self._ssh_command(
            f"wsl.exe -e {nvidia} --query-gpu=utilization.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits",
        )
        if not command:
            return
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=6, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return
        if result.returncode != 0:
            return
        line = next((item.strip() for item in result.stdout.splitlines() if "," in item), "")
        pieces = [piece.strip() for piece in line.split(",")]
        if len(pieces) < 4:
            return
        values = [_number(piece) for piece in pieces[:4]]
        if values[0] is None or values[1] is None:
            return
        snapshot = {
            "at": utc_now(),
            "gpu_util_percent": values[0],
            "vram_mib": values[1],
            "vram_total_mib": values[2],
            "power_watts": values[3],
        }
        self.snapshots.append(snapshot)
        if self.on_sample:
            try:
                self.on_sample(snapshot)
            except Exception:
                pass

    def _processor(self, model: str | None) -> str | None:
        if not model:
            return None
        command = self._ssh_command("wsl.exe -e ollama ps")
        if not command:
            return None
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=6, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0:
            return None
        for line in result.stdout.splitlines():
            if model in line:
                match = re.search(r"(\d+%\s+(?:GPU|CPU)(?:\s*\+\s*\d+%\s*CPU)?)", line)
                return match.group(1) if match else line.strip()[-80:]
        return None

    def _run(self) -> None:
        while not self._stop.is_set():
            self._sample_once()
            self._stop.wait(self.interval_seconds)

    def start(self) -> None:
        if not self.probe:
            return
        self._thread = threading.Thread(target=self._run, name="local-ai-gpu-sampler", daemon=True)
        self._thread.start()

    def stop(self, model: str | None = None) -> dict[str, Any]:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=7)
        processor = self._processor(model)
        if not self.snapshots:
            return {"gpu_telemetry_available": False, "processor": processor}
        peak_gpu = max((sample.get("gpu_util_percent") or 0 for sample in self.snapshots), default=0)
        peak_vram = max((sample.get("vram_mib") or 0 for sample in self.snapshots), default=0)
        peak_power = max((sample.get("power_watts") or 0 for sample in self.snapshots), default=0)
        return {
            "gpu_telemetry_available": True,
            "gpu_samples": len(self.snapshots),
            "gpu_peak_percent": peak_gpu,
            "vram_peak_mib": peak_vram,
            "gpu_power_peak_watts": peak_power,
            "gpu_used": peak_gpu >= 5 or bool(processor and "GPU" in processor),
            "processor": processor,
            "cpu_offload_detected": bool(processor and "CPU" in processor),
            "gpu_last_util_percent": self.snapshots[-1].get("gpu_util_percent"),
            "gpu_last_vram_mib": self.snapshots[-1].get("vram_mib"),
        }
