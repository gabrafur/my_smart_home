#!/usr/bin/env python3
"""Fail-closed runtime contracts for the evidence-approved restricted pivot."""

from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from log_facts import build_log_context
from model_registry import feature_enabled, load_registry, select_activity_route


LocalGenerator = Callable[[str, Mapping[str, Any], Mapping[str, Any]], Mapping[str, Any]]
PATH_RE = re.compile(r"(?:^|[\s(\"'`])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9_.-]+)")


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
    if isinstance(value, str) and schema.get("pattern") and re.search(str(schema["pattern"]), value) is None:
        errors.append(f"{path}:pattern")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}:minimum")
    return errors


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
    if not set(required).issubset(pairs):
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
        canonical = str(value)
        variants = {canonical, canonical.replace(".", ",")}
        if isinstance(value, float) and value.is_integer():
            variants.add(str(int(value)))
        return any(re.search(rf"(?<![0-9]){re.escape(candidate)}(?![0-9])", source) for candidate in variants)
    return str(value) in source


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
    omissions = [field for field in critical_fields if field not in candidate_mapping]
    unsupported = [
        field for field in critical_fields
        if field in candidate_mapping and not _source_contains_value(source, candidate_mapping[field])
    ]
    forbidden = [field for field in forbidden_fields if field in candidate_mapping]
    numeric_changed = [
        field for field in numeric_fields
        if field not in candidate_mapping or not _source_contains_value(source, candidate_mapping[field])
    ]
    source_paths = set(PATH_RE.findall(source))
    invented_paths = [
        str(value) for key, value in candidate_mapping.items()
        if "path" in str(key).lower() and isinstance(value, str) and source_paths and value not in source_paths
    ]
    critical_errors: list[str] = []
    if errors:
        critical_errors.append("invalid_schema")
    if omissions:
        critical_errors.append("critical_omission")
    if unsupported:
        critical_errors.append("unsupported_field_value")
    if forbidden:
        critical_errors.append("forbidden_field")
    if numeric_changed:
        critical_errors.append("numeric_value_changed")
    if invented_paths:
        critical_errors.append("invented_path")
    accepted = not critical_errors
    return {
        "schema_valid": not errors,
        "critical_field_recall": (len(critical_fields) - len(omissions) - len(unsupported)) / len(critical_fields) if critical_fields else 1.0,
        "numeric_preservation": 1.0 if not numeric_changed else 0.0,
        "invented_critical_fields": len(forbidden) + len(invented_paths),
        "critical_omissions": len(omissions),
        "critical_errors": critical_errors,
        "accepted": accepted,
    }


def execute_structured_extraction(
    source: str,
    schema: Mapping[str, Any],
    *,
    routing_key: str,
    critical_fields: Sequence[str],
    numeric_fields: Sequence[str],
    forbidden_fields: Sequence[str],
    local_generate: LocalGenerator,
    environment: Mapping[str, str] | None = None,
    registry: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    registry = load_registry() if registry is None else dict(registry)
    environment = os.environ if environment is None else environment
    deterministic = deterministic_extract(source, schema)
    if deterministic is not None:
        return {"route": "DETERMINISTIC", "result": deterministic, "fallback": False, "telemetry": None}
    status = residual_status(source, schema)
    route = select_activity_route(
        "structured_extraction", status, registry=registry, environment=environment, routing_key=routing_key,
    )
    if route["route"] != "LOCAL_PRIMARY_CANARY":
        return {"route": "GPT_DIRECT", "reason": route["reason"], "result": None, "fallback": True, "telemetry": None}
    attempt_id = str(uuid.uuid4())
    started = time.monotonic()
    try:
        candidate = dict(local_generate(source, schema, route))
        validation = validate_candidate(
            source, candidate, schema, critical_fields=critical_fields,
            numeric_fields=numeric_fields, forbidden_fields=forbidden_fields,
        )
    except Exception as error:  # callers receive only a bounded category
        candidate = None
        validation = {"accepted": False, "critical_errors": [f"generator_{type(error).__name__}"]}
    accepted = validation.get("accepted") is True
    telemetry = {
        "job_id": str(uuid.uuid4()), "task_id": routing_key, "attempt_id": attempt_id,
        "activity": "structured_extraction", "execution_mode": "canary",
        "model": route["primary_model"], "model_digest": route.get("primary_model_digest"),
        "model_role": "extractor", "dataset": None, "case_id": None,
        "input_tokens": None, "output_tokens": None,
        "estimated_direct_gpt_context": None, "estimated_routed_gpt_context": None,
        "estimated_avoided_gpt_tokens": None,
        "validation_status": "accepted" if accepted else "rejected",
        "accepted": accepted, "fallback_reason": None if accepted else "gpt-direct",
        "critical_errors": list(validation.get("critical_errors") or []),
        "gpu_metrics_status": "NOT_TESTED", "gpu_peak": None, "vram_peak": None,
        "power_peak": None, "duration": round(time.monotonic() - started, 6),
        "index_version": None, "index_freshness": None,
    }
    if not accepted:
        return {"route": "GPT_DIRECT", "reason": "local_candidate_rejected", "result": None, "fallback": True, "validation": validation, "telemetry": telemetry}
    return {"route": "LOCAL_PRIMARY_CANARY", "result": candidate, "fallback": False, "validation": validation, "telemetry": telemetry}


def summarize_log_deterministically(source: str, *, command: str | None = None, exit_code: int | None = None) -> dict[str, Any]:
    context = build_log_context(source, command=command, exit_code=exit_code)
    if context is None:
        return {"route": "GPT_DIRECT", "reason": "deterministic_context_not_beneficial_or_too_many_signals", "result": None, "fallback": True}
    return {
        "route": "DETERMINISTIC_LOG_FACTS",
        "reason": "validated_deterministic_log_facts",
        "result": context["result"],
        "validation": context["validation"],
        "fallback": False,
    }


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
