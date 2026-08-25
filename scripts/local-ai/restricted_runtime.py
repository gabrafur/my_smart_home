#!/usr/bin/env python3
"""Fail-closed operational runtime for the restricted structured canary."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from canary_state import CanaryStore, utc_now
from log_facts import build_log_context
from model_registry import feature_enabled, load_registry, select_activity_route, stable_canary_assignment


PATH_RE = re.compile(r"(?:^|[\s(\"'`])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9_.-]+)")
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+"),
    re.compile(r"\b(?:ghp|github_pat|sk-[A-Za-z0-9])[-_A-Za-z0-9]{16,}\b"),
)
SUPPORTED_SCHEMA_TYPES = {"string", "integer", "number", "boolean"}


@dataclass
class LocalInferenceResult:
    candidate: Mapping[str, Any] | None
    inference_status: str = "completed"
    model_loaded: bool = True
    inference_started: bool = True
    inference_completed: bool = True
    input_tokens: int | None = None
    output_tokens: int | None = None
    duration: float | None = None
    gpu_metrics_status: str = "sampler_failed"
    gpu_peak: float | None = None
    vram_peak: float | None = None
    power_peak: float | None = None
    processor: str | None = None
    error_type: str | None = None
    response_sha256: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


LocalGenerator = Callable[[str, Mapping[str, Any], Mapping[str, Any]], Mapping[str, Any] | LocalInferenceResult]


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def _normalized_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return format(value, ".15g")
    return re.sub(r"\s+", " ", str(value)).strip()


def schema_errors(value: Any, schema: Mapping[str, Any], path: str = "$") -> list[str]:
    errors: list[str] = []
    expected_type = schema.get("type")
    if expected_type == "object":
        if not isinstance(value, Mapping):
            return [f"{path}:expected_object"]
        required = schema.get("required", [])
        for key in required if isinstance(required, list) else []:
            if key not in value:
                errors.append(f"{path}.{key}:required")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            errors.extend(f"{path}.{key}:additional_property" for key in value if key not in properties)
        for key, child_schema in properties.items() if isinstance(properties, Mapping) else []:
            if key in value and isinstance(child_schema, Mapping):
                errors.extend(schema_errors(value[key], child_schema, f"{path}.{key}"))
    elif expected_type == "array":
        if not isinstance(value, list):
            return [f"{path}:expected_array"]
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            errors.append(f"{path}:min_items")
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            errors.append(f"{path}:max_items")
        if schema.get("uniqueItems") is True:
            serialized = [json.dumps(item, sort_keys=True, separators=(",", ":")) for item in value]
            if len(serialized) != len(set(serialized)):
                errors.append(f"{path}:duplicate_items")
        item_schema = schema.get("items")
        if isinstance(item_schema, Mapping):
            for index, item in enumerate(value):
                errors.extend(schema_errors(item, item_schema, f"{path}[{index}]"))
    elif expected_type == "string" and not isinstance(value, str):
        errors.append(f"{path}:expected_string")
    elif expected_type == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
        errors.append(f"{path}:expected_integer")
    elif expected_type == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value))):
        errors.append(f"{path}:expected_number")
    elif expected_type == "boolean" and not isinstance(value, bool):
        errors.append(f"{path}:expected_boolean")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}:enum")
    if isinstance(value, str):
        if schema.get("pattern") and re.search(str(schema["pattern"]), value) is None:
            errors.append(f"{path}:pattern")
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            errors.append(f"{path}:min_length")
        if "maxLength" in schema and len(value) > int(schema["maxLength"]):
            errors.append(f"{path}:max_length")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}:minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}:maximum")
    return errors


def schema_contract_supported(schema: Mapping[str, Any]) -> bool:
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        return False
    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, Mapping) or not properties or not isinstance(required, list) or not required:
        return False
    if set(required) != set(properties) or len(required) != len(set(required)):
        return False
    if len(properties) > 32 or len(json.dumps(schema, separators=(",", ":"))) > 16000:
        return False
    for name, profile in properties.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", str(name)) or not isinstance(profile, Mapping):
            return False
        expected = profile.get("type")
        if expected is None and "enum" in profile:
            if not isinstance(profile.get("enum"), list) or not profile["enum"]:
                return False
        elif expected not in SUPPORTED_SCHEMA_TYPES:
            return False
        if any(key in profile for key in ("$ref", "oneOf", "anyOf", "allOf", "not")):
            return False
    return True


def source_is_safe(source: str, maximum_chars: int) -> bool:
    return 0 < len(source) <= maximum_chars and not any(pattern.search(source) for pattern in SECRET_PATTERNS)


def _coerce(value: str, schema: Mapping[str, Any]) -> Any:
    expected_type = schema.get("type")
    if expected_type == "integer":
        return int(value)
    if expected_type == "number":
        return float(value.replace(",", "."))
    if expected_type == "boolean":
        if value.strip().lower() in {"true", "1", "yes", "on"}:
            return True
        if value.strip().lower() in {"false", "0", "no", "off"}:
            return False
        raise ValueError("invalid_boolean")
    return value.strip()


def deterministic_extract(source: str, schema: Mapping[str, Any]) -> dict[str, Any] | None:
    try:
        parsed = json.loads(source)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, Mapping) and not schema_errors(parsed, schema):
        return dict(parsed)
    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, Mapping) or not isinstance(required, list):
        return None
    pairs = dict(re.findall(r"(?m)^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", source))
    if set(pairs) != set(required):
        return None
    try:
        candidate = {key: _coerce(pairs[key], properties[key]) for key in required}
    except (KeyError, TypeError, ValueError):
        return None
    return candidate if not schema_errors(candidate, schema) else None


def residual_status(source: str, schema: Mapping[str, Any]) -> str | None:
    if deterministic_extract(source, schema) is not None:
        return None
    return "AMBIGUOUS" if re.search(r"\b(?:maybe|possibly|ambiguous|talvez|possivelmente)\b", source, re.IGNORECASE) else "UNSUPPORTED"


def _source_contains_value(source: str, value: Any) -> bool:
    if isinstance(value, bool):
        return str(value).lower() in source.lower()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        canonical = _normalized_value(value)
        variants = {canonical, canonical.replace(".", ",")}
        if isinstance(value, float) and value.is_integer():
            variants.add(str(int(value)))
        return any(re.search(rf"(?<![0-9]){re.escape(candidate)}(?![0-9])", source) for candidate in variants)
    return _normalized_value(value) in re.sub(r"\s+", " ", source)


def validate_candidate(
    source: str,
    candidate: Any,
    schema: Mapping[str, Any],
    *,
    critical_fields: Sequence[str],
    numeric_fields: Sequence[str],
    forbidden_fields: Sequence[str],
) -> dict[str, Any]:
    errors = schema_errors(candidate, schema)
    candidate_mapping = candidate if isinstance(candidate, Mapping) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
    omissions = [field for field in critical_fields if field not in candidate_mapping]
    unsupported = [field for field in critical_fields if field in candidate_mapping and not _source_contains_value(source, candidate_mapping[field])]
    invented_fields = [field for field in candidate_mapping if field not in properties or field in forbidden_fields]
    numeric_changed = [field for field in numeric_fields if field not in candidate_mapping or not _source_contains_value(source, candidate_mapping[field])]
    source_paths = set(PATH_RE.findall(source))
    invented_paths = [str(value) for key, value in candidate_mapping.items() if "path" in str(key).lower() and isinstance(value, str) and value not in source_paths]
    contradictions = sorted(set(unsupported + numeric_changed + invented_paths))
    trace = []
    for field_name in critical_fields:
        present = field_name in candidate_mapping
        value = candidate_mapping.get(field_name)
        anchored = present and _source_contains_value(source, value)
        normalized = _normalized_value(value) if present else "<missing>"
        trace.append({
            "field_name": field_name,
            "validation_rule": "schema_and_exact_source_anchor",
            "validation_status": "valid" if anchored else "invalid",
            "source_evidence_hash": _hash(normalized) if anchored else None,
            "normalized_value_hash": _hash(normalized) if present else None,
        })
    critical_errors: list[str] = []
    if errors:
        critical_errors.append("invalid_schema")
    if omissions:
        critical_errors.append("critical_omission")
    if unsupported:
        critical_errors.append("unsupported_field_value")
    if invented_fields:
        critical_errors.append("invented_field")
    if any(field in candidate_mapping for field in forbidden_fields):
        critical_errors.append("forbidden_field")
    if numeric_changed:
        critical_errors.append("numeric_value_changed")
    if invented_paths:
        critical_errors.append("invented_path")
    if contradictions:
        critical_errors.append("contradiction")
    recall = (len(critical_fields) - len(set(omissions + unsupported))) / len(critical_fields) if critical_fields else 0.0
    complete_trace = len(trace) == len(critical_fields) and bool(trace) and all(item["validation_status"] == "valid" and item["source_evidence_hash"] and item["normalized_value_hash"] for item in trace)
    accepted = not errors and recall == 1.0 and not numeric_changed and not invented_fields and not invented_paths and not omissions and not contradictions and complete_trace
    return {
        "schema_valid": not errors,
        "all_required_fields_valid": not omissions and not unsupported,
        "critical_field_recall": recall,
        "numeric_preservation": 1.0 if not numeric_changed else 0.0,
        "invented_critical_fields": len(set(invented_fields + invented_paths)),
        "critical_omissions": len(omissions),
        "contradiction_count": len(contradictions),
        "complete_validation_trace": complete_trace,
        "validation_trace": trace,
        "critical_errors": list(dict.fromkeys(critical_errors)),
        "accepted": accepted,
    }


def _runtime_event_mode(execution_mode: str, local_selected: bool) -> str:
    if execution_mode == "canary_probe":
        return "canary_probe"
    return "production_canary" if local_selected else "production_control"


def _base_event(
    *, assignment: Mapping[str, Any], route: Mapping[str, Any], parser_status: str,
    execution_mode: str, job_id: str, attempt_id: str, input_subtype: str,
    model: str, model_digest: str, breaker_status: str,
) -> dict[str, Any]:
    selected = route.get("route") == "LOCAL_PRIMARY_CANARY"
    return {
        "task_id": assignment["anonymous_task_id"], "job_id": job_id, "attempt_id": attempt_id,
        "activity": "structured_extraction", "execution_mode": _runtime_event_mode(execution_mode, selected),
        "excluded_from_operational_metrics": execution_mode != "production", "parser_status": parser_status,
        "residual_eligible": route.get("residual_eligible") is True, "route_kind": route.get("route_kind", "control_bypass"),
        "rollout_percentage": route.get("rollout_percentage", 0), "canary_assignment_version": assignment["canary_assignment_version"],
        "stable_bucket": assignment["stable_bucket"], "selected_for_canary": selected,
        "model": model, "model_digest": model_digest, "inference_status": "not_started", "model_loaded": False,
        "inference_started": False, "inference_completed": False, "output_validated": False, "output_accepted": False,
        "schema_status": "not_validated", "validation_status": "not_validated", "accepted": False, "fallback": True,
        "fallback_reason": route.get("reason"), "critical_error": False, "critical_errors": [], "safe_local_resolution": False,
        "input_subtype": input_subtype, "estimated_direct_gpt_context": None, "estimated_routed_gpt_context": None,
        "estimated_avoided_gpt_tokens": 0, "local_input_tokens": None, "local_output_tokens": None, "duration": None,
        "gpu_metrics_status": "not_applicable", "gpu_peak": None, "vram_peak": None, "power_peak": None,
        "circuit_breaker_status": breaker_status, "timestamp_utc": utc_now(),
    }


def execute_structured_extraction(
    source: str, schema: Mapping[str, Any], *, routing_key: str | None = None, task_id: str | None = None,
    schema_version: str = "structured-extraction-v1", logical_origin: str = "codex",
    environment_namespace: str = "production", execution_mode: str = "production", probe_authorized: bool = False,
    input_subtype: str = "generic", critical_fields: Sequence[str], numeric_fields: Sequence[str],
    forbidden_fields: Sequence[str], local_generate: LocalGenerator, environment: Mapping[str, str] | None = None,
    registry: Mapping[str, Any] | None = None, store: CanaryStore | None = None,
    runtime_config: Mapping[str, Any] | None = None, model_available: bool = True,
    digest_matches: bool = True, telemetry_required: bool = False,
) -> dict[str, Any]:
    registry = load_registry() if registry is None else dict(registry)
    environment = os.environ if environment is None else environment
    pivot = registry["restricted_pivot"]["structured_extraction"]
    deterministic = deterministic_extract(source, schema)
    if deterministic is not None:
        return {"route": "DETERMINISTIC", "result": deterministic, "fallback": False, "telemetry": None}
    status = residual_status(source, schema)
    assignment = stable_canary_assignment(
        activity="structured_extraction", assignment_version=str(pivot["assignment_version"]),
        rollout_salt=str(pivot["rollout_salt"]), environment_namespace=environment_namespace,
        schema_version=schema_version, logical_origin=logical_origin, task_id=task_id or routing_key, source=source,
    )
    breaker_status = store.breaker().get("state", "OPEN") if store else "CLOSED"
    contract_supported = schema_contract_supported(schema) and source_is_safe(source, int(pivot["maximum_input_chars"]))
    telemetry_available = not telemetry_required or (store is not None and store.available())
    retry_resolved = bool(store and execution_mode == "production" and store.has_processed(str(assignment["anonymous_task_id"])))
    route = select_activity_route(
        "structured_extraction", status, registry=registry, environment=environment, task_id=task_id or routing_key,
        source=source, schema_version=schema_version, logical_origin=logical_origin,
        environment_namespace=environment_namespace, execution_mode=execution_mode, parser_executed=True,
        contract_supported=contract_supported, model_available=model_available, digest_matches=digest_matches,
        schema_available=schema_contract_supported(schema), validator_available=True,
        circuit_breaker_status=str(breaker_status), input_sanitized=source_is_safe(source, int(pivot["maximum_input_chars"])),
        retry_already_resolved=retry_resolved, probe_authorized=probe_authorized,
    )
    if not telemetry_available:
        route = {"route": "GPT_DIRECT", "reason": "minimum_telemetry_unavailable", "route_kind": "control_bypass", "residual_eligible": False}
    job_id, attempt_id = str(uuid.uuid4()), str(uuid.uuid4())
    profile = registry["models"][pivot["model_key"]]
    event = _base_event(
        assignment=assignment, route=route, parser_status=str(status), execution_mode=execution_mode,
        job_id=job_id, attempt_id=attempt_id, input_subtype=input_subtype,
        model=str(profile["model"]), model_digest=str(profile["digest"]), breaker_status=str(breaker_status),
    )
    direct_context = math.ceil(len(source.encode("utf-8")) / 4)
    event["estimated_direct_gpt_context"] = direct_context
    event["estimated_routed_gpt_context"] = direct_context
    if route.get("route") != "LOCAL_PRIMARY_CANARY":
        if store:
            store.append(event, runtime_config or {})
        return {"route": "GPT_DIRECT", "reason": route.get("reason"), "result": None, "fallback": True, "telemetry": event}
    if store and execution_mode == "production" and not store.claim(str(assignment["anonymous_task_id"]), job_id):
        event.update({"execution_mode": "production_control", "selected_for_canary": False, "route_kind": "control_bypass", "residual_eligible": False, "fallback_reason": "retry_already_resolved"})
        store.append(event, runtime_config or {})
        return {"route": "GPT_DIRECT", "reason": "retry_already_resolved", "result": None, "fallback": True, "telemetry": event}
    started = time.monotonic()
    try:
        generated = local_generate(source, schema, route)
        inference = generated if isinstance(generated, LocalInferenceResult) else LocalInferenceResult(candidate=dict(generated))
    except TimeoutError:
        inference = LocalInferenceResult(candidate=None, inference_status="timeout", inference_completed=False, error_type="timeout")
    except MemoryError:
        inference = LocalInferenceResult(candidate=None, inference_status="oom", inference_completed=False, error_type="oom")
    except json.JSONDecodeError:
        inference = LocalInferenceResult(candidate=None, inference_status="invalid_json", error_type="invalid_json")
    except Exception as error:
        category = getattr(error, "category", None) or type(error).__name__
        inference = LocalInferenceResult(candidate=None, inference_status="failed", inference_completed=False, error_type=str(category))
    duration = inference.duration if inference.duration is not None else round(time.monotonic() - started, 6)
    event.update({
        "model_loaded": inference.model_loaded, "inference_started": inference.inference_started,
        "inference_completed": inference.inference_completed, "inference_status": inference.inference_status,
        "local_input_tokens": inference.input_tokens, "local_output_tokens": inference.output_tokens,
        "duration": duration, "gpu_metrics_status": inference.gpu_metrics_status, "gpu_peak": inference.gpu_peak,
        "vram_peak": inference.vram_peak, "power_peak": inference.power_peak,
    })
    if inference.candidate is None:
        reason = inference.error_type or inference.inference_status
        event.update({"fallback_reason": reason, "estimated_routed_gpt_context": direct_context + 8, "estimated_avoided_gpt_tokens": -8})
        if store:
            store.complete_claim(str(assignment["anonymous_task_id"]), "fallback")
            store.append(event, runtime_config or {})
            store.apply_statistical_hold(runtime_config or {})
        return {"route": "GPT_DIRECT", "reason": reason, "result": None, "fallback": True, "telemetry": event}
    validation = validate_candidate(
        source, inference.candidate, schema, critical_fields=critical_fields,
        numeric_fields=numeric_fields, forbidden_fields=forbidden_fields,
    )
    accepted = validation.get("accepted") is True
    routed_context = max(1, inference.output_tokens or math.ceil(len(json.dumps(inference.candidate, separators=(",", ":")).encode("utf-8")) / 4))
    event.update({
        "output_validated": True, "output_accepted": accepted, "schema_status": "valid" if validation["schema_valid"] else "invalid",
        "validation_status": "accepted" if accepted else "rejected", "accepted": accepted, "fallback": not accepted,
        "fallback_reason": None if accepted else "REJECT_AND_GPT_DIRECT", "critical_error": bool(validation["critical_errors"]),
        "critical_errors": list(validation["critical_errors"]), "safe_local_resolution": accepted,
        "validation_trace": validation["validation_trace"],
        "validation_metrics": {key: validation[key] for key in (
            "schema_valid", "all_required_fields_valid", "critical_field_recall", "numeric_preservation",
            "invented_critical_fields", "critical_omissions", "contradiction_count", "complete_validation_trace",
        )},
        "estimated_routed_gpt_context": routed_context if accepted else direct_context + 8,
        "estimated_avoided_gpt_tokens": direct_context - routed_context if accepted else -8,
    })
    if store:
        store.complete_claim(str(assignment["anonymous_task_id"]), "accepted" if accepted else "fallback")
        store.append(event, runtime_config or {})
        store.apply_statistical_hold(runtime_config or {})
    if not accepted:
        return {"route": "GPT_DIRECT", "reason": "local_candidate_rejected", "result": None, "fallback": True, "validation": validation, "telemetry": event}
    return {"route": "LOCAL_PRIMARY_CANARY", "result": dict(inference.candidate), "fallback": False, "validation": validation, "telemetry": event}


def summarize_log_deterministically(source: str, *, command: str | None = None, exit_code: int | None = None) -> dict[str, Any]:
    context = build_log_context(source, command=command, exit_code=exit_code)
    if context is None:
        return {"route": "GPT_DIRECT", "reason": "deterministic_context_not_beneficial_or_too_many_signals", "result": None, "fallback": True}
    return {"route": "DETERMINISTIC_LOG_FACTS", "reason": "validated_deterministic_log_facts", "result": context["result"], "validation": context["validation"], "fallback": False}


def restricted_feature_route(name: str, environment: Mapping[str, str] | None = None) -> dict[str, Any]:
    registry = load_registry()
    environment = os.environ if environment is None else environment
    policy = registry["restricted_pivot"][name]
    enabled = feature_enabled(name, registry, environment)
    if name == "summarize_log":
        return {"route": "DETERMINISTIC_LOG_FACTS", "enabled": enabled, "decision": policy["decision"]}
    if name == "retrieval":
        return {"route": "DETERMINISTIC", "enabled": enabled, "decision": policy["decision"]}
    if name == "reranker":
        return {"route": "DETERMINISTIC_RANKING", "enabled": enabled, "decision": policy["decision"]}
    if name == "error_similarity":
        return {"route": "EXACT_SIGNATURE_ONLY", "enabled": enabled, "decision": policy["decision"], "automatic_merge": False}
    raise ValueError(f"unsupported_restricted_feature:{name}")
