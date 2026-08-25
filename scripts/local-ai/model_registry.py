#!/usr/bin/env python3
"""Validated per-activity model selection for the evidence-gated quality pipeline."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping


REGISTRY_PATH = Path(__file__).with_name("model-registry.json")
ACTIVITIES = (
    "structured_extraction",
    "classification",
    "file_selection",
    "error_clustering",
    "diff_summary",
)
RESIDUAL_STATUSES = {"UNSUPPORTED", "AMBIGUOUS", "NEEDS_SEMANTIC_REVIEW"}
MODES = {"disabled", "shadow", "production"}
MODEL_FIELDS = {
    "model",
    "digest",
    "num_ctx",
    "num_predict",
    "think",
    "temperature",
    "seed",
    "timeout_seconds",
    "keep_alive",
    "structured_output",
    "execution_mode",
    "allowed_activities",
    "primary_enabled",
    "verifier_enabled",
    "production_enabled",
    "shadow_enabled",
}


class RegistryError(ValueError):
    """Raised when the versioned model registry violates its fail-closed contract."""


def load_registry(path: Path = REGISTRY_PATH) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegistryError(f"model_registry_unreadable:{path.name}") from error
    validate_registry(value)
    return value


def validate_registry(registry: Mapping[str, Any]) -> None:
    if registry.get("schema_version") != 1:
        raise RegistryError("unsupported_model_registry_schema")
    quality = registry.get("quality_pipeline")
    models = registry.get("models")
    activities = registry.get("activities")
    if not isinstance(quality, Mapping) or not isinstance(models, Mapping) or not isinstance(activities, Mapping):
        raise RegistryError("model_registry_missing_sections")
    if quality.get("feature_flag") != "LOCAL_AI_QUALITY_PIPELINE_ENABLED":
        raise RegistryError("model_registry_feature_flag_mismatch")
    if quality.get("unresolved_fallback") != "gpt-direct":
        raise RegistryError("model_registry_unsafe_fallback")
    if int(quality.get("maximum_primary_attempts") or 0) != 1:
        raise RegistryError("model_registry_primary_attempts_must_be_one")
    for key, profile in models.items():
        if not isinstance(profile, Mapping):
            raise RegistryError(f"model_profile_not_object:{key}")
        missing = MODEL_FIELDS.difference(profile)
        if missing:
            raise RegistryError(f"model_profile_missing_fields:{key}:{','.join(sorted(missing))}")
        allowed = profile.get("allowed_activities")
        if not isinstance(allowed, list) or not set(allowed).issubset(ACTIVITIES):
            raise RegistryError(f"model_profile_invalid_activities:{key}")
        if int(profile.get("num_ctx") or 0) < 1024:
            raise RegistryError(f"model_profile_invalid_context:{key}")
        if int(profile.get("num_predict") or 0) < 64:
            raise RegistryError(f"model_profile_invalid_output_limit:{key}")
        if int(profile.get("timeout_seconds") or 0) < 1:
            raise RegistryError(f"model_profile_invalid_timeout:{key}")
        if profile.get("production_enabled") is True and profile.get("enabled") is not True:
            raise RegistryError(f"disabled_model_cannot_be_production:{key}")
    for activity in ACTIVITIES:
        profile = activities.get(activity)
        if not isinstance(profile, Mapping):
            raise RegistryError(f"activity_profile_missing:{activity}")
        if profile.get("deterministic_first") is not True:
            raise RegistryError(f"activity_must_be_deterministic_first:{activity}")
        if profile.get("local_mode") not in MODES:
            raise RegistryError(f"activity_invalid_mode:{activity}")
        if profile.get("unresolved_fallback") != "gpt-direct":
            raise RegistryError(f"activity_unsafe_fallback:{activity}")
        _validate_model_reference(registry, activity, "local_model", require_flag="primary_enabled")
        _validate_model_reference(registry, activity, "verifier_model", require_flag="verifier_enabled")
        if profile.get("production_enabled") is True:
            if profile.get("local_mode") != "production" or not profile.get("local_model"):
                raise RegistryError(f"activity_invalid_production_route:{activity}")
    if activities.get("summarize_log") != {"policy": "separate-benchmark-unchanged"}:
        raise RegistryError("summarize_log_policy_must_remain_separate")


def _validate_model_reference(
    registry: Mapping[str, Any],
    activity: str,
    field: str,
    *,
    require_flag: str,
) -> None:
    activity_profile = registry["activities"][activity]
    reference = activity_profile.get(field)
    if reference is None:
        return
    model_profile = registry["models"].get(reference)
    if not isinstance(model_profile, Mapping):
        raise RegistryError(f"activity_unknown_model:{activity}:{reference}")
    if model_profile.get(require_flag) is not True:
        raise RegistryError(f"activity_model_role_disabled:{activity}:{reference}:{require_flag}")
    if activity not in model_profile.get("allowed_activities", []):
        raise RegistryError(f"activity_not_allowed_for_model:{activity}:{reference}")


def quality_pipeline_enabled(
    registry: Mapping[str, Any],
    environment: Mapping[str, str] | None = None,
) -> bool:
    environment = os.environ if environment is None else environment
    flag = str(registry["quality_pipeline"]["feature_flag"])
    value = environment.get(flag)
    if value is None:
        return registry["quality_pipeline"].get("enabled_by_default") is True
    return value.strip().lower() in {"1", "true", "yes", "on"}


def select_activity_route(
    activity: str,
    residual_status: str | None,
    *,
    registry: Mapping[str, Any] | None = None,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Return a bounded route; never execute a model or recurse into another route."""
    registry = load_registry() if registry is None else dict(registry)
    validate_registry(registry)
    if activity == "summarize_log":
        return {"route": "SEPARATE_POLICY", "reason": "summarize_log_unchanged"}
    if activity not in ACTIVITIES:
        raise RegistryError(f"unknown_activity:{activity}")
    if residual_status not in RESIDUAL_STATUSES:
        return {"route": "DETERMINISTIC", "reason": "deterministic_result_sufficient"}
    profile = registry["activities"][activity]
    if not quality_pipeline_enabled(registry, environment):
        return {"route": "GPT_DIRECT", "reason": "quality_pipeline_disabled"}
    if profile.get("production_enabled") is not True or profile.get("local_mode") != "production":
        return {"route": "GPT_DIRECT", "reason": "activity_not_promoted"}
    primary_key = profile.get("local_model")
    primary = registry["models"].get(primary_key) if primary_key else None
    if not isinstance(primary, Mapping) or primary.get("production_enabled") is not True:
        return {"route": "GPT_DIRECT", "reason": "production_model_unavailable"}
    verifier_key = profile.get("verifier_model")
    return {
        "route": "LOCAL_PRIMARY",
        "reason": "approved_residual_route",
        "activity": activity,
        "primary_model_key": primary_key,
        "primary_model": primary.get("model"),
        "verifier_model_key": verifier_key,
        "verifier_model": registry["models"][verifier_key]["model"] if verifier_key else None,
        "maximum_primary_attempts": 1,
        "unresolved_fallback": "gpt-direct",
    }
