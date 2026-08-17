#!/usr/bin/env python3
"""Audit recent Codex conversations using privacy-safe structural metadata only."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable


DEFAULT_MAX_CONVERSATIONS = 20
MAX_ADJUSTMENTS = 12
ADJUSTMENT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(UTC)
    except (TypeError, ValueError):
        return None


def json_lines(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        source = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return rows
    with source:
        for line in source:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rows.append(parsed)
    return rows


def tool_output_size(payload: dict[str, Any]) -> int:
    output = payload.get("output")
    if isinstance(output, str):
        return len(output)
    try:
        return len(json.dumps(output, ensure_ascii=False)) if output is not None else 0
    except (TypeError, ValueError):
        return 0


def call_source(payload: dict[str, Any]) -> str:
    source = payload.get("input")
    if isinstance(source, str):
        return source
    try:
        return json.dumps(source, ensure_ascii=False) if source is not None else ""
    except (TypeError, ValueError):
        return ""


def output_profile(source: str, size: int) -> tuple[bool, bool]:
    """Return (eligible_candidate, deterministic_sufficient) without content output."""
    lowered = source.lower()
    if "local_ai_compress_context" in lowered:
        return False, False
    deterministic = bool(re.search(r"\brg\b|\bfind\b|\bwc\b|git\s+(?:status|log)\b|\bjq\b", lowered))
    if re.search(r"\b(?:sed|cat|head|tail|pytest|unittest|journalctl)\b|git\s+(?:diff|show)", lowered):
        deterministic = False
    threshold = 3_200 if re.search(r"pytest|unittest|journalctl|docker\s+logs|traceback", lowered) else 4_800
    if size < threshold:
        return False, deterministic
    compatible = bool(re.search(
        r"pytest|unittest|journalctl|docker\s+logs|git\s+(?:diff|show)|"
        r"\b(?:sed|cat|head|tail|awk|rg)\b|\.md\b|readme|agents\.md",
        lowered,
    ))
    return compatible and not deterministic, deterministic


def mcp_event(payload: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    invocation = payload.get("invocation")
    tool = invocation.get("tool") if isinstance(invocation, dict) else None
    result = payload.get("result")
    ok = result.get("Ok") if isinstance(result, dict) else None
    structured = ok.get("structuredContent") if isinstance(ok, dict) else None
    return (str(tool) if isinstance(tool, str) else None, structured if isinstance(structured, dict) else {})


def audit_vscode_session(rows: list[dict[str, Any]], timestamp: datetime) -> dict[str, Any] | None:
    if any(
        isinstance(row.get("payload"), dict)
        and (row["payload"].get("parent_thread_id") or row["payload"].get("forked_from_id"))
        for row in rows
    ):
        return None

    calls: dict[str, str] = {}
    candidate = False
    deterministic = False
    successful_compressions = 0
    unavailable = False
    unnecessary_calls = 0
    last_route: tuple[str | None, str | None] = (None, None)
    max_user_chars = 0

    for row in rows:
        payload = row.get("payload")
        if not isinstance(payload, dict):
            continue
        event_type = payload.get("type")
        if event_type == "user_message":
            message = payload.get("message")
            max_user_chars = max(max_user_chars, len(message) if isinstance(message, str) else 0)
        elif event_type == "custom_tool_call":
            calls[str(payload.get("call_id") or "")] = call_source(payload)
        elif event_type == "custom_tool_call_output":
            source = calls.get(str(payload.get("call_id") or ""), "")
            eligible_output, deterministic_output = output_profile(source, tool_output_size(payload))
            candidate = candidate or eligible_output
            deterministic = deterministic or deterministic_output
        elif event_type == "mcp_tool_call_end":
            tool, result = mcp_event(payload)
            if tool == "local_ai_route":
                decision = str(result.get("decision") or "")
                task = str(result.get("task_type") or "")
                last_route = (decision, task)
                deterministic = deterministic or decision == "DETERMINISTIC"
                unavailable = unavailable or decision == "LOCAL_AI_UNAVAILABLE"
            elif tool == "local_ai_compress_context":
                invocation = payload.get("invocation")
                arguments = invocation.get("arguments") if isinstance(invocation, dict) else {}
                task = arguments.get("task_type") if isinstance(arguments, dict) else None
                raw_result = payload.get("result")
                ok = isinstance(raw_result, dict) and isinstance(raw_result.get("Ok"), dict) and not raw_result["Ok"].get("isError")
                if ok:
                    successful_compressions += 1
                    if last_route == ("DETERMINISTIC", task):
                        unnecessary_calls += 1

    if successful_compressions:
        category = "RTX_USED_CORRECTLY"
    elif unavailable and candidate:
        category = "RTX_UNAVAILABLE"
    elif candidate:
        category = "MISSED_OPPORTUNITY"
    elif deterministic:
        category = "DETERMINISTIC"
    elif max_user_chars < 4_800:
        category = "TOO_SMALL"
    else:
        category = "NOT_APPROPRIATE"
    return {
        "timestamp": timestamp,
        "category": category,
        "candidate": category in {"RTX_USED_CORRECTLY", "RTX_UNAVAILABLE", "MISSED_OPPORTUNITY"},
        "successful_compressions": successful_compressions,
        "unnecessary_calls": unnecessary_calls,
    }


def vscode_conversations(
    sessions_root: Path,
    start: datetime,
    end: datetime,
    *,
    excluded_session_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    conversations: list[dict[str, Any]] = []
    if not sessions_root.is_dir():
        return conversations
    excluded = {value for value in (excluded_session_ids or set()) if value}
    for path in sessions_root.rglob("*.jsonl"):
        if any(value in path.name for value in excluded):
            continue
        try:
            modified = datetime.fromtimestamp(path.stat().st_mtime, UTC)
        except OSError:
            continue
        if not start <= modified <= end:
            continue
        audited = audit_vscode_session(json_lines(path), modified)
        if audited is not None:
            conversations.append(audited)
    return conversations


def bridge_conversations(history_file: Path, start: datetime, end: datetime) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in json_lines(history_file):
        if row.get("agent") != "codex":
            continue
        timestamp = parse_time(row.get("timestamp"))
        if timestamp is None or not start <= timestamp <= end:
            continue
        grouped.setdefault(str(row.get("conversation_id") or "unknown"), []).append(row)

    result: list[dict[str, Any]] = []
    for turns in grouped.values():
        timestamp = max(filter(None, (parse_time(turn.get("timestamp")) for turn in turns)))
        prompts = [str(turn.get("prompt") or "") for turn in turns]
        replies = [str(turn.get("reply") or "") for turn in turns]
        repeated = len(replies) > len(set(replies))
        max_body = max([0, *map(len, prompts), *map(len, replies)])
        category = "DETERMINISTIC" if repeated else "TOO_SMALL" if max_body < 3_200 else "NOT_APPROPRIATE"
        result.append({
            "timestamp": timestamp,
            "category": category,
            "candidate": False,
            "successful_compressions": 0,
            "unnecessary_calls": 0,
        })
    return result


def audit(
    sessions_root: Path,
    history_file: Path,
    *,
    days: int,
    limit: int,
    now: datetime,
    exclude_newest_vscode: bool = True,
) -> dict[str, Any]:
    start = now - timedelta(days=days)
    active_ids = {
        value for name in ("CODEX_SESSION_ID", "CODEX_THREAD_ID")
        if (value := os.getenv(name))
    } if exclude_newest_vscode else set()
    vscode = sorted(
        vscode_conversations(sessions_root, start, now, excluded_session_ids=active_ids),
        key=lambda item: item["timestamp"],
        reverse=True,
    )
    # Older clients may not expose a session identifier. In that case only,
    # retain the conservative fallback of excluding the newest VS Code file.
    if exclude_newest_vscode and not active_ids and vscode:
        vscode = vscode[1:]
    combined = vscode + bridge_conversations(history_file, start, now)
    selected = sorted(combined, key=lambda item: item["timestamp"], reverse=True)[:limit]
    categories = Counter(item["category"] for item in selected)
    retrospective_today = [item for item in selected if item["timestamp"].date() == now.date()]
    today_categories = Counter(item["category"] for item in retrospective_today)
    return {
        "schema_version": 1,
        "audited_at": now.isoformat().replace("+00:00", "Z"),
        "window_days": days,
        "conversations_audited": len(selected),
        "candidates": sum(1 for item in selected if item["candidate"]),
        "correctly_used": categories["RTX_USED_CORRECTLY"],
        "historical_missed_opportunities": categories["MISSED_OPPORTUNITY"],
        "historical_unavailable": categories["RTX_UNAVAILABLE"],
        "unnecessary_calls": sum(int(item["unnecessary_calls"]) for item in selected),
        "deterministic": categories["DETERMINISTIC"],
        "too_small": categories["TOO_SMALL"],
        "not_appropriate": categories["NOT_APPROPRIATE"],
        "retrospective_today_conversations": len(retrospective_today),
        "retrospective_today_candidates": sum(1 for item in retrospective_today if item["candidate"]),
        "retrospective_today_correctly_used": today_categories["RTX_USED_CORRECTLY"],
        "retrospective_today_missed_opportunities": today_categories["MISSED_OPPORTUNITY"],
        "adjustments": [],
    }


def telemetry_path() -> Path:
    configured = os.getenv("LOCAL_AI_TELEMETRY_PATH")
    if configured:
        return Path(configured).expanduser()
    config = Path(os.getenv("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "codex" / "local-ai.json"
    try:
        value = json.loads(config.read_text(encoding="utf-8"))
        configured = value.get("telemetry_path") if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        configured = None
    if isinstance(configured, str) and configured:
        return Path(configured).expanduser()
    return Path.cwd() / ".agent-history" / "local-ai-telemetry.json"


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, separators=(",", ":"))
            target.write("\n")
        os.chmod(temporary, 0o660)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--sessions-root", type=Path, default=Path.home() / ".codex" / "sessions")
    result.add_argument("--history-file", type=Path, default=Path.cwd() / ".agent-history" / "turns.jsonl")
    result.add_argument("--days", type=int, default=7)
    result.add_argument("--max-conversations", type=int, default=DEFAULT_MAX_CONVERSATIONS)
    result.add_argument("--include-active", action="store_true")
    result.add_argument("--adjustment", action="append", default=[])
    result.add_argument("--write", action="store_true")
    result.add_argument("--now", help="ISO-8601 time override for deterministic tests")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.days < 1 or not 1 <= args.max_conversations <= DEFAULT_MAX_CONVERSATIONS:
        raise SystemExit("days must be positive and max-conversations must be between 1 and 20")
    adjustments = list(dict.fromkeys(args.adjustment))[:MAX_ADJUSTMENTS]
    if any(not ADJUSTMENT_RE.fullmatch(value) for value in adjustments):
        raise SystemExit("adjustments must be lowercase privacy-safe codes")
    now = parse_time(args.now) if args.now else datetime.now(UTC)
    if now is None:
        raise SystemExit("invalid --now value")
    result = audit(
        args.sessions_root,
        args.history_file,
        days=args.days,
        limit=args.max_conversations,
        now=now,
        exclude_newest_vscode=not args.include_active,
    )
    result["adjustments"] = adjustments
    if args.write:
        target = telemetry_path().with_name("local-ai-routing-audit.json")
        write_private_json(target, result)
        result = {**result, "recorded": True}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
