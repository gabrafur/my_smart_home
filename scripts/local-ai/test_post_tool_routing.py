#!/usr/bin/env python3
"""Regression tests for automatic PostToolUse Local AI routing."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("post_tool_routing.py")
SPEC = importlib.util.spec_from_file_location("post_tool_routing", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HOOK)


def payload(command: str, output: str, session_id: str = "test-session") -> dict:
    return {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "session_id": session_id,
        "tool_input": {"command": command},
        "tool_response": {"output": output, "exit_code": 0},
    }


class FakeMcp:
    def __init__(self, route_decision: str = "LOCAL_AI_ELIGIBLE") -> None:
        self.route_decision = route_decision
        self.calls: list[tuple[str, dict]] = []
        self.closed = False

    def call(self, name: str, arguments: dict) -> dict:
        self.calls.append((name, arguments))
        if name == "local_ai_status":
            return {"available": self.route_decision != "LOCAL_AI_UNAVAILABLE", "state": "LOCAL_AI_AVAILABLE"}
        if name == "local_ai_route":
            return {"decision": self.route_decision, "available": self.route_decision != "LOCAL_AI_UNAVAILABLE"}
        return {
            "result": {"summary": "bounded", "failures": [], "suspected_files": [], "recommended_actions": [], "confidence": "high"},
            "job_id": "job-test-success",
            "telemetry_recorded": True,
        }

    def close(self) -> None:
        self.closed = True


class FailingCompressMcp(FakeMcp):
    def call(self, name: str, arguments: dict) -> dict:
        if name == "local_ai_compress_context":
            self.calls.append((name, arguments))
            raise RuntimeError("inference failed")
        return super().call(name, arguments)


class PostToolRoutingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_state = os.environ.get("LOCAL_AI_HOOK_SESSION_STATE")
        os.environ["LOCAL_AI_HOOK_SESSION_STATE"] = str(Path(self.temporary.name) / "sessions.json")

    def tearDown(self):
        if self.previous_state is None:
            os.environ.pop("LOCAL_AI_HOOK_SESSION_STATE", None)
        else:
            os.environ["LOCAL_AI_HOOK_SESSION_STATE"] = self.previous_state
        self.temporary.cleanup()

    def test_unpromoted_test_output_never_starts_mcp(self):
        fake = FakeMcp()
        result = HOOK.process_hook(
            payload("pytest -q", "FAILED test_case\n" * 400),
            lambda: fake,
        )
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_small_output_is_not_routed(self):
        created = []
        result = HOOK.process_hook(payload("pytest -q", "1 passed"), lambda: created.append(True))
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_large_log_uses_deterministic_facts_without_mcp(self):
        fake = FakeMcp()
        source = ("INFO worker heartbeat\n" * 600) + "ERROR request failed at /srv/app.py:42\n"
        result = HOOK.process_hook(payload("journalctl -u example.service", source), lambda: fake)

        self.assertEqual(fake.calls, [])
        self.assertIs(result["continue"], False)
        context = json.loads(result["hookSpecificOutput"]["additionalContext"])
        self.assertFalse(context["local_ai_context_replacement"])
        self.assertTrue(context["deterministic_context_replacement"])
        self.assertEqual(context["validation"]["critical_fact_recall"], 1)
        self.assertIn("ERROR request failed", context["result"]["failures"][0]["value"])

    def test_log_below_promoted_floor_never_creates_mcp_client(self):
        created = []
        source = "I" * (HOOK.TASK_MIN_CHARS["summarize-log"] - 1)
        result = HOOK.process_hook(payload("journalctl -u example.service", source), lambda: created.append(True))

        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_log_with_too_many_critical_lines_falls_back_to_raw_context(self):
        created = []
        source = ("INFO routine\n" * 900) + ("ERROR distinct failure\n" * 65)
        result = HOOK.process_hook(
            payload("journalctl -u example.service", source),
            lambda: created.append(True),
        )
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_medium_deterministic_output_is_final_without_inference(self):
        fake = FakeMcp("DETERMINISTIC")
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 400), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_large_unpromoted_file_output_does_not_route(self):
        fake = FakeMcp()
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_large_structured_json_remains_deterministic(self):
        fake = FakeMcp("DETERMINISTIC")
        source = json.dumps([{"path": f"src/file-{number}.py"} for number in range(900)])
        result = HOOK.process_hook(payload("jq -c . inventory.json", source), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_unavailable_rtx_falls_back_to_original_result(self):
        fake = FakeMcp("LOCAL_AI_UNAVAILABLE")
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_failed_compression_falls_back_without_recording_a_second_terminal_decision(self):
        fake = FailingCompressMcp()
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(fake.calls, [])

    def test_unpromoted_outputs_do_not_check_status_per_session(self):
        first = FakeMcp()
        second = FakeMcp()
        large = "FAILED test_case\n" * 400
        HOOK.process_hook(payload("pytest -q", large, "same-session"), lambda: first)
        HOOK.process_hook(payload("pytest -q", large, "same-session"), lambda: second)
        self.assertEqual(first.calls, [])
        self.assertEqual(second.calls, [])

    def test_source_file_named_log_facts_is_not_treated_as_runtime_log(self):
        created = []
        source = ("OOM timeout ERROR patterns are source constants\n" * 500)
        result = HOOK.process_hook(
            payload("sed -n '1,500p' scripts/local-ai/log_facts.py", source),
            lambda: created.append(True),
        )
        self.assertIsNone(result)
        self.assertEqual(created, [])
        self.assertEqual(HOOK.classify_task(
            "sed -n '1,500p' scripts/local-ai/log_facts.py", source,
        )[0], "inspect-files")

    def test_private_history_is_never_delegated(self):
        created = []
        result = HOOK.process_hook(
            payload("cat .agent-history/turns.jsonl", "private\n" * 2_000),
            lambda: created.append(True),
        )
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_relative_env_file_is_never_delegated(self):
        created = []
        result = HOOK.process_hook(
            payload("cat .env", "TOKEN=private\n" * 2_000),
            lambda: created.append(True),
        )
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_detected_credentials_fail_closed_before_mcp(self):
        created = []
        source = ("password=visible email=user@example.invalid host=192.0.2.10\nFAILED test_case\n" * 120)
        result = HOOK.process_hook(payload("pytest -q", source), lambda: created.append(True))
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_composite_and_json_secret_fields_are_detected_without_inference(self):
        secrets = {
            "password": "password-value",
            "access_token": "access-value",
            "refresh-token": "refresh-value",
            "api_token": "api-token-value",
            "client_secret": "client-value",
            "cookie": "cookie-value",
            "session_id": "session-value",
        }
        source = (json.dumps(secrets) + "\nFAILED safe test\n") * 120
        cleaned, redactions = HOOK.redact_for_local_ai(source)
        for secret in secrets.values():
            self.assertNotIn(secret, cleaned)
        self.assertGreater(redactions, 0)
        created = []
        self.assertIsNone(HOOK.process_hook(payload("pytest -q", source), lambda: created.append(True)))
        self.assertEqual(created, [])

    def test_status_or_route_metadata_cannot_create_success_context(self):
        for metadata in (
            {"state": "LOCAL_AI_AVAILABLE", "available": True},
            {"decision": "DETERMINISTIC", "eligible": False},
            {"result": {"summary": "bounded"}, "telemetry_recorded": True},
        ):
            with self.subTest(metadata=metadata):
                with self.assertRaises(RuntimeError):
                    HOOK.bounded_result("inspect-files", metadata, 0)


class RepositoryRoutingPolicyTest(unittest.TestCase):
    def test_agents_policy_covers_every_request_and_declares_hook_scope(self):
        root = SCRIPT.parents[2]
        agents = (root / "AGENTS.md").read_text(encoding="utf-8")
        skill = (root / ".agents/skills/rtx-context-optimizer/SKILL.md").read_text(encoding="utf-8")
        hooks = json.loads((root / ".codex/hooks.json").read_text(encoding="utf-8"))

        self.assertIn("Apply this decision to every user request", agents)
        self.assertIn("No generative context-compression profile is promoted", agents)
        self.assertIn("Do not create compression receipts", agents)
        self.assertIn("aprovar pelo CLI do `ai-bridge` não ativa o hook", agents)
        self.assertIn("Developer: Reload Window", agents)
        self.assertIn("Evaluate this routing rule on every user request", skill)
        self.assertIn("The project has no `UserPromptSubmit` interceptor", skill)
        self.assertIn("approval in one does not activate the other", skill)
        self.assertEqual(hooks["hooks"]["PostToolUse"][0]["matcher"], "Bash")


if __name__ == "__main__":
    unittest.main()
