#!/usr/bin/env python3
"""Validated per-activity model selection for the evidence-gated quality pipeline."""

from __future__ import annotations

import json
import hashlib
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
PIVOT_FEATURE_FLAGS = {
    "structured_extraction": "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED",
    "summarize_log": "LOCAL_AI_SUMMARIZE_LOG_ENABLED",
    "retrieval": "LOCAL_AI_RETRIEVAL_ENABLED",
    "reranker": "LOCAL_AI_RERANKER_ENABLED",
    "error_similarity": "LOCAL_AI_ERROR_SIMILARITY_ENABLED",
}
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
    pivot = registry.get("restricted_pivot")
    if not isinstance(quality, Mapping) or not isinstance(models, Mapping) or not isinstance(activities, Mapping) or not isinstance(pivot, Mapping):
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
    summarize_log = activities.get("summarize_log")
    if not isinstance(summarize_log, Mapping) or summarize_log.get("policy") != "deterministic-only":
        raise RegistryError("summarize_log_policy_must_be_deterministic_only")
    if summarize_log.get("deterministic_extractor") != "deterministic-log-facts-v1" or summarize_log.get("local_model_approved") is not False:
        raise RegistryError("summarize_log_local_model_must_be_disabled")
    _validate_restricted_pivot(registry)


def _validate_restricted_pivot(registry: Mapping[str, Any]) -> None:
    pivot = registry["restricted_pivot"]
    if pivot.get("schema_version") != 1 or pivot.get("feature_flags") != PIVOT_FEATURE_FLAGS:
        raise RegistryError("restricted_pivot_flags_mismatch")
    structured = pivot.get("structured_extraction")
    if not isinstance(structured, Mapping):
        raise RegistryError("restricted_pivot_structured_missing")
    if structured.get("decision") != "PROMOTE_TO_CANARY" or structured.get("canary_available") is not True:
        raise RegistryError("restricted_pivot_structured_not_canary")
    if structured.get("enabled_by_default") is not False or int(structured.get("rollout_percentage") or 0) != 10:
        raise RegistryError("restricted_pivot_canary_rollout_invalid")
    if structured.get("required_validation") is not True or structured.get("unresolved_fallback") != "gpt-direct":
        raise RegistryError("restricted_pivot_canary_validation_invalid")
    model_key = structured.get("model_key")
    model = registry["models"].get(model_key)
    if not isinstance(model, Mapping) or model.get("enabled") is not True or model.get("primary_enabled") is not True:
        raise RegistryError("restricted_pivot_canary_model_invalid")
    summarize = pivot.get("summarize_log")
    retrieval = pivot.get("retrieval")
    reranker = pivot.get("reranker")
    similarity = pivot.get("error_similarity")
    if not isinstance(summarize, Mapping) or summarize.get("decision") != "DETERMINISTIC_ONLY" or summarize.get("local_model_approved") is not False:
        raise RegistryError("restricted_pivot_summarize_log_invalid")
    if not isinstance(retrieval, Mapping) or retrieval.get("decision") != "NOT_DEMONSTRATED" or retrieval.get("persistent_index_approved") is not False:
        raise RegistryError("restricted_pivot_retrieval_invalid")
    if not isinstance(reranker, Mapping) or reranker.get("decision") != "NOT_TESTED":
        raise RegistryError("restricted_pivot_reranker_invalid")
    if not isinstance(similarity, Mapping) or similarity.get("decision") != "SKIPPED_NO_RETRIEVAL_ADVANTAGE" or similarity.get("automatic_merge") is not False:
        raise RegistryError("restricted_pivot_error_similarity_invalid")


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


def feature_enabled(name: str, registry: Mapping[str, Any], environment: Mapping[str, str]) -> bool:
    flag = str(registry["restricted_pivot"]["feature_flags"][name])
    value = environment.get(flag)
    if value is None:
        return registry["restricted_pivot"][name].get("enabled_by_default") is True
    return value.strip().lower() in {"1", "true", "yes", "on"}


def canary_bucket(routing_key: str) -> int:
    return int(hashlib.sha256(routing_key.encode("utf-8", errors="replace")).hexdigest()[:8], 16) % 100


def select_activity_route(
    activity: str,
    residual_status: str | None,
    *,
    registry: Mapping[str, Any] | None = None,
    environment: Mapping[str, str] | None = None,
    routing_key: str | None = None,
) -> dict[str, Any]:
    """Return a bounded route; never execute a model or recurse into another route."""
    registry = load_registry() if registry is None else dict(registry)
    validate_registry(registry)
    if activity == "summarize_log":
        return {
            "route": "DETERMINISTIC_LOG_FACTS",
            "reason": "summarize_log_deterministic_only",
            "deterministic_extractor": "deterministic-log-facts-v1",
            "unresolved_fallback": "gpt-direct",
        }
    if activity not in ACTIVITIES:
        raise RegistryError(f"unknown_activity:{activity}")
    if residual_status not in RESIDUAL_STATUSES:
        return {"route": "DETERMINISTIC", "reason": "deterministic_result_sufficient"}
    profile = registry["activities"][activity]
    if not quality_pipeline_enabled(registry, environment):
        return {"route": "GPT_DIRECT", "reason": "quality_pipeline_disabled"}
    if activity == "structured_extraction":
        pivot = registry["restricted_pivot"]["structured_extraction"]
        if not feature_enabled("structured_extraction", registry, environment):
            return {"route": "GPT_DIRECT", "reason": "structured_extraction_canary_disabled"}
        if not routing_key:
            return {"route": "GPT_DIRECT", "reason": "structured_extraction_canary_key_required"}
        bucket = canary_bucket(routing_key)
        rollout = int(pivot["rollout_percentage"])
        if bucket >= rollout:
            return {
                "route": "GPT_DIRECT", "reason": "outside_structured_extraction_canary",
                "canary_bucket": bucket, "rollout_percentage": rollout,
            }
        primary_key = str(pivot["model_key"])
        primary = registry["models"][primary_key]
        return {
            "route": "LOCAL_PRIMARY_CANARY",
            "reason": "approved_residual_canary",
            "activity": activity,
            "primary_model_key": primary_key,
            "primary_model": primary.get("model"),
            "primary_model_digest": primary.get("digest"),
            "maximum_primary_attempts": 1,
            "required_validation": True,
            "canary_bucket": bucket,
            "rollout_percentage": rollout,
            "unresolved_fallback": "gpt-direct",
        }
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
