#!/usr/bin/env python3
"""Compress eligible large Codex tool output through the canonical Local AI MCP.

The hook is deliberately conservative: it handles only supported PostToolUse
events, ignores private-history and credential-bearing commands, redacts common
secret/identifier shapes in memory, and falls back to the original tool result
whenever routing or inference cannot produce a bounded structured result.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


TASK_MIN_CHARS = {
    "analyze-tests": 3_600,
    "classify-error": 3_200,
    "inspect-files": 4_800,
    "review-diff": 4_800,
    "summarize-document": 4_800,
    "summarize-log": 3_600,
}
DETERMINISTIC_POSTPROCESS_MIN_CHARS = 12_000
MAX_HOOK_INPUT_CHARS = 2_000_000
MAX_MODEL_CONTEXT_CHARS = 8_000

SENSITIVE_COMMAND_RE = re.compile(
    r"(?:^|[\s/\\])(?:\.env(?:\.|\s|$)|secrets\.ya?ml(?:\s|$)|\.storage[/\\](?:auth|core\.config_entries)|"
    r"\.local-secrets(?:[/\\]|$)|\.ssh[/\\]|cookies?(?:\.|[/\\])|"
    r"(?:private|id_[re]sa|id_ed25519)[_-]?key|\.codex[/\\]sessions|"
    r"\.agent-history[/\\]turns\.jsonl)",
    re.IGNORECASE,
)
PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----",
    re.IGNORECASE,
)
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?im)([\"']?\b(?:password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?token|token|"
    r"client[_-]?secret|secret|api[_-]?key|authorization|cookie|session(?:[_-]?(?:id|token))?)"
    r"\b[\"']?\s*[:=]\s*)(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s,;}\]]+)",
)
TOKEN_RE = re.compile(r"\b(?:ghp_|github_pat_|sk-|xox[baprs]-|eyJ)[A-Za-z0-9._-]{12,}\b")


def session_state_path() -> Path:
    configured = os.getenv("LOCAL_AI_HOOK_SESSION_STATE")
    if configured:
        return Path(configured).expanduser()
    state_home = Path(os.getenv("XDG_STATE_HOME") or (Path.home() / ".local" / "state"))
    return state_home / "codex-local-ai" / "post-tool-routing-sessions.json"


def session_key(payload: dict[str, Any]) -> str | None:
    value = payload.get("session_id") or payload.get("transcript_path")
    if not isinstance(value, str) or not value:
        return None
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def status_already_checked(payload: dict[str, Any]) -> bool:
    key = session_key(payload)
    if key is None:
        return False
    try:
        value = json.loads(session_state_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return key in value.get("sessions", {}) if isinstance(value, dict) else False


def remember_status_check(payload: dict[str, Any], state: str) -> None:
    key = session_key(payload)
    if key is None:
        return
    target = session_state_path()
    try:
        current = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        current = {}
    sessions = current.get("sessions", {}) if isinstance(current, dict) else {}
    if not isinstance(sessions, dict):
        sessions = {}
    sessions[key] = {"state": state}
    sessions = dict(list(sessions.items())[-200:])
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"sessions": sessions}, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o640)
    os.replace(temporary, target)


def runtime_dir() -> Path:
    configured = os.getenv("LOCAL_AI_MCP_RUNTIME_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".local" / "share" / "codex-local-ai" / "current"


def extract_command(payload: dict[str, Any]) -> str:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return ""
    command = tool_input.get("command")
    return command if isinstance(command, str) else ""


def extract_response(payload: dict[str, Any]) -> str:
    response = payload.get("tool_response")
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        for key in ("output", "stdout", "content", "text"):
            value = response.get(key)
            if isinstance(value, str):
                return value
    if response is None:
        return ""
    try:
        return json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""


def deterministic_source(command: str) -> bool:
    lowered = command.lower()
    if re.search(r"\b(?:sed|cat|head|tail|pytest|unittest|journalctl)\b|git\s+(?:diff|show)", lowered):
        return False
    return bool(
        re.search(r"\brg\b|\bfind\b|\bwc\b|git\s+(?:status|log)\b|\bdocker\s+ps\b|\bjq\b", lowered)
    )


def deterministic_sufficient(command: str, response: str) -> bool:
    """Return true only when deterministic processing also finishes interpretation.

    Deterministic collection remains the first step. A large textual inventory,
    search result, or listing can still benefit from bounded local compression;
    scalar aggregates and already-structured JSON remain final.
    """
    if not deterministic_source(command):
        return False
    lowered = command.lower()
    if re.search(r"\bwc\b", lowered):
        return True
    if re.search(r"\bjq\b", lowered):
        try:
            parsed = json.loads(response)
        except (TypeError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, (dict, list)):
            return True
    return len(response) < DETERMINISTIC_POSTPROCESS_MIN_CHARS


def classify_task(command: str, response: str) -> tuple[str, bool] | None:
    lowered = command.lower()
    if not command or SENSITIVE_COMMAND_RE.search(command):
        return None
    if re.search(r"\b(?:pytest|unittest)\b|node\s+--test|npm\s+test|make\s+(?:test|validate)|check_config", lowered):
        task = "analyze-tests"
    elif re.search(r"git\s+(?:diff|show\s+--patch)\b|review-diff", lowered):
        task = "review-diff"
    elif re.search(r"\b(?:journalctl|dmesg)\b|docker\s+logs\b|(?:^|[/_-])logs?(?:[/_.\s]|$)", lowered):
        task = "summarize-log"
    elif re.search(r"\.(?:md|rst|txt)\b|\bagents\.md\b|\breadme\b", lowered) and re.search(
        r"\b(?:sed|cat|head|tail|awk|rg)\b", lowered
    ):
        task = "summarize-document"
    elif deterministic_source(command):
        task = "inspect-files"
    elif re.search(r"\b(?:sed|cat|head|tail|awk)\b|\brg\b", lowered):
        task = "inspect-files"
    elif len(response) >= TASK_MIN_CHARS["classify-error"] and len(re.findall(r"\b(?:error|exception|traceback|failed)\b", response, re.I)) >= 4:
        task = "classify-error"
    else:
        return None
    return task, deterministic_sufficient(command, response)


def redact_for_local_ai(text: str) -> tuple[str, int]:
    redactions = 0

    def replace(pattern: re.Pattern[str], value: str, source: str) -> str:
        nonlocal redactions
        updated, count = pattern.subn(value, source)
        redactions += count
        return updated

    cleaned = text[:MAX_HOOK_INPUT_CHARS]
    cleaned = replace(PRIVATE_KEY_RE, "<SECRET_REDACTED>", cleaned)
    cleaned = replace(SECRET_ASSIGNMENT_RE, r"\1<SECRET_REDACTED>", cleaned)
    cleaned = replace(TOKEN_RE, "<SECRET_REDACTED>", cleaned)
    return cleaned, redactions


class McpProcess:
    def __init__(self, root: Path | None = None) -> None:
        base = root or runtime_dir()
        server = base / "mcp_server.py"
        if not server.is_file():
            raise RuntimeError("local_ai_mcp_runtime_unavailable")
        self.process = subprocess.Popen(
            [sys.executable, str(server)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=base,
            env={**os.environ, "LOCAL_AI_INVOCATION_SOURCE": "mcp"},
        )
        self.request_id = 0

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("local_ai_mcp_stdio_unavailable")
        self.request_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("local_ai_mcp_no_response")
        response = json.loads(line)
        result = response.get("result")
        if not isinstance(result, dict) or result.get("isError") is True:
            raise RuntimeError("local_ai_mcp_call_failed")
        structured = result.get("structuredContent")
        if not isinstance(structured, dict):
            raise RuntimeError("local_ai_mcp_invalid_result")
        return structured

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.terminate()


def bounded_result(task: str, compressed: dict[str, Any], redactions: int) -> str:
    result = compressed.get("result")
    job_id = compressed.get("job_id")
    telemetry_recorded = compressed.get("telemetry_recorded") is True
    if not isinstance(result, dict) or not isinstance(job_id, str) or not job_id or not telemetry_recorded:
        raise RuntimeError("local_ai_success_metadata_missing")
    payload = {
        "local_ai_context_replacement": True,
        "task_type": task,
        "redactions_applied": redactions,
        "local_ai": {
            "evaluated": True,
            "eligible": True,
            "job_id": job_id,
            "executed": True,
            "success": True,
            "telemetry_recorded": True,
        },
        "result": result,
        "notice": "Non-authoritative first pass; verify exact code, configuration, security, and production conclusions deterministically.",
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) > MAX_MODEL_CONTEXT_CHARS:
        raise RuntimeError("local_ai_result_exceeds_hook_budget")
    return encoded


def process_hook(
    payload: dict[str, Any],
    mcp_factory: Callable[[], McpProcess] = McpProcess,
) -> dict[str, Any] | None:
    if payload.get("hook_event_name") != "PostToolUse" or payload.get("tool_name") != "Bash":
        return None
    command = extract_command(payload)
    response = extract_response(payload)
    classified = classify_task(command, response)
    if classified is None:
        return None
    task, deterministic = classified
    selected, redactions = redact_for_local_ai(response)
    if len(selected) < TASK_MIN_CHARS[task]:
        return None
    # Never send output containing a recognized secret shape to Local AI. The
    # original result remains available to the primary model as normal fallback.
    if redactions:
        return None

    client = mcp_factory()
    route_arguments = {
        "task_type": task,
        "input_chars": len(selected),
        "compressibility": "high" if task in {"analyze-tests", "classify-error", "summarize-log"} else "medium",
        # The MCP adapter keeps this legacy field name for compatibility. Here
        # it means deterministic *finality*, not merely that preprocessing ran.
        "deterministic_preprocessing_available": deterministic,
    }
    try:
        if not deterministic and not status_already_checked(payload):
            status = client.call("local_ai_status", {})
            remember_status_check(payload, str(status.get("state") or "LOCAL_AI_UNKNOWN"))
        route = client.call(
            "local_ai_route",
            route_arguments,
        )
        if route.get("decision") != "LOCAL_AI_ELIGIBLE":
            return None
        compressed = client.call("local_ai_compress_context", {"task_type": task, "text": selected})
        context = bounded_result(task, compressed, redactions)
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError):
        # Revalidate once so the core can distinguish confirmed infrastructure
        # unavailability. Do not add a synthetic ``skipped`` decision here:
        # run_analysis already records LOCAL_AI_FAILED and adding a second
        # terminal decision would double-count the same attempt as a loss.
        try:
            health = client.call("local_ai_status", {})
            if health.get("available") is not True:
                client.call("local_ai_route", route_arguments)
        except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
        return None
    finally:
        client.close()

    return {
        # PostToolUse continue=false replaces the raw result with this bounded
        # feedback without rejecting a nested code-mode tool promise.
        "continue": False,
        "systemMessage": "Local AI completed a recorded inference job and compacted an eligible large tool result; the raw result was withheld from model context.",
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        },
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    result = process_hook(payload)
    if result is not None:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
