#!/usr/bin/env python3
"""Bounded, repository-local first-pass AI analysis through Ollama.

Stdout is deliberately limited to the model's structured response. Diagnostics go
to stderr so callers can safely feed stdout back to Codex without bloating context.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from memory_context import instruction_chain, public_memory_inventory
from routing import TASK_PROFILES, assess_routing, terminal_decision
from telemetry import RemoteGpuSampler, TelemetryRecorder, new_event_id, private_telemetry_path, utc_now


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent.parent
PROMPTS = ROOT / "prompts"
# This workspace runs separately from the GPU/Ollama host. Requiring an explicit
# machine-local endpoint avoids accidentally sending work to an unrelated local
# service when the helper is invoked from a container or remote VS Code server.
DEFAULT_ENDPOINT: str | None = None
MAX_RAW_CHARS = 2_000_000
AUTO_MODEL_MAX_BYTES = 8_500_000_000
TASK_REQUIRED_FIELDS = {
    "analyze-tests": {"summary", "failures", "warnings", "recommended_actions", "confidence"},
    "classify-error": {"summary", "category", "layer", "likely_causes", "recommended_actions", "confidence"},
    "inspect-files": {"summary", "files", "suspected_files", "recommended_actions", "confidence"},
    "review-diff": {"summary", "findings", "suspected_files", "risks", "recommended_actions", "confidence"},
    "summarize-memory": {
        "summary", "current_state", "decisions", "constraints", "known_bugs", "root_causes",
        "configuration_values", "unresolved_issues", "warnings", "source_facts", "confidence",
    },
    "summarize-log": {"summary", "errors", "suspected_files", "recommended_actions", "confidence"},
}
TASK_LIST_FIELDS = {
    "analyze-tests": {"failures", "warnings", "recommended_actions"},
    "classify-error": {"likely_causes", "recommended_actions"},
    "inspect-files": {"files", "suspected_files", "recommended_actions"},
    "review-diff": {"findings", "suspected_files", "risks", "recommended_actions"},
    "summarize-memory": {
        "current_state", "decisions", "constraints", "known_bugs", "root_causes",
        "configuration_values", "unresolved_issues", "warnings", "source_facts",
    },
    "summarize-log": {"errors", "suspected_files", "recommended_actions"},
}


def response_format(task: str, compact: bool = False) -> str | dict[str, Any]:
    """Use a bounded schema where free-form JSON proved too easy to overrun."""
    if task == "summarize-memory":
        max_items = 2 if compact else 8
        text_lists = [
            "current_state", "decisions", "constraints", "known_bugs", "root_causes",
            "configuration_values", "unresolved_issues", "warnings",
        ]
        properties: dict[str, Any] = {
            "summary": {"type": "string"},
            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
            "source_facts": {
                "type": "array", "maxItems": max_items,
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "facts": {"type": "array", "maxItems": max_items, "items": {"type": "string"}},
                    },
                    "required": ["source", "facts"], "additionalProperties": False,
                },
            },
        }
        properties.update({name: {"type": "array", "maxItems": max_items, "items": {"type": "string"}} for name in text_lists})
        return {
            "type": "object", "properties": properties,
            "required": ["summary", *text_lists, "source_facts", "confidence"],
            "additionalProperties": False,
        }
    if task != "summarize-log":
        return "json"
    max_items = 2 if compact else 8
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "errors": {"type": "array", "maxItems": max_items, "items": {"type": "string"}},
            "suspected_files": {"type": "array", "maxItems": max_items, "items": {"type": "string"}},
            "recommended_actions": {"type": "array", "maxItems": max_items, "items": {"type": "string"}},
            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        },
        "required": ["summary", "errors", "suspected_files", "recommended_actions", "confidence"],
        "additionalProperties": False,
    }


def user_settings() -> dict[str, Any]:
    """Load optional machine-local defaults without making a repository portable by accident."""
    configured = os.getenv("LOCAL_AI_CONFIG")
    candidates = [Path(configured).expanduser()] if configured else []
    config_home = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
    candidates.append(config_home / "codex" / "local-ai.json")
    for path in candidates:
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(loaded, dict):
            return loaded
    return {}


def resolved_endpoint(explicit: str | None, settings: dict[str, Any]) -> str:
    endpoint = explicit or os.getenv("LOCAL_AI_ENDPOINT") or settings.get("endpoint") or DEFAULT_ENDPOINT
    if not endpoint:
        raise RuntimeError(
            "no Ollama endpoint configured; set LOCAL_AI_ENDPOINT or endpoint in ~/.config/codex/local-ai.json"
        )
    return str(endpoint)


def configured_model(explicit: str | None, settings: dict[str, Any]) -> str | None:
    value = explicit or os.getenv("LOCAL_AI_MODEL") or settings.get("model")
    return str(value) if value else None


def local_ai_enabled(settings: dict[str, Any]) -> bool:
    if os.getenv("LOCAL_AI_ENABLED") == "0":
        return False
    return settings.get("enabled") is not False


def current_chat_id() -> str | None:
    """Expose only a short, non-content identifier for concurrent Codex jobs."""
    value = os.getenv("CODEX_THREAD_ID") or os.getenv("CODEX_SESSION_ID")
    return value[:8] if value else None


def current_chat_name() -> str | None:
    """Use an optional caller-provided label without deriving it from prompt content."""
    value = os.getenv("CODEX_CHAT_NAME") or os.getenv("CODEX_THREAD_NAME")
    if not value:
        return None
    normalized = " ".join(value.split())
    return normalized[:80] or None


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or positive")
    return parsed


def request(endpoint: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    http_request = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(http_request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Ollama at {endpoint} is unavailable or returned invalid JSON: {error}") from error


def tags(endpoint: str, request_call=request) -> list[dict[str, Any]]:
    response = request_call(endpoint, "/api/tags")
    models = response.get("models", []) if isinstance(response, dict) else []
    return [model for model in models if isinstance(model, dict) and isinstance(model.get("name"), str)]


def select_model(models: list[dict[str, Any]]) -> str | None:
    """Avoid silently picking a large model that is likely to CPU-offload on 12 GB."""
    eligible = [m for m in models if isinstance(m.get("size"), int) and m["size"] <= AUTO_MODEL_MAX_BYTES]
    names = {m["name"].lower(): m["name"] for m in eligible}
    for preferred in ("qwen2.5-coder:7b", "qwen2.5-coder:7b-instruct", "qwen3-coder:8b"):
        if preferred in names:
            return names[preferred]
    coder_models = [m["name"] for m in eligible if "coder" in m["name"].lower() or "code" in m["name"].lower()]
    if coder_models:
        return sorted(coder_models)[0]
    small_models = [m["name"] for m in eligible if m.get("size", AUTO_MODEL_MAX_BYTES + 1) <= 6_500_000_000]
    return sorted(small_models)[0] if small_models else None


def clean_and_bound(text: str, limit: int) -> tuple[str, bool]:
    text = text.replace("\x00", "").replace("\r\n", "\n")
    # Repeated lines are common in logs and are better collapsed deterministically.
    lines: list[str] = []
    previous = None
    repeats = 0
    for line in text.splitlines():
        if line == previous:
            repeats += 1
            if repeats == 3:
                lines.append("[repeated identical lines omitted]")
            continue
        previous, repeats = line, 0
        lines.append(line)
    text = "\n".join(lines)
    if len(text) <= limit:
        return text, False
    marker = "\n\n[... middle omitted by local-ai input limit ...]\n\n"
    if limit <= len(marker):
        return marker[:limit], True
    remaining = limit - len(marker)
    head = remaining // 2
    tail = remaining - head
    return text[:head] + marker + text[-tail:], True


def preprocess_for_task(task: str, text: str) -> tuple[str, int]:
    """Deterministically remove routine noise from long logs before inference."""
    lines = text.splitlines()
    if task != "summarize-log" or len(lines) < 80:
        return text, 0
    signal = re.compile(
        r"\b(error|exception|traceback|fail(?:ed|ure)?|assert(?:ion)?|warn(?:ing)?|critical|fatal|timeout)\b",
        re.IGNORECASE,
    )
    keep = set(range(min(5, len(lines))))
    keep.update(range(max(0, len(lines) - 5), len(lines)))
    for index, line in enumerate(lines):
        if signal.search(line):
            keep.update(range(max(0, index - 1), min(len(lines), index + 2)))
    if len(keep) >= len(lines):
        return text, 0
    selected: list[str] = []
    previous = -1
    for index in sorted(keep):
        if previous >= 0 and index > previous + 1:
            selected.append(f"[... {index - previous - 1} routine log lines omitted deterministically ...]")
        selected.append(lines[index])
        previous = index
    return "\n".join(selected), len(lines) - len(keep)


def read_input(path: str | None, limit: int) -> tuple[str, str, bool, bool]:
    if path:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as source:
                raw = source.read(MAX_RAW_CHARS + 1)
        except OSError as error:
            raise RuntimeError(f"cannot read {path}: {error}") from error
    elif not sys.stdin.isatty():
        raw = sys.stdin.read(MAX_RAW_CHARS + 1)
    else:
        raise RuntimeError("provide a file argument or pipe input on stdin")
    raw_limited = len(raw) > MAX_RAW_CHARS
    if raw_limited:
        raw = raw[:MAX_RAW_CHARS]
    bounded, truncated = clean_and_bound(raw, limit)
    # Keep the raw body only in process memory long enough to account for what
    # would otherwise have entered the main model.  The bounded value is what
    # reaches Local AI after deterministic preprocessing; neither is persisted.
    return raw, bounded, truncated or raw_limited, raw_limited


def routing_input_chars(path: str | None, supplied_chars: int | None) -> int:
    """Count a candidate source without emitting or persisting it."""
    if supplied_chars is not None:
        return supplied_chars
    if path:
        try:
            return min(len(Path(path).read_text(encoding="utf-8", errors="replace")), MAX_RAW_CHARS)
        except OSError as error:
            raise RuntimeError(f"cannot read {path}: {error}") from error
    if not sys.stdin.isatty():
        return min(len(sys.stdin.read(MAX_RAW_CHARS + 1)), MAX_RAW_CHARS)
    raise RuntimeError("provide --input-chars, a file argument, or pipe input on stdin")


def routing_availability(recorder: TelemetryRecorder, override: str | None) -> str:
    if override:
        return override
    if recorder.state_path is None:
        return "unknown"
    try:
        status = json.loads(recorder.state_path.with_name("local-ai-status.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unknown"
    checked_at = status.get("checked_at")
    try:
        checked = datetime.fromisoformat(str(checked_at).replace("Z", "+00:00"))
        if (datetime.now(UTC) - checked).total_seconds() > 120:
            return "unknown"
    except (TypeError, ValueError):
        return "unknown"
    state = str(status.get("state") or "")
    if state in {"LOCAL_AI_AVAILABLE", "LOCAL_AI_DEGRADED"}:
        return "available"
    return "unavailable" if state else "unknown"


def record_routing_outcome(
    recorder: TelemetryRecorder,
    assessment: dict[str, Any],
    *,
    outcome: str = "auto",
    actual_tokens_avoided: int | None = None,
    model: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    decision = terminal_decision(assessment, outcome)
    decision.update({"id": new_event_id(), "timestamp": utc_now()})
    if actual_tokens_avoided is not None:
        decision["actual_tokens_avoided"] = actual_tokens_avoided
    if model:
        decision["model"] = model
    if reason:
        decision["reason"] = reason
    recorder.routing_decision(decision)
    return decision


def memory_files_found(text: str) -> int:
    """Count materialized public-memory separators without retaining source paths."""
    return len(re.findall(r"^--- BEGIN MEMORY .+ ---$", text, flags=re.MULTILINE))


def record_memory_outcome(
    recorder: TelemetryRecorder,
    *,
    topic: str | None,
    files_found: int,
    decision: str,
    reason: str,
    retrieved_tokens: int = 0,
    sent_to_local_ai_tokens: int = 0,
    sent_to_primary_tokens: int = 0,
    available: bool | None = None,
    model: str | None = None,
    expected_tokens_saved: int | None = None,
    minimum_input_tokens: int | None = None,
    minimum_expected_saved_tokens: int | None = None,
    token_count_method: str | None = None,
    estimated: bool | None = None,
    memory_overload: bool = False,
    canonical_source_conflict: bool = False,
) -> dict[str, Any]:
    """Record only countable memory-routing metadata, never its text or paths."""
    inventory = public_memory_inventory(PROJECT_ROOT)
    result: dict[str, Any] = {
        "id": new_event_id(),
        "timestamp": utc_now(),
        "topic": topic or "unspecified",
        "files_found": max(0, files_found),
        "memory_tokens_available": int(inventory["repository_memory_tokens_available"]),
        "memory_tokens_retrieved": max(0, retrieved_tokens),
        "memory_tokens_sent_to_local_ai": max(0, sent_to_local_ai_tokens),
        "memory_tokens_sent_to_primary_model": max(0, sent_to_primary_tokens),
        "decision": decision,
        "reason": reason,
        "memory_overload": memory_overload,
        "canonical_source_conflict": canonical_source_conflict,
        "token_count_method": token_count_method or str(inventory["token_count_method"]),
        "estimated": bool(inventory["estimated"] if estimated is None else estimated),
    }
    if decision == "MEMORY_LOCAL_AI_USED":
        result["memory_tokens_avoided"] = retrieved_tokens - sent_to_primary_tokens
    if available is not None:
        result["available"] = available
    if model:
        result["model"] = model
    for key, value in (
        ("expected_tokens_saved", expected_tokens_saved),
        ("minimum_input_tokens", minimum_input_tokens),
        ("minimum_expected_saved_tokens", minimum_expected_saved_tokens),
    ):
        if value is not None:
            result[key] = value
    recorder.memory_decision(result)
    return result


def run_memory_audit(args: argparse.Namespace) -> int:
    """Persist a reproducible observable-startup snapshot; no model or history access."""
    recorder = TelemetryRecorder(private_telemetry_path(ROOT))
    startup = instruction_chain(PROJECT_ROOT, args.cwd)
    inventory = public_memory_inventory(PROJECT_ROOT)
    recorder.startup_context(startup, int(inventory["repository_memory_tokens_available"]))
    print(json.dumps({"startup_context": startup, "memory_corpus": inventory}, ensure_ascii=False, indent=2))
    return 0


def run_memory_route(args: argparse.Namespace) -> int:
    """Record a deterministic skip/direct/fallback memory decision without inference."""
    recorder = TelemetryRecorder(private_telemetry_path(ROOT))
    status = routing_availability(recorder, args.availability)
    retrieved = max(0, args.retrieved_tokens)
    direct_budget = int(TASK_PROFILES["summarize-memory"].min_input_tokens)
    if args.outcome == "skipped":
        result = record_memory_outcome(
            recorder, topic=args.topic, files_found=args.files_found,
            decision="MEMORY_RETRIEVAL_SKIPPED", reason=args.reason or "no_repository_history_required",
            available=status == "available",
        )
    elif args.outcome == "unavailable":
        result = record_memory_outcome(
            recorder, topic=args.topic, files_found=args.files_found,
            decision="MEMORY_LOCAL_AI_UNAVAILABLE", reason=args.reason or "local_ai_unavailable",
            retrieved_tokens=retrieved, available=False,
        )
    elif args.outcome == "direct":
        result = record_memory_outcome(
            recorder, topic=args.topic, files_found=args.files_found,
            decision="MEMORY_RETRIEVED_DIRECT", reason=args.reason or (
                "canonical_source_preferred" if args.canonical_conflict else "retrieved_memory_within_direct_budget"
            ),
            retrieved_tokens=retrieved, sent_to_primary_tokens=retrieved, available=status == "available",
            memory_overload=retrieved > direct_budget,
            canonical_source_conflict=args.canonical_conflict,
        )
    else:
        result = record_memory_outcome(
            recorder, topic=args.topic, files_found=args.files_found,
            decision="MEMORY_LOCAL_AI_NOT_BENEFICIAL", reason=args.reason or "memory_retrieval_not_compressible",
            retrieved_tokens=retrieved, available=status == "available",
        )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def run_route(args: argparse.Namespace) -> int:
    """Record a skipped decision or preview a candidate with no inference call."""
    recorder = TelemetryRecorder(private_telemetry_path(ROOT))
    chars = routing_input_chars(args.input_file, args.input_chars)
    availability = routing_availability(recorder, args.availability)
    assessment = assess_routing(
        args.task,
        chars,
        availability=availability,
        deterministic_sufficient=args.deterministic_sufficient,
        compressibility=args.compressibility,
    )
    # An eligibility result is intentionally only a preview: the following
    # helper call records LOCAL_AI_USED.  Terminal skips are recorded here.
    should_record = args.outcome != "auto" or assessment["decision"] != "LOCAL_AI_ELIGIBLE"
    result = terminal_decision(assessment, args.outcome)
    if should_record:
        result = record_routing_outcome(recorder, assessment, outcome=args.outcome)
        result["recorded"] = True
    else:
        result["recorded"] = False
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def prompt_for(task: str) -> str:
    path = PROMPTS / f"{task}.md"
    if not path.is_file():
        available = ", ".join(sorted(p.stem for p in PROMPTS.glob("*.md")))
        raise RuntimeError(f"unknown task '{task}'; available: {available}")
    return path.read_text(encoding="utf-8")


def validate_structured_response(task: str, parsed: Any) -> None:
    """Reject syntactically valid but unusable local-model responses."""
    if not isinstance(parsed, dict):
        raise RuntimeError("model returned JSON but not an object")
    required = TASK_REQUIRED_FIELDS.get(task)
    if not required:
        return
    missing = sorted(required.difference(parsed))
    non_lists = sorted(key for key in TASK_LIST_FIELDS[task] if not isinstance(parsed.get(key), list))
    if missing or non_lists:
        detail = ', '.join(missing or non_lists)
        raise RuntimeError(f"{task} response did not follow the required schema ({detail})")


def gpu_snapshot() -> dict[str, Any] | None:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    result = subprocess.run(
        [executable, "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=False,
    )
    return {"available": result.returncode == 0, "sample": result.stdout.strip() or result.stderr.strip()}


class RevalidationBudget:
    def __init__(self) -> None:
        self.used = False

    def consume(self) -> bool:
        if self.used:
            return False
        self.used = True
        return True


def revalidate_once(settings: dict[str, Any]) -> bool:
    command = os.getenv("LOCAL_AI_PREFLIGHT_COMMAND") or settings.get("preflight_command")
    if not command:
        return False
    try:
        result = subprocess.run(
            [str(command), "--json", "--revalidate"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return False
    return result.returncode == 0 and payload.get("state") in {"LOCAL_AI_AVAILABLE", "LOCAL_AI_DEGRADED"}


def request_with_one_revalidation(
    endpoint: str,
    path: str,
    payload: dict[str, Any] | None,
    settings: dict[str, Any],
    budget: RevalidationBudget,
) -> Any:
    try:
        return request(endpoint, path, payload)
    except RuntimeError:
        if not budget.consume() or not revalidate_once(settings):
            raise
        return request(endpoint, path, payload)


def count_openai_context_tokens(text: str, settings: dict[str, Any]) -> tuple[int, str]:
    """Use a locally installed tokenizer when possible; label all fallbacks as estimates."""
    tokenizer = str(settings.get("openai_tokenizer") or os.getenv("LOCAL_AI_OPENAI_TOKENIZER") or "o200k_base")
    try:
        import tiktoken  # type: ignore[import-not-found]

        return len(tiktoken.get_encoding(tokenizer).encode(text)), f"tiktoken:{tokenizer}"
    except (ImportError, KeyError, ValueError):
        return math.ceil(len(text.encode("utf-8")) / 4), "estimated_utf8_bytes_div_4"


def command_status(endpoint: str, settings: dict[str, Any]) -> int:
    result: dict[str, Any] = {
        "endpoint": endpoint,
        "enabled": local_ai_enabled(settings),
        "configured_model": configured_model(None, settings),
        "ollama_on_path": shutil.which("ollama") is not None,
        "nvidia_smi_on_path": shutil.which("nvidia-smi") is not None,
        "cuda_visible": Path("/dev/nvidiactl").exists(),
        "gpu": gpu_snapshot(),
    }
    try:
        result["models"] = [{"name": m["name"], "size_bytes": m.get("size")} for m in tags(endpoint)]
        result["running_models"] = request(endpoint, "/api/ps").get("models", [])
        result["ollama_reachable"] = True
    except RuntimeError as error:
        result["ollama_reachable"] = False
        result["ollama_error"] = str(error)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def run_analysis(args: argparse.Namespace) -> int:
    settings = user_settings()
    if not local_ai_enabled(settings):
        raise RuntimeError("Local AI is disabled by LOCAL_AI_ENABLED=0 or machine configuration")
    instruction = prompt_for(args.task)
    raw_text, text, truncated, raw_limited = read_input(args.input_file, args.input_max_chars)
    model_text, deterministic_omitted_lines = preprocess_for_task(args.task, text)
    memory_task = args.task == "summarize-memory"
    memory_topic = getattr(args, "memory_topic", None)
    source_files = (
        getattr(args, "memory_files_found", None)
        if memory_task and getattr(args, "memory_files_found", None) is not None
        else memory_files_found(raw_text) if memory_task else 0
    )
    context_input_tokens, token_method = count_openai_context_tokens(raw_text, settings)
    model_input_tokens, _ = count_openai_context_tokens(model_text, settings)
    endpoint = resolved_endpoint(args.endpoint, settings)
    retry_budget = RevalidationBudget()
    request_call = lambda target, path, payload=None: request_with_one_revalidation(
        target, path, payload, settings, retry_budget,
    )
    recorder = TelemetryRecorder(private_telemetry_path(ROOT))
    routing_recorded = False
    try:
        models = tags(endpoint, request_call)
    except Exception as error:
        unavailable = assess_routing(args.task, len(raw_text), availability="unavailable")
        record_routing_outcome(recorder, unavailable)
        if memory_task:
            record_memory_outcome(
                recorder, topic=memory_topic, files_found=source_files,
                decision="MEMORY_LOCAL_AI_UNAVAILABLE", reason="local_ai_unavailable",
                retrieved_tokens=context_input_tokens, available=False,
                token_count_method=token_method,
            )
        routing_recorded = True
        recorder.finished({
            "id": new_event_id(),
            "started_at": utc_now(),
            "finished_at": utc_now(),
            "task": args.task,
            "model": configured_model(args.model, settings) or "unknown",
            "endpoint": endpoint,
            "status": "failed",
            "error_type": type(error).__name__,
        })
        raise
    model = configured_model(args.model, settings) or select_model(models)
    if not model:
        unavailable = assess_routing(args.task, len(raw_text), availability="unavailable")
        unavailable["reason"] = "local_model_unavailable"
        record_routing_outcome(recorder, unavailable)
        if memory_task:
            record_memory_outcome(
                recorder, topic=memory_topic, files_found=source_files,
                decision="MEMORY_LOCAL_AI_UNAVAILABLE", reason="local_model_unavailable",
                retrieved_tokens=context_input_tokens, available=False,
                token_count_method=token_method,
            )
        raise RuntimeError(
            "no safe default model found. Set LOCAL_AI_MODEL after running `local-ai status` and `local-ai benchmark --model <name>`."
        )
    routing_assessment = assess_routing(args.task, len(raw_text), availability="available")
    prompt = (
        "You are a non-authoritative local first-pass assistant. "
        "Return concise valid JSON only: no Markdown fences, no prose outside JSON. "
        f"Keep the response below {args.max_output_chars} characters.\n\n"
        f"TASK INSTRUCTIONS:\n{instruction}\n\n"
        f"INPUT (truncated={str(truncated).lower()}, raw_limit_hit={str(raw_limited).lower()}, "
        f"routine_lines_omitted={deterministic_omitted_lines}):\n{model_text}"
    )
    before_gpu = gpu_snapshot()
    event: dict[str, Any] = {
        "id": new_event_id(),
        "started_at": utc_now(),
        "task": args.task,
        "model": model,
        "endpoint": endpoint,
        "status": "running",
        "chat_id": current_chat_id(),
        "chat_name": current_chat_name(),
        "context_input_chars": len(raw_text),
        "context_input_bytes": len(raw_text.encode("utf-8")),
        "context_input_tokens": context_input_tokens,
        "token_count_method": token_method,
        "input_truncated": truncated,
        "deterministic_omitted_lines": deterministic_omitted_lines,
        "model_input_chars": len(model_text),
        "context_replacement": True,
    }
    recorder.started(event)
    sampler = RemoteGpuSampler(
        settings.get("gpu_probe"),
        float(settings.get("gpu_sample_interval_seconds", 1.5)),
        on_sample=lambda sample: recorder.sampled(str(event["id"]), sample),
    )
    sampler.start()
    started = time.monotonic()
    try:
        responses: list[dict[str, Any]] = []
        parsed: Any = None
        output = ""
        for attempt in range(2):
            attempt_prompt = prompt if attempt == 0 else (
                "Your previous response was invalid or too long. Return the same schema as compact valid JSON. "
                "Use at most two concise entries in each list and omit routine noise.\n\n" + prompt
            )
            response = request_call(endpoint, "/api/generate", {
                "model": model,
                "prompt": attempt_prompt,
                "stream": False,
                "format": response_format(args.task, compact=attempt == 1),
                "options": {
                    "num_ctx": args.context_tokens,
                    "num_predict": max(args.output_tokens, 1200) if attempt == 1 else args.output_tokens,
                    "temperature": 0.1,
                },
            })
            responses.append(response)
            output = str(response.get("response", "")).strip()
            if len(output) > args.max_output_chars:
                output = output[:args.max_output_chars]
                print("local-ai: output truncated to configured limit", file=sys.stderr)
            try:
                parsed = json.loads(output)
                validate_structured_response(args.task, parsed)
                break
            except (json.JSONDecodeError, RuntimeError):
                if attempt == 1:
                    raise
                print("local-ai: retrying one compact structured response", file=sys.stderr)
        elapsed = time.monotonic() - started
        eval_count = sum(int(item.get("eval_count") or 0) for item in responses)
        eval_duration = sum(int(item.get("eval_duration") or 0) for item in responses)
        prompt_eval_count = sum(int(item.get("prompt_eval_count") or 0) for item in responses)
        token_rate = round(eval_count / (eval_duration / 1_000_000_000), 2) if eval_count and eval_duration else None
        context_output_tokens, _ = count_openai_context_tokens(output, settings)
        event.update({
            "status": "success",
            "finished_at": utc_now(),
            "duration_seconds": round(elapsed, 3),
            "local_input_tokens": prompt_eval_count,
            "local_output_tokens": eval_count,
            "local_attempts": len(responses),
            "tokens_per_second": token_rate,
            "context_output_chars": len(output),
            "context_output_bytes": len(output.encode("utf-8")),
            "context_output_tokens": context_output_tokens,
            # API/tool-envelope overhead is model- and transport-dependent and is
            # not measurable from this helper. Keep it explicit rather than
            # presenting a fabricated exact value. The result is therefore an
            # estimated content-context delta, not an official billing metric.
            "context_overhead_tokens": 0,
            "context_overhead_method": "not_measured",
            "context_savings_estimated": True,
            "openai_context_tokens_avoided": context_input_tokens - context_output_tokens,
            "context_reduction_percent": round(
                ((context_input_tokens - context_output_tokens) / context_input_tokens) * 100 if context_input_tokens else 0,
                1,
            ),
        })
        actual_avoided = int(event["openai_context_tokens_avoided"])
        minimum = int(routing_assessment.get("minimum_expected_saved_tokens") or 0)
        outcome = "used" if (
            routing_assessment.get("decision") == "LOCAL_AI_ELIGIBLE"
            and actual_avoided >= minimum
        ) else "unnecessary"
        record_routing_outcome(
            recorder,
            routing_assessment,
            outcome=outcome,
            actual_tokens_avoided=actual_avoided,
            model=model,
        )
        if memory_task:
            profile = TASK_PROFILES["summarize-memory"]
            record_memory_outcome(
                recorder,
                topic=memory_topic,
                files_found=source_files,
                decision="MEMORY_LOCAL_AI_USED" if outcome == "used" else "MEMORY_LOCAL_AI_NOT_BENEFICIAL",
                reason="memory_compressed_locally" if outcome == "used" else "memory_compression_below_threshold",
                retrieved_tokens=context_input_tokens,
                sent_to_local_ai_tokens=model_input_tokens,
                sent_to_primary_tokens=context_output_tokens,
                available=True,
                model=model,
                expected_tokens_saved=int(routing_assessment.get("expected_tokens_saved") or 0),
                minimum_input_tokens=profile.min_input_tokens,
                minimum_expected_saved_tokens=profile.min_expected_saved_tokens,
                token_count_method=token_method,
            )
        routing_recorded = True
        print(
            f"local-ai: model={model} elapsed={elapsed:.2f}s tokens_per_second={token_rate} "
            f"input_truncated={truncated} telemetry_id={event['id']} gpu_before={before_gpu} gpu_after={gpu_snapshot()}",
            file=sys.stderr,
        )
        print(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        event.update({
            "status": "failed",
            "finished_at": utc_now(),
            "duration_seconds": round(time.monotonic() - started, 3),
            "error_type": type(error).__name__,
        })
        if not routing_recorded:
            record_routing_outcome(
                recorder,
                routing_assessment,
                outcome="used",
                model=model,
                reason="local_ai_call_failed",
            )
            if memory_task:
                record_memory_outcome(
                    recorder, topic=memory_topic, files_found=source_files,
                    decision="MEMORY_LOCAL_AI_UNAVAILABLE", reason="local_ai_call_failed",
                    retrieved_tokens=context_input_tokens, sent_to_local_ai_tokens=model_input_tokens,
                    available=False, model=model, token_count_method=token_method,
                )
            routing_recorded = True
        raise
    finally:
        event.update(sampler.stop(model))
        recorder.finished(event)


def benchmark_cases() -> list[tuple[str, str]]:
    """Fixed, non-sensitive suite; its text is never written to telemetry."""
    return [
        ("review-diff", """diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,7 +10,8 @@ export async function updateUser(request: Request) {
-  if (user.id !== request.user.id) return forbidden();
-  return users.update(user.id, request.body);
+  const input = await request.json();
+  if (input.role) user.role = input.role;
+  return users.update(user.id, input);
}"""),
        ("analyze-tests", """FAIL tests/auth.test.ts > rejects a user changing another user's role
AssertionError: expected 200 to equal 403
  at tests/auth.test.ts:88:21
WARN cache test uses an in-memory adapter
1 failed, 42 passed"""),
        ("inspect-files", """src/auth.ts
export async function updateUser(request) { return users.update(request.params.id, await request.json()); }

tests/auth.test.ts
it('rejects cross-user role changes', async () => expect(await updateUser(otherUser)).toHaveStatus(403));"""),
        ("summarize-log", """2026-08-16T12:00:01Z api ERROR TypeError: Cannot read properties of undefined (reading 'id')
    at updateUser (src/auth.ts:18:42)
2026-08-16T12:00:02Z api WARN retrying database write once
2026-08-16T12:00:03Z api ERROR request_id=abc123 status=500"""),
    ]


def benchmark(args: argparse.Namespace) -> int:
    """Run a compact, fixed quality/performance suite without retaining its texts."""
    settings = user_settings()
    if not local_ai_enabled(settings):
        raise RuntimeError("Local AI is disabled by LOCAL_AI_ENABLED=0 or machine configuration")
    endpoint = resolved_endpoint(args.endpoint, settings)
    retry_budget = RevalidationBudget()
    request_call = lambda target, path, payload=None: request_with_one_revalidation(
        target, path, payload, settings, retry_budget,
    )
    models = tags(endpoint, request_call)
    model = configured_model(args.model, settings) or select_model(models)
    if not model:
        raise RuntimeError("choose --model explicitly; no safe default model is installed")
    recorder = TelemetryRecorder(private_telemetry_path(ROOT))
    results: list[dict[str, Any]] = []
    for task, source in benchmark_cases():
        context_input_tokens, token_method = count_openai_context_tokens(source, settings)
        event: dict[str, Any] = {
            "id": new_event_id(), "started_at": utc_now(), "task": f"benchmark:{task}",
            "model": model, "endpoint": endpoint, "status": "running", "chat_id": current_chat_id(),
            "chat_name": current_chat_name(),
            "context_input_chars": len(source), "context_input_bytes": len(source.encode("utf-8")),
            "context_input_tokens": context_input_tokens, "token_count_method": token_method,
            "context_replacement": False,
        }
        recorder.started(event)
        sampler = RemoteGpuSampler(
            settings.get("gpu_probe"),
            float(settings.get("gpu_sample_interval_seconds", 1.5)),
            on_sample=lambda sample, event_id=str(event["id"]): recorder.sampled(event_id, sample),
        )
        sampler.start()
        memory_before = _mem_available_kib()
        started = time.monotonic()
        try:
            prompt = (
                "You are a non-authoritative local first-pass assistant. Return concise valid JSON only: "
                "no Markdown fences or prose outside JSON.\n\n"
                f"TASK INSTRUCTIONS:\n{prompt_for(task)}\n\nINPUT:\n{source}"
            )
            response = request_call(endpoint, "/api/generate", {
                "model": model, "prompt": prompt, "stream": False, "format": "json",
                "options": {"num_ctx": args.context_tokens, "num_predict": args.benchmark_output_tokens, "temperature": 0},
            })
            output = str(response.get("response", "")).strip()
            parsed = json.loads(output)
            validate_structured_response(task, parsed)
            elapsed = time.monotonic() - started
            eval_count, eval_duration = response.get("eval_count"), response.get("eval_duration")
            token_rate = round(eval_count / (eval_duration / 1_000_000_000), 2) if isinstance(eval_count, int) and eval_duration else None
            context_output_tokens, _ = count_openai_context_tokens(output, settings)
            event.update({
                "status": "success", "finished_at": utc_now(), "duration_seconds": round(elapsed, 3),
                "local_input_tokens": response.get("prompt_eval_count"), "local_output_tokens": eval_count,
                "tokens_per_second": token_rate, "context_output_chars": len(output),
                "context_output_bytes": len(output.encode("utf-8")), "context_output_tokens": context_output_tokens,
                "context_overhead_tokens": 0, "context_overhead_method": "not_applicable",
                "context_savings_estimated": False, "openai_context_tokens_avoided": 0,
                "context_reduction_percent": 0,
            })
            results.append({"task": task, "status": "success", "latency_seconds": round(elapsed, 3), "tokens_per_second": token_rate, "eval_tokens": eval_count})
        except Exception as error:
            event.update({"status": "failed", "finished_at": utc_now(), "duration_seconds": round(time.monotonic() - started, 3), "error_type": type(error).__name__})
            results.append({"task": task, "status": "failed", "error_type": type(error).__name__})
        finally:
            event.update(sampler.stop(model))
            event["host_ram_available_kib_before"] = memory_before
            event["host_ram_available_kib_after"] = _mem_available_kib()
            recorder.finished(event)
            results[-1].update({key: event.get(key) for key in ("gpu_peak_percent", "vram_peak_mib", "gpu_power_peak_watts", "processor", "cpu_offload_detected")})
    successful = [item for item in results if item["status"] == "success"]
    eval_tokens = sum(int(item.get("eval_tokens") or 0) for item in successful)
    elapsed_total = sum(float(item.get("latency_seconds") or 0) for item in successful)
    gpu_peaks = [item.get("gpu_peak_percent") for item in results if isinstance(item.get("gpu_peak_percent"), (int, float))]
    vram_peaks = [item.get("vram_peak_mib") for item in results if isinstance(item.get("vram_peak_mib"), (int, float))]
    print(json.dumps({
        "suite": "local-ai-bounded-v1", "model": model, "endpoint": endpoint,
        "cases": len(results), "successful_cases": len(successful),
        "quality_score_percent": round(len(successful) / len(results) * 100, 1) if results else 0,
        "aggregate_tokens_per_second": round(eval_tokens / elapsed_total, 2) if elapsed_total else None,
        "gpu_peak_percent": max(gpu_peaks) if gpu_peaks else None,
        "vram_peak_mib": max(vram_peaks) if vram_peaks else None,
        "cpu_offload_detected": any(item.get("cpu_offload_detected") is True for item in results),
        "results": results,
    }, ensure_ascii=False, indent=2))
    return 0


def _mem_available_kib() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--endpoint", help="Ollama endpoint; overrides LOCAL_AI_ENDPOINT and user configuration")
    common.add_argument("--model", help="Ollama model; otherwise LOCAL_AI_MODEL or a conservative auto-selection")
    common.add_argument("--context-tokens", type=positive_int, default=int(os.getenv("LOCAL_AI_CONTEXT_TOKENS", "4096")))
    main = argparse.ArgumentParser(description=__doc__)
    subs = main.add_subparsers(dest="command", required=True)
    subs.add_parser("status", parents=[common], help="report Ollama, models and visible GPU state")
    route = subs.add_parser("route", parents=[common], help="classify and record a Local AI routing outcome without inference")
    route.add_argument("task", choices=sorted(TASK_PROFILES), help="candidate helper task")
    route.add_argument("input_file", nargs="?", help="candidate input file; omit to read stdin")
    route.add_argument("--input-chars", type=positive_int, help="metadata-only input size when the source must not be read")
    route.add_argument("--availability", choices=("available", "unavailable", "unknown"), help="override the recorded preflight state")
    route.add_argument("--compressibility", choices=("high", "medium", "low"), help="override the task profile's expected compressibility")
    route.add_argument("--deterministic-sufficient", action="store_true", help="record that a deterministic tool resolves the task")
    route.add_argument("--outcome", choices=("auto", "skipped", "used", "unnecessary"), default="auto")
    route.set_defaults(func=run_route)
    memory_audit = subs.add_parser("memory-audit", help="measure observable startup context and public memory metadata")
    memory_audit.add_argument("--cwd", type=Path, help="include nested instruction files down to this directory")
    memory_audit.set_defaults(func=run_memory_audit)
    memory_route = subs.add_parser("memory-route", help="record a memory retrieval decision without inference")
    memory_route.add_argument("topic", help="logical topic from the canonical memory index")
    memory_route.add_argument("--files-found", type=nonnegative_int, default=0)
    memory_route.add_argument("--retrieved-tokens", type=nonnegative_int, default=0)
    memory_route.add_argument("--availability", choices=("available", "unavailable", "unknown"), help="override recorded preflight state")
    memory_route.add_argument("--outcome", choices=("skipped", "direct", "unavailable", "not-beneficial"), default="skipped")
    memory_route.add_argument("--reason", help="bounded decision reason; never include source text")
    memory_route.add_argument("--canonical-conflict", action="store_true", help="record that current canonical documentation won over stale memory")
    memory_route.set_defaults(func=run_memory_route)
    bench = subs.add_parser("benchmark", parents=[common], help="run a bounded four-case structured-output benchmark")
    bench.add_argument("--benchmark-output-tokens", type=positive_int, default=420)
    bench.set_defaults(func=benchmark)
    for task in sorted(p.stem for p in PROMPTS.glob("*.md")):
        sub = subs.add_parser(task, parents=[common], help=f"run {task}")
        sub.add_argument("input_file", nargs="?", help="input file; omit to read stdin")
        default_input = "24000" if task == "summarize-memory" else "12000"
        sub.add_argument("--input-max-chars", type=positive_int, default=int(os.getenv("LOCAL_AI_MAX_INPUT_CHARS", default_input)))
        sub.add_argument("--max-output-chars", type=positive_int, default=int(os.getenv("LOCAL_AI_MAX_OUTPUT_CHARS", "6000")))
        sub.add_argument("--output-tokens", type=positive_int, default=int(os.getenv("LOCAL_AI_OUTPUT_TOKENS", "700")))
        sub.add_argument("--memory-topic", help="logical public-memory topic; used only for summarize-memory telemetry")
        sub.add_argument("--memory-files-found", type=nonnegative_int, help="selected files count when input was not materialized by memory-context")
        sub.set_defaults(func=run_analysis, task=task)
    return main


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "status":
            settings = user_settings()
            return command_status(resolved_endpoint(args.endpoint, settings), settings)
        return args.func(args)
    except RuntimeError as error:
        print(f"local-ai: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
