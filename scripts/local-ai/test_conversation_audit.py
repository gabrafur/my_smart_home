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


class ConversationAuditTest(unittest.TestCase):
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
