#!/usr/bin/env python3
"""Private metadata-only state and audit helpers for the structured canary."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


BREAKER_STATES = {"CLOSED", "OPEN", "MANUAL_HOLD"}
MINIMUM_GATE_ATTEMPTS = 100
MINIMUM_HOLD_ATTEMPTS = 20
FORBIDDEN_EVENT_KEYS = {
    "input", "source", "raw_input", "output", "raw_output", "prompt",
    "thinking", "credentials", "secret", "token", "private_path",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ratio(numerator: int | float, denominator: int | float) -> float | None:
    return round(float(numerator) / float(denominator), 6) if denominator else None


def assignment_bucket(anonymous_task_id: str, assignment_version: str, rollout_salt: str) -> int:
    material = "\x1f".join((assignment_version, rollout_salt, anonymous_task_id))
    return int(hashlib.sha256(material.encode("utf-8")).hexdigest(), 16) % 100


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o660
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_json(path: Path, default: Mapping[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(default)
    return dict(value) if isinstance(value, Mapping) else dict(default)


def read_events(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    events: list[dict[str, Any]] = []
    for line in lines:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def operational_events(events: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        dict(event) for event in events
        if event.get("execution_mode") in {"production_canary", "production_control"}
        and event.get("excluded_from_operational_metrics") is False
    ]


def build_operational_summary(
    events: Sequence[Mapping[str, Any]],
    *,
    config: Mapping[str, Any],
    breaker: Mapping[str, Any],
) -> dict[str, Any]:
    real = operational_events(events)
    unique_tasks: dict[str, Mapping[str, Any]] = {}
    for event in real:
        task_id = event.get("task_id")
        if isinstance(task_id, str) and task_id:
            unique_tasks.setdefault(task_id, event)
    residual = [event for event in unique_tasks.values() if event.get("residual_eligible") is True]
    selected = [event for event in residual if event.get("selected_for_canary") is True]
    controls = [event for event in residual if event.get("selected_for_canary") is False]
    bypasses = [event for event in unique_tasks.values() if event.get("route_kind") == "control_bypass"]
    attempts_by_id: dict[str, Mapping[str, Any]] = {}
    for event in real:
        attempt_id = event.get("attempt_id")
        if event.get("inference_started") is True and isinstance(attempt_id, str) and attempt_id:
            attempts_by_id.setdefault(attempt_id, event)
    attempts = list(attempts_by_id.values())
    completed = [event for event in attempts if event.get("inference_completed") is True]
    accepted = [event for event in attempts if event.get("accepted") is True]
    rejected = [event for event in attempts if event.get("accepted") is False]
    fallbacks = [event for event in attempts if event.get("fallback") is True]
    safe_resolutions = [event for event in attempts if event.get("safe_local_resolution") is True]
    critical_cases = [event for event in attempts if event.get("critical_error") is True]
    critical_occurrences = sum(len(event.get("critical_errors") or []) for event in attempts)
    timeout_count = sum(event.get("inference_status") == "timeout" for event in attempts)
    oom_count = sum(event.get("inference_status") == "oom" for event in attempts)
    schema_valid = [event for event in attempts if event.get("schema_status") == "valid"]
    traces = [event.get("validation_metrics") or {} for event in attempts]
    recall_values = [value.get("critical_field_recall") for value in traces if isinstance(value.get("critical_field_recall"), (int, float))]
    numeric_values = [value.get("numeric_preservation") for value in traces if isinstance(value.get("numeric_preservation"), (int, float))]
    invented = sum(int(value.get("invented_critical_fields") or 0) for value in traces)
    omissions = sum(int(value.get("critical_omissions") or 0) for value in traces)
    breaker_state = str(breaker.get("state") or "OPEN")
    master = config.get("master_switch") is True
    structured = config.get("structured_extraction") is True
    rollout = config.get("rollout_percentage")
    if not master or not structured or rollout == 0:
        status = "DISABLED"
    elif breaker_state == "OPEN":
        status = "ROLLBACK_TRIGGERED"
    elif breaker_state == "MANUAL_HOLD":
        status = "MANUAL_HOLD"
    elif len(attempts) < MINIMUM_GATE_ATTEMPTS:
        status = "CANARY_ACTIVE_INSUFFICIENT_OPERATIONAL_SAMPLE"
    else:
        passes = (
            not critical_cases and critical_occurrences == 0
            and ratio(len(schema_valid), len(attempts)) == 1.0
            and (min(recall_values) if recall_values else 0) == 1.0
            and (min(numeric_values) if numeric_values else 0) == 1.0
            and invented == 0 and omissions == 0
            and (ratio(len(safe_resolutions), len(attempts)) or 0) >= 0.95
            and (ratio(len(fallbacks), len(attempts)) or 1) <= 0.05
            and timeout_count == 0 and oom_count == 0
        )
        status = "CANARY_GATE_PASSED" if passes else "MANUAL_HOLD"
    latest = max((str(event.get("timestamp_utc")) for event in real if event.get("timestamp_utc")), default=None)
    return {
        "schema_version": 1,
        "status": status,
        "generated_at": utc_now(),
        "last_execution_at": latest,
        "sample_required": MINIMUM_GATE_ATTEMPTS,
        "sample_current": len(attempts),
        "decision": "KEEP_AT_10_PERCENT" if status.startswith("CANARY_ACTIVE") else "HOLD" if status == "MANUAL_HOLD" else "ROLLBACK" if status == "ROLLBACK_TRIGGERED" else "KEEP_AT_10_PERCENT",
        "configuration": dict(config),
        "circuit_breaker": {
            "status": breaker_state,
            "reason": breaker.get("reason"),
            "updated_at": breaker.get("updated_at"),
        },
        "metrics": {
            "residual_eligible_cases": len(residual),
            "canary_selected_cases": len(selected),
            "control_cases": len(controls),
            "control_bypass_cases": len(bypasses),
            "local_inference_attempts": len(attempts),
            "local_inference_completed": len(completed),
            "accepted_local_outputs": len(accepted),
            "rejected_local_outputs": len(rejected),
            "safe_fallbacks": len(fallbacks),
            "safe_local_resolutions": len(safe_resolutions),
            "cases_with_critical_error": len(critical_cases),
            "observed_critical_error_occurrences": critical_occurrences,
            "canary_selection_rate": ratio(len(selected), len(residual)),
            "schema_validity": ratio(len(schema_valid), len(attempts)),
            "critical_field_recall": min(recall_values) if recall_values else None,
            "numeric_preservation": min(numeric_values) if numeric_values else None,
            "invented_critical_fields": invented,
            "critical_omissions": omissions,
            "useful_rate": ratio(len(safe_resolutions), len(attempts)),
            "fallback_rate": ratio(len(fallbacks), len(attempts)),
            "critical_case_rate": ratio(len(critical_cases), len(attempts)),
            "timeout_rate": ratio(timeout_count, len(attempts)),
            "oom_rate": ratio(oom_count, len(attempts)),
        },
    }


class CanaryStore:
    """Append-only private events plus a persistent fail-closed breaker."""

    def __init__(self, events_path: Path, breaker_path: Path, summary_path: Path):
        self.events_path = events_path
        self.breaker_path = breaker_path
        self.summary_path = summary_path
        self.lock_path = breaker_path.with_suffix(breaker_path.suffix + ".lock")

    def available(self) -> bool:
        try:
            self.events_path.parent.mkdir(parents=True, exist_ok=True)
            probe = self.events_path.parent / ".structured-canary-write-probe"
            descriptor = os.open(probe, os.O_CREAT | os.O_WRONLY, 0o660)
            os.close(descriptor)
            probe.unlink()
            return True
        except OSError:
            return False

    def _locked(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+", encoding="utf-8")
        os.chmod(self.lock_path, 0o660)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return handle

    def breaker(self) -> dict[str, Any]:
        state = _load_json(self.breaker_path, {"state": "CLOSED", "reason": "initial", "updated_at": None, "processed": {}})
        if state.get("state") not in BREAKER_STATES or not isinstance(state.get("processed", {}), dict):
            return {"state": "OPEN", "reason": "breaker_state_invalid", "updated_at": utc_now(), "processed": {}}
        return state

    def set_breaker(self, state: str, reason: str) -> dict[str, Any]:
        if state not in BREAKER_STATES:
            raise ValueError("invalid_breaker_state")
        handle = self._locked()
        try:
            current = self.breaker()
            current.update({"state": state, "reason": reason, "updated_at": utc_now()})
            _atomic_json(self.breaker_path, current)
            return current
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def claim(self, anonymous_task_id: str, job_id: str) -> bool:
        handle = self._locked()
        try:
            state = self.breaker()
            processed = dict(state.get("processed") or {})
            if anonymous_task_id in processed:
                return False
            processed[anonymous_task_id] = {"job_id": job_id, "status": "started", "at": utc_now()}
            state["processed"] = processed
            _atomic_json(self.breaker_path, state)
            return True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def complete_claim(self, anonymous_task_id: str, status: str) -> None:
        handle = self._locked()
        try:
            state = self.breaker()
            processed = dict(state.get("processed") or {})
            if anonymous_task_id in processed:
                processed[anonymous_task_id] = {**processed[anonymous_task_id], "status": status, "completed_at": utc_now()}
                state["processed"] = processed
                _atomic_json(self.breaker_path, state)
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def has_processed(self, anonymous_task_id: str) -> bool:
        return anonymous_task_id in (self.breaker().get("processed") or {})

    def append(self, event: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, Any]:
        forbidden = FORBIDDEN_EVENT_KEYS.intersection(event)
        if forbidden:
            raise ValueError("forbidden_private_event_fields:" + ",".join(sorted(forbidden)))
        encoded = json.dumps(dict(event), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        handle = self._locked()
        try:
            self.events_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(self.events_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o660)
            with os.fdopen(descriptor, "a", encoding="utf-8") as output:
                output.write(encoded + "\n")
            os.chmod(self.events_path, 0o660)
            summary = build_operational_summary(read_events(self.events_path), config=config, breaker=self.breaker())
            _atomic_json(self.summary_path, summary)
            return summary
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def refresh_summary(self, config: Mapping[str, Any]) -> dict[str, Any]:
        summary = build_operational_summary(read_events(self.events_path), config=config, breaker=self.breaker())
        _atomic_json(self.summary_path, summary)
        return summary

    def apply_statistical_hold(self, config: Mapping[str, Any]) -> dict[str, Any]:
        summary = build_operational_summary(read_events(self.events_path), config=config, breaker=self.breaker())
        metrics = summary["metrics"]
        attempts = int(metrics["local_inference_attempts"])
        reasons = []
        if attempts >= MINIMUM_HOLD_ATTEMPTS:
            if (metrics["fallback_rate"] or 0) > 0.05:
                reasons.append("fallback_rate_above_5_percent")
            if (metrics["useful_rate"] or 0) < 0.95:
                reasons.append("useful_rate_below_95_percent")
            if (metrics["timeout_rate"] or 0) > 0:
                reasons.append("timeout_observed")
            if (metrics["oom_rate"] or 0) > 0:
                reasons.append("oom_observed")
        if reasons and self.breaker().get("state") == "CLOSED":
            self.set_breaker("MANUAL_HOLD", ",".join(reasons))
            summary = self.refresh_summary(config)
        return summary


def audit_events(
    events: Sequence[Mapping[str, Any]],
    *,
    expected_model: str,
    expected_digest: str,
    assignment_version: str,
    rollout_salt: str,
) -> dict[str, Any]:
    real = operational_events(events)
    violations: list[str] = []
    attempts: set[str] = set()
    jobs: set[str] = set()
    for event in real:
        attempt_id = event.get("attempt_id")
        job_id = event.get("job_id")
        if event.get("inference_started") is True:
            if not isinstance(attempt_id, str) or not attempt_id:
                violations.append("attempt_id_missing")
            elif attempt_id in attempts:
                violations.append("duplicate_attempt_id")
            else:
                attempts.add(attempt_id)
            if not isinstance(job_id, str) or not job_id:
                violations.append("job_id_missing")
            elif job_id in jobs:
                violations.append("duplicate_job_id")
            else:
                jobs.add(job_id)
            if event.get("model") != expected_model:
                violations.append("unexpected_model")
            if event.get("model_digest") != expected_digest:
                violations.append("unexpected_model_digest")
        anonymous = event.get("task_id")
        bucket = event.get("stable_bucket")
        if isinstance(anonymous, str) and isinstance(bucket, int):
            if assignment_bucket(anonymous, assignment_version, rollout_salt) != bucket:
                violations.append("canary_assignment_mismatch")
        if event.get("selected_for_canary") is True and isinstance(bucket, int):
            if bucket >= int(event.get("rollout_percentage") or 0):
                violations.append("selected_outside_rollout")
        if event.get("accepted") is True:
            trace = event.get("validation_trace")
            metrics = event.get("validation_metrics") or {}
            if not isinstance(trace, list) or not trace or not all(
                isinstance(item, Mapping)
                and item.get("validation_status") == "valid"
                and item.get("source_evidence_hash")
                and item.get("normalized_value_hash")
                for item in trace
            ):
                violations.append("accepted_without_complete_validation_trace")
            if metrics.get("critical_field_recall") != 1.0 or metrics.get("numeric_preservation") != 1.0:
                violations.append("accepted_without_full_fidelity")
            if metrics.get("invented_critical_fields") or metrics.get("critical_omissions") or metrics.get("contradiction_count"):
                violations.append("accepted_with_critical_validation_error")
        if event.get("accepted") is True and event.get("fallback") is True:
            violations.append("accepted_and_fallback")
        if event.get("accepted") is False and event.get("safe_local_resolution") is True:
            violations.append("rejected_marked_safe_resolution")
    return {
        "schema_version": 1,
        "audited_at": utc_now(),
        "operational_events": len(real),
        "local_attempts": len(attempts),
        "critical_violations": sorted(set(violations)),
        "audit_status": "CRITICAL_VIOLATION" if violations else "PASS",
        "operational_gate_status": "INSUFFICIENT_SAMPLE" if len(attempts) < MINIMUM_GATE_ATTEMPTS else "READY_FOR_GATE_EVALUATION",
    }
