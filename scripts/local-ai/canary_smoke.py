#!/usr/bin/env python3
"""Run the 20 required, non-operational structured-canary probes."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any, Mapping

from canary_state import CanaryStore, read_events
from model_registry import load_registry, stable_canary_assignment
from restricted_runtime import LocalInferenceResult, restricted_feature_route, summarize_log_deterministically
from structured_canary import (
    _request, effective_config, extract_payload, load_machine_settings, private_paths, runtime_model_state,
)


SCHEMA = {
    "type": "object",
    "properties": {
        "record_id": {"type": "string", "pattern": "^RSP-2026-[0-9]{3}$"},
        "status": {"enum": ["passed", "failed", "warning"]},
        "path": {"type": "string"}, "line": {"type": "integer", "minimum": 1},
        "count": {"type": "integer", "minimum": 0},
        "duration_seconds": {"type": "number", "minimum": 0},
        "error_code": {"type": "string", "pattern": "^PVT-[A-Z]{3}-[0-9]{3}$"},
    },
    "required": ["record_id", "status", "path", "line", "count", "duration_seconds", "error_code"],
    "additionalProperties": False,
}
SOURCE = (
    "The residual record RSP-2026-042 has status passed. Evidence is in "
    "scripts/local-ai/routing.py at line 17. The count is 9, duration is 2.5 seconds, "
    "and the exact error code is PVT-RTX-407."
)
OUTPUT = {
    "record_id": "RSP-2026-042", "status": "passed", "path": "scripts/local-ai/routing.py",
    "line": 17, "count": 9, "duration_seconds": 2.5, "error_code": "PVT-RTX-407",
}
ACTIVE = {
    "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "1", "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "1",
    "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "10", "LOCAL_AI_SUMMARIZE_LOG_ENABLED": "0",
    "LOCAL_AI_RETRIEVAL_ENABLED": "0", "LOCAL_AI_RERANKER_ENABLED": "0",
    "LOCAL_AI_ERROR_SIMILARITY_ENABLED": "0",
}


def selected_task_id(registry: Mapping[str, Any], *, selected: bool, origin: str = "canary-smoke") -> str:
    pivot = registry["restricted_pivot"]["structured_extraction"]
    for index in range(10000):
        task_id = f"synthetic-probe-{index}"
        assignment = stable_canary_assignment(
            activity="structured_extraction", assignment_version=pivot["assignment_version"],
            rollout_salt=pivot["rollout_salt"], environment_namespace="production",
            schema_version=pivot["schema_version"], logical_origin=origin, task_id=task_id,
        )
        if (assignment["stable_bucket"] < 10) is selected:
            return task_id
    raise RuntimeError("synthetic_probe_assignment_not_found")


def payload(task_id: str, **updates: Any) -> dict[str, Any]:
    value = {
        "source": SOURCE, "schema": SCHEMA, "task_id": task_id,
        "logical_origin": "canary-smoke", "execution_mode": "canary_probe",
        "input_subtype": "synthetic_safe_probe",
    }
    value.update(updates)
    return value


def probe_record(name: str, passed: bool, result: Mapping[str, Any] | None = None, **evidence: Any) -> dict[str, Any]:
    telemetry = result.get("telemetry") if isinstance(result, Mapping) and isinstance(result.get("telemetry"), Mapping) else {}
    return {
        "name": name, "status": "PASS" if passed else "FAIL",
        "route": result.get("route") if isinstance(result, Mapping) else None,
        "reason": result.get("reason") if isinstance(result, Mapping) else None,
        "inference_status": telemetry.get("inference_status"),
        "excluded_from_operational_metrics": telemetry.get("excluded_from_operational_metrics"),
        **evidence,
    }


def run(output_path: Path, expected_nodered_hash: str) -> dict[str, Any]:
    settings = load_machine_settings()
    registry = load_registry()
    selected = selected_task_id(registry, selected=True)
    control = selected_task_id(registry, selected=False)
    model_profile = registry["models"][registry["restricted_pivot"]["structured_extraction"]["model_key"]]
    real_store = CanaryStore(*private_paths(settings))
    results: list[dict[str, Any]] = []
    actual_proof: dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        store = CanaryStore(root / "events.jsonl", root / "breaker.json", root / "summary.json")
        model_ok = {"available": True, "digest_matches": True, "endpoint": "probe"}
        deterministic = extract_payload(
            payload("parser", source=json.dumps(OUTPUT, separators=(",", ":"))), settings=settings,
            environment=ACTIVE, store=store, generator=lambda *_: (_ for _ in ()).throw(AssertionError()), model_state_override=model_ok,
        )
        results.append(probe_record("parser_resolves_without_ai", deterministic["route"] == "DETERMINISTIC", deterministic))

        calls: list[bool] = []
        outside = extract_payload(payload(control), settings=settings, environment=ACTIVE, store=store, generator=lambda *_: calls.append(True), model_state_override=model_ok)
        results.append(probe_record("residual_outside_cohort", outside.get("reason") == "outside_structured_extraction_canary" and not calls, outside))

        inside = extract_payload(payload(selected), settings=settings, environment=ACTIVE, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("residual_inside_cohort", inside["route"] == "LOCAL_PRIMARY_CANARY", inside))

        valid = extract_payload(payload(selected + "-valid"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("valid_extraction", valid["route"] == "LOCAL_PRIMARY_CANARY" and valid["validation"]["complete_validation_trace"], valid))

        invalid_json = extract_payload(payload(selected + "-json"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: LocalInferenceResult(candidate=None, inference_status="invalid_json", error_type="invalid_json"), model_state_override=model_ok)
        results.append(probe_record("invalid_json_rejected", invalid_json["route"] == "GPT_DIRECT" and invalid_json["telemetry"]["fallback"], invalid_json))

        omitted = extract_payload(payload(selected + "-omitted"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: {key: value for key, value in OUTPUT.items() if key != "error_code"}, model_state_override=model_ok)
        results.append(probe_record("critical_field_omitted", "critical_omission" in omitted["validation"]["critical_errors"], omitted))

        changed = extract_payload(payload(selected + "-number"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: {**OUTPUT, "line": 18}, model_state_override=model_ok)
        results.append(probe_record("changed_number_rejected", "numeric_value_changed" in changed["validation"]["critical_errors"], changed))

        invented = extract_payload(payload(selected + "-invented"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: {**OUTPUT, "invented": "field"}, model_state_override=model_ok)
        results.append(probe_record("invented_field_rejected", "invented_field" in invented["validation"]["critical_errors"], invented))

        unavailable = extract_payload(payload(selected + "-unavailable"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: OUTPUT, model_state_override={"available": False, "digest_matches": False, "endpoint": None})
        results.append(probe_record("model_unavailable", unavailable.get("reason") == "configured_model_unavailable", unavailable))

        timeout = extract_payload(payload(selected + "-timeout"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: (_ for _ in ()).throw(TimeoutError()), model_state_override=model_ok)
        results.append(probe_record("timeout_simulated", timeout["telemetry"]["inference_status"] == "timeout", timeout))

        store.set_breaker("OPEN", "probe")
        breaker = extract_payload(payload(selected + "-breaker"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "100"}, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("circuit_breaker_open", breaker.get("reason") == "circuit_breaker_not_closed", breaker))
        store.set_breaker("CLOSED", "probe_reset")

        master = extract_payload(payload(selected + "-master"), settings=settings, environment={**ACTIVE, "LOCAL_AI_QUALITY_PIPELINE_ENABLED": "0"}, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("master_switch_off", master.get("reason") == "quality_pipeline_disabled", master))

        flag = extract_payload(payload(selected + "-flag"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "0"}, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("structured_flag_off", flag.get("reason") == "structured_extraction_canary_disabled", flag))

        zero = extract_payload(payload(selected + "-zero"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ROLLOUT_PERCENT": "0"}, store=store, generator=lambda *_: OUTPUT, model_state_override=model_ok)
        results.append(probe_record("rollout_zero", zero.get("reason") == "rollout_zero", zero))

        rollback_calls: list[bool] = []
        before_attempts = sum(event.get("inference_started") is True for event in read_events(store.events_path))
        rolled = extract_payload(payload(selected + "-rollback"), settings=settings, environment={**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "0"}, store=store, generator=lambda *_: rollback_calls.append(True), model_state_override=model_ok)
        after_attempts = sum(event.get("inference_started") is True for event in read_events(store.events_path))
        disabled_config, _ = effective_config(registry, settings, {**ACTIVE, "LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED": "0"})
        disabled_status = store.refresh_summary(disabled_config)["status"]
        results.append(probe_record("rollback_feature_flag", rolled["route"] == "GPT_DIRECT" and not rollback_calls and before_attempts == after_attempts and disabled_status == "DISABLED", rolled))

        pivot = registry["restricted_pivot"]["structured_extraction"]
        assignment_args = {
            "activity": "structured_extraction", "assignment_version": pivot["assignment_version"],
            "rollout_salt": pivot["rollout_salt"], "environment_namespace": "production",
            "schema_version": pivot["schema_version"], "logical_origin": "canary-smoke", "task_id": selected,
        }
        retry_a = stable_canary_assignment(**assignment_args); retry_b = stable_canary_assignment(**assignment_args)
        results.append(probe_record("retry_same_cohort", retry_a == retry_b, stable_bucket=retry_a["stable_bucket"]))
        restarted_store = CanaryStore(store.events_path, store.breaker_path, store.summary_path)
        restart_assignment = stable_canary_assignment(**assignment_args)
        results.append(probe_record("restart_same_cohort", restart_assignment == retry_a and restarted_store.breaker()["state"] == "CLOSED", stable_bucket=restart_assignment["stable_bucket"]))

        log_source = "$ check\n" + "INFO heartbeat\n" * 600 + "ERROR PVT-RTX-407\nEXIT_CODE=1\n"
        logs = summarize_log_deterministically(log_source, command="check", exit_code=1)
        results.append(probe_record("summarize_log_deterministic", logs["route"] == "DETERMINISTIC_LOG_FACTS"))
        retrieval = restricted_feature_route("retrieval", {"LOCAL_AI_RETRIEVAL_ENABLED": "0"})
        results.append(probe_record("retrieval_disabled", retrieval["route"] == "DETERMINISTIC" and not retrieval["enabled"]))

    model_state = runtime_model_state(settings, model_profile)
    real = extract_payload(payload(selected), settings=settings, environment=ACTIVE, store=real_store)
    telemetry = real.get("telemetry") or {}
    proof_ok = (
        telemetry.get("inference_started") is True and telemetry.get("inference_completed") is True
        and telemetry.get("model") == model_profile["model"] and telemetry.get("model_digest") == model_profile["digest"]
        and isinstance(telemetry.get("local_input_tokens"), int) and isinstance(telemetry.get("local_output_tokens"), int)
        and telemetry.get("gpu_metrics_status") == "observed" and telemetry.get("vram_peak") is not None
        and telemetry.get("output_validated") is True
    )
    results.append(probe_record("real_rtx_inference", proof_ok, real))
    actual_proof = {
        "model": telemetry.get("model"), "model_digest": telemetry.get("model_digest"),
        "job_id_present": bool(telemetry.get("job_id")), "attempt_id_present": bool(telemetry.get("attempt_id")),
        "model_loaded": telemetry.get("model_loaded"), "inference_started": telemetry.get("inference_started"),
        "inference_completed": telemetry.get("inference_completed"), "output_validated": telemetry.get("output_validated"),
        "output_accepted": telemetry.get("output_accepted"), "local_input_tokens": telemetry.get("local_input_tokens"),
        "local_output_tokens": telemetry.get("local_output_tokens"), "duration_seconds": telemetry.get("duration"),
        "gpu_metrics_status": telemetry.get("gpu_metrics_status"), "gpu_peak_percent": telemetry.get("gpu_peak"),
        "vram_peak_mib": telemetry.get("vram_peak"), "power_peak_watts": telemetry.get("power_peak"),
    }
    endpoint = model_state.get("endpoint")
    if endpoint:
        try:
            _request(str(endpoint), "/api/generate", {"model": model_profile["model"], "keep_alive": 0}, 60)
        except RuntimeError:
            pass

    current_hash = hashlib.sha256(Path("nodered/flows.json").read_bytes()).hexdigest()
    results.append(probe_record("nodered_unchanged", current_hash == expected_nodered_hash, concurrent_file_preserved=current_hash == expected_nodered_hash))
    report = {
        "schema_version": 1, "execution_mode": "canary_probe", "excluded_from_operational_metrics": True,
        "probe_count": len(results), "passed": sum(item["status"] == "PASS" for item in results),
        "failed": sum(item["status"] == "FAIL" for item in results), "results": results,
        "real_rtx_proof": actual_proof, "operational_metrics_affected": False,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-nodered-hash", required=True)
    args = parser.parse_args()
    report = run(args.output, args.expected_nodered_hash)
    print(json.dumps({key: report[key] for key in ("probe_count", "passed", "failed", "operational_metrics_affected")}, separators=(",", ":")))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
