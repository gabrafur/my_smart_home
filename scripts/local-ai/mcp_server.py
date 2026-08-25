#!/usr/bin/env python3
"""Dependency-free MCP adapter for bounded Local AI operations."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from structured_canary import CanaryRuntimeError, extract_payload, public_result


SERVER_NAME = "local-ai-rtx"
SERVER_VERSION = "1.5.0"
CORE_ROOT = Path(__file__).resolve().parent
ANALYSIS_TASKS = (
    "analyze-tests", "classify-error", "inspect-files", "review-diff",
    "summarize-document", "summarize-log", "summarize-memory",
)
MAX_INPUT_CHARS = 2_000_000
MAX_STRUCTURED_SOURCE_CHARS = 12_000


class ToolFailure(RuntimeError):
    pass


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _content(value: Any, *, error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": _json_text(value)}], "structuredContent": value, "isError": error}


class LocalAiMcp:
    def __init__(self, core_root: Path = CORE_ROOT) -> None:
        self.core_root = core_root
        self.helper = core_root / "local-ai.py"
        self.preflight = core_root / "local-ai-preflight.mjs"

    @staticmethod
    def instructions() -> str:
        return (
            "Use context compression only for bounded non-sensitive candidates after deterministic preprocessing. "
            "The separate structured-extraction tool is allowed only for schema-bounded, secret-free parser residuals; "
            "it fails closed to the primary model. Never use Local AI for final production or security decisions."
        )

    @staticmethod
    def tools() -> list[dict[str, Any]]:
        return [
            {
                "name": "local_ai_status",
                "description": "Run the cheap no-inference Local AI preflight.",
                "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
                "annotations": {"readOnlyHint": True},
            },
            {
                "name": "local_ai_route",
                "description": "Apply the deterministic context-compression routing policy to metadata only.",
                "inputSchema": {
                    "type": "object", "additionalProperties": False, "required": ["task_type", "input_chars"],
                    "properties": {
                        "task_type": {"type": "string", "enum": list(ANALYSIS_TASKS)},
                        "input_chars": {"type": "integer", "minimum": 0, "maximum": MAX_INPUT_CHARS},
                        "compressibility": {"type": "string", "enum": ["high", "medium", "low"]},
                        "deterministic_preprocessing_available": {"type": "boolean"},
                        "outcome": {"type": "string", "enum": ["auto", "skipped"]},
                    },
                },
            },
            {
                "name": "local_ai_compress_context",
                "description": "Run one canonical bounded context-compression task.",
                "inputSchema": {
                    "type": "object", "additionalProperties": False, "required": ["task_type", "text"],
                    "properties": {
                        "task_type": {"type": "string", "enum": list(ANALYSIS_TASKS)},
                        "text": {"type": "string", "minLength": 1, "maxLength": MAX_INPUT_CHARS},
                        "memory_topic": {"type": "string", "minLength": 1, "maxLength": 80},
                    },
                },
            },
            {
                "name": "local_ai_structured_extract",
                "description": (
                    "Run the parser-first residual structured-extraction canary. Production eligibility, stable cohort, "
                    "model digest, circuit breaker, schema and source anchors are enforced server-side; fallback means "
                    "continue directly with the primary model."
                ),
                "inputSchema": {
                    "type": "object", "additionalProperties": False, "required": ["source", "schema"],
                    "properties": {
                        "source": {"type": "string", "minLength": 1, "maxLength": MAX_STRUCTURED_SOURCE_CHARS},
                        "schema": {"type": "object"},
                        "task_id": {"type": "string", "minLength": 1, "maxLength": 200},
                        "schema_version": {"type": "string", "enum": ["structured-extraction-v1"]},
                        "logical_origin": {"type": "string", "minLength": 1, "maxLength": 80},
                        "environment_namespace": {"type": "string", "enum": ["production"]},
                        "execution_mode": {"type": "string", "enum": ["production"]},
                        "input_subtype": {"type": "string", "minLength": 1, "maxLength": 80},
                        "critical_fields": {"type": "array", "maxItems": 32, "items": {"type": "string"}},
                        "numeric_fields": {"type": "array", "maxItems": 32, "items": {"type": "string"}},
                        "forbidden_fields": {"type": "array", "maxItems": 32, "items": {"type": "string"}},
                    },
                },
            },
        ]

    def _environment(self) -> dict[str, str]:
        return {**os.environ, "LOCAL_AI_INVOCATION_SOURCE": "mcp"}

    def _run_helper(self, args: list[str], *, input_text: str | None = None, timeout_seconds: int = 220) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.helper), *args], input=input_text, text=True, capture_output=True,
            cwd=self.core_root, env=self._environment(), timeout=timeout_seconds, check=False,
        )

    @staticmethod
    def _stdout_json(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise ToolFailure("local_ai_returned_invalid_json") from error
        if not isinstance(parsed, dict):
            raise ToolFailure("local_ai_returned_invalid_shape")
        return parsed

    def _preflight(self) -> dict[str, Any]:
        if not self.preflight.is_file():
            return {"state": "LOCAL_AI_UNKNOWN", "reason": "preflight_unavailable"}
        try:
            completed = subprocess.run(
                ["node", str(self.preflight), "--json", "--revalidate"], capture_output=True, text=True,
                cwd=self.core_root, env=self._environment(), timeout=75, check=False,
            )
            parsed = json.loads(completed.stdout)
            return parsed if isinstance(parsed, dict) else {"state": "LOCAL_AI_UNKNOWN", "reason": "invalid_preflight"}
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return {"state": "LOCAL_AI_UNKNOWN", "reason": "preflight_unavailable"}

    def status(self) -> dict[str, Any]:
        preflight = self._preflight()
        try:
            status = self._stdout_json(self._run_helper(["status"], timeout_seconds=20))
        except (OSError, subprocess.TimeoutExpired, ToolFailure):
            status = {}
        state = str(preflight.get("state") or "LOCAL_AI_UNKNOWN")
        available = state in {"LOCAL_AI_AVAILABLE", "LOCAL_AI_DEGRADED"}
        if state == "LOCAL_AI_UNKNOWN":
            available = bool(status.get("ollama_reachable")); state = "LOCAL_AI_AVAILABLE" if available else "LOCAL_AI_UNAVAILABLE"
        return {
            "available": available, "state": state,
            "ollama_reachable": bool(status.get("ollama_reachable") or preflight.get("ollama")),
            "model": preflight.get("model") or status.get("configured_model"), "gpu": preflight.get("gpu"),
            "vram_free_mib": preflight.get("vram_free_mib"), "vram_total_mib": preflight.get("vram_total_mib"),
            "telemetry": bool(status.get("telemetry_enabled")), "version": SERVER_VERSION,
        }

    def route(self, values: dict[str, Any]) -> dict[str, Any]:
        task, chars = values.get("task_type"), values.get("input_chars")
        if task not in ANALYSIS_TASKS or not isinstance(chars, int) or isinstance(chars, bool) or not 0 <= chars <= MAX_INPUT_CHARS:
            raise ToolFailure("invalid_route_arguments")
        args = ["route", str(task), "--input-chars", str(chars)]
        if values.get("compressibility") in {"high", "medium", "low"}:
            args.extend(["--compressibility", str(values["compressibility"])])
        if values.get("deterministic_preprocessing_available") is True:
            args.append("--deterministic-sufficient")
        if values.get("outcome") == "skipped":
            args.extend(["--outcome", "skipped"])
        completed = self._run_helper(args, timeout_seconds=20)
        if completed.returncode != 0:
            raise ToolFailure("local_ai_route_failed")
        result = self._stdout_json(completed); result["invocation_source"] = "mcp"
        return result

    def compress(self, values: dict[str, Any]) -> dict[str, Any]:
        task, source = values.get("task_type"), values.get("text")
        if task not in ANALYSIS_TASKS or not isinstance(source, str) or not source or len(source) > MAX_INPUT_CHARS:
            raise ToolFailure("invalid_compression_arguments")
        args = [str(task)]
        if task == "summarize-memory":
            topic = values.get("memory_topic")
            if not isinstance(topic, str) or not topic.strip() or len(topic) > 80:
                raise ToolFailure("memory_topic_required_for_summarize_memory")
            args.extend(["--memory-topic", topic.strip()])
        try:
            completed = self._run_helper(args, input_text=source)
        except subprocess.TimeoutExpired as error:
            raise ToolFailure("local_ai_timeout") from error
        if completed.returncode != 0:
            raise ToolFailure("local_ai_inference_failed")
        result = self._stdout_json(completed)
        telemetry_id = re.search(r"\btelemetry_id=([0-9a-f-]{36})\b", completed.stderr)
        return {"result": result, "job_id": telemetry_id.group(1) if telemetry_id else None, "invocation_source": "mcp", "telemetry_recorded": telemetry_id is not None}

    def call_tool(self, name: str, arguments: Any) -> dict[str, Any]:
        if name == "local_ai_status":
            return _content(self.status())
        if not isinstance(arguments, dict):
            return _content({"error": "arguments_must_be_an_object", "fallback": "continue_without_local_ai"}, error=True)
        try:
            if name == "local_ai_route":
                return _content(self.route(arguments))
            if name == "local_ai_compress_context":
                return _content(self.compress(arguments))
            if name == "local_ai_structured_extract":
                return _content(public_result(extract_payload(arguments, environment=self._environment())))
            raise ToolFailure("unknown_tool")
        except (ToolFailure, CanaryRuntimeError) as error:
            return _content({"error": str(error), "fallback": "continue_with_primary_model"}, error=True)

    def handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        method, request_id = request.get("method"), request.get("id")
        if method == "notifications/initialized":
            return None
        if method == "initialize":
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            protocol = params.get("protocolVersion") if isinstance(params.get("protocolVersion"), str) else "2025-03-26"
            return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": protocol, "capabilities": {"tools": {}}, "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}, "instructions": self.instructions()}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": self.tools()}}
        if method == "tools/call":
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            name = params.get("name")
            if not isinstance(name, str):
                return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "tool_name_required"}}
            return {"jsonrpc": "2.0", "id": request_id, "result": self.call_tool(name, params.get("arguments", {}))}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method_not_found"}}


def main() -> int:
    server = LocalAiMcp()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request_must_be_object")
            response = server.handle(request)
            if response is not None:
                sys.stdout.write(_json_text(response) + "\n"); sys.stdout.flush()
        except Exception as error:
            print(f"{SERVER_NAME}: {type(error).__name__}", file=sys.stderr)
            sys.stdout.write(_json_text({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse_error"}}) + "\n"); sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
