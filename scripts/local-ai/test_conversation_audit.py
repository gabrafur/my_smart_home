#!/usr/bin/env python3
"""Privacy and separation tests for retrospective routing audits."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path


SCRIPT = Path(__file__).with_name("audit_recent_conversations.py")
SPEC = importlib.util.spec_from_file_location("conversation_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)


def write_session(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def event(payload: dict) -> dict:
    return {"type": "response_item", "payload": payload}


def mcp_event(tool: str, structured: dict, *, error: bool = False) -> dict:
    return {
        "type": "event_msg",
        "payload": {
            "type": "mcp_tool_call_end",
            "invocation": {"tool": tool, "arguments": {}},
            "result": {"Ok": {"isError": error, "structuredContent": structured}},
        },
    }


class ConversationAuditTest(unittest.TestCase):
    def test_single_code_mode_exec_is_attributed_to_its_shell_command(self):
        source = 'const r = await tools.exec_command({cmd: "git diff", workdir: "/tmp"}); text(r.output);'
        self.assertEqual(AUDIT.call_source({"input": source}), "git diff")

    def test_multiple_code_mode_exec_outputs_are_not_misattributed(self):
        source = (
            'const a = await tools.exec_command({cmd: "rg -n TODO src"});'
            'const b = await tools.exec_command({cmd: "git diff"});'
            'text(a.output + b.output);'
        )
        self.assertEqual(AUDIT.call_source({"input": source}), "")
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": source}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "+changed\n" * 2_000}),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "TOO_SMALL")
        self.assertEqual(result["candidate_outputs"], 0)

    def test_retrospective_audit_is_aggregate_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = root / "sessions"
            history = root / "turns.jsonl"
            output = "diff --git a/a b/a\n" + "+changed\n" * 700
            write_session(sessions / "eligible.jsonl", [
                event({"type": "custom_tool_call", "call_id": "1", "input": "git diff"}),
                event({"type": "custom_tool_call_output", "call_id": "1", "output": output}),
            ])
            timestamp = datetime.now(UTC).timestamp()
            (sessions / "eligible.jsonl").touch()
            history.write_text("", encoding="utf-8")

            result = AUDIT.audit(
                sessions,
                history,
                days=7,
                limit=20,
                now=datetime.now(UTC),
                exclude_newest_vscode=False,
            )
            self.assertEqual(result["conversations_audited"], 1)
            self.assertEqual(result["candidates"], 1)
            self.assertEqual(result["historical_missed_opportunities"], 1)
            self.assertEqual(result["retrospective_today_missed_opportunities"], 1)
            self.assertEqual(result["missed_candidate_outputs"], 1)
            self.assertEqual(
                result["missed_reasons"],
                {"candidate_output_without_successful_local_inference": 1},
            )
            serialized = json.dumps(result)
            self.assertNotIn("changed", serialized)
            self.assertNotIn("eligible.jsonl", serialized)

    def test_audit_file_contains_no_operational_daily_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "local-ai-routing-audit.json"
            AUDIT.write_private_json(target, {
                "schema_version": 1,
                "conversations_audited": 3,
                "historical_missed_opportunities": 1,
                "adjustments": ["post_tool_routing_hook"],
            })
            stored = json.loads(target.read_text(encoding="utf-8"))
            self.assertNotIn("daily", stored)
            self.assertNotIn("routing", stored)
            self.assertEqual(target.stat().st_mode & 0o777, 0o660)

    def test_a_large_candidate_is_not_hidden_by_an_unrelated_search(self):
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": "rg -n TODO src"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "one match"}),
            event({"type": "custom_tool_call", "call_id": "2", "input": "git diff"}),
            event({"type": "custom_tool_call_output", "call_id": "2", "output": "+changed\n" * 700}),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "MISSED_OPPORTUNITY")
        self.assertTrue(result["candidate"])

    def test_large_deterministic_text_is_candidate_but_smaller_output_is_final(self):
        small = AUDIT.audit_vscode_session([
            event({"type": "custom_tool_call", "call_id": "1", "input": "rg -n TODO src"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "match\n" * 1_000}),
        ], datetime.now(UTC))
        large = AUDIT.audit_vscode_session([
            event({"type": "custom_tool_call", "call_id": "1", "input": "rg -n TODO src"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "src/a.py:1:TODO\n" * 900}),
        ], datetime.now(UTC))
        self.assertEqual(small["category"], "DETERMINISTIC")
        self.assertEqual(small["candidate_outputs"], 0)
        self.assertEqual(large["category"], "MISSED_OPPORTUNITY")
        self.assertEqual(large["candidate_outputs"], 1)

    def test_deterministic_route_does_not_hide_uncorrelated_candidate_output(self):
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": "git diff"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "+changed\n" * 700}),
            mcp_event("local_ai_route", {
                "decision": "DETERMINISTIC",
                "reason": "deterministic_tool_sufficient",
                "task_type": "inspect-files",
            }),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "MISSED_OPPORTUNITY")
        self.assertEqual(result["missed_reason"], "candidate_output_without_successful_local_inference")

    def test_successful_compression_is_required_for_used_classification(self):
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": "git diff"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "+changed\n" * 700}),
            mcp_event("local_ai_compress_context", {
                "job_id": "job-success",
                "telemetry_recorded": True,
                "result": {"summary": "bounded"},
            }),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "RTX_USED_CORRECTLY")
        self.assertEqual(result["successful_compressions"], 1)
        self.assertIsNone(result["missed_reason"])

    def test_compression_without_telemetry_proof_is_not_counted_as_used(self):
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": "git diff"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": "+changed\n" * 700}),
            mcp_event("local_ai_compress_context", {
                "job_id": "job-unverified",
                "result": {"summary": "bounded"},
            }),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "MISSED_OPPORTUNITY")
        self.assertEqual(result["successful_compressions"], 0)

    def test_canonical_hook_replacement_counts_as_used(self):
        context = {
            "local_ai_context_replacement": True,
            "local_ai": {
                "job_id": "job-hook-success",
                "executed": True,
                "success": True,
                "telemetry_recorded": True,
            },
            "result": {"summary": "bounded"},
        }
        hook_output = json.dumps({
            "continue": False,
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": json.dumps(context),
            },
        })
        rows = [
            event({"type": "custom_tool_call", "call_id": "1", "input": "rg -n TODO src"}),
            event({"type": "custom_tool_call_output", "call_id": "1", "output": hook_output}),
        ]
        result = AUDIT.audit_vscode_session(rows, datetime.now(UTC))
        self.assertEqual(result["category"], "RTX_USED_CORRECTLY")
        self.assertEqual(result["successful_compressions"], 1)
        self.assertEqual(result["missed_candidate_outputs"], 0)

    def test_status_and_route_only_are_not_canonical_hook_success(self):
        for output in (
            {"local_ai": {"available": True}},
            {"local_ai": {"evaluated": True, "eligible": True}},
            {"local_ai_context_replacement": True, "local_ai": {
                "job_id": "job-unverified", "executed": True, "success": True,
            }, "result": {"summary": "bounded"}},
        ):
            with self.subTest(output=output):
                self.assertIsNone(AUDIT.successful_hook_replacement(json.dumps(output)))

    def test_current_vscode_session_is_excluded_by_identifier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = root / "sessions"
            history = root / "turns.jsonl"
            history.write_text("", encoding="utf-8")
            rows = [
                event({"type": "custom_tool_call", "call_id": "1", "input": "git diff"}),
                event({"type": "custom_tool_call_output", "call_id": "1", "output": "+changed\n" * 700}),
            ]
            write_session(sessions / "rollout-current-session.jsonl", rows)
            write_session(sessions / "rollout-complete-session.jsonl", rows)
            previous = os.environ.get("CODEX_SESSION_ID")
            os.environ["CODEX_SESSION_ID"] = "current-session"
            try:
                result = AUDIT.audit(
                    sessions, history, days=7, limit=20,
                    now=datetime.now(UTC), exclude_newest_vscode=True,
                )
            finally:
                if previous is None:
                    os.environ.pop("CODEX_SESSION_ID", None)
                else:
                    os.environ["CODEX_SESSION_ID"] = previous
            self.assertEqual(result["conversations_audited"], 1)


if __name__ == "__main__":
    unittest.main()
