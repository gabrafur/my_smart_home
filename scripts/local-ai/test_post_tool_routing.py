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
        return {"result": {"summary": "bounded", "failures": [], "suspected_files": [], "recommended_actions": [], "confidence": "high"}}

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

    def test_large_eligible_test_output_routes_and_compresses(self):
        fake = FakeMcp()
        result = HOOK.process_hook(
            payload("pytest -q", "FAILED test_case\n" * 400),
            lambda: fake,
        )
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_status", "local_ai_route", "local_ai_compress_context"])
        self.assertIs(result["continue"], False)
        self.assertIn("local_ai_context_replacement", result["hookSpecificOutput"]["additionalContext"])
        self.assertTrue(fake.closed)

    def test_small_output_is_not_routed(self):
        created = []
        result = HOOK.process_hook(payload("pytest -q", "1 passed"), lambda: created.append(True))
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_deterministic_tool_is_preferred_without_inference(self):
        fake = FakeMcp("DETERMINISTIC")
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 400), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_route"])
        self.assertTrue(fake.calls[0][1]["deterministic_preprocessing_available"])

    def test_unavailable_rtx_falls_back_to_original_result(self):
        fake = FakeMcp("LOCAL_AI_UNAVAILABLE")
        result = HOOK.process_hook(payload("git diff", "+ changed\n" * 700), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_status", "local_ai_route"])

    def test_failed_compression_falls_back_without_recording_a_second_terminal_decision(self):
        fake = FailingCompressMcp()
        result = HOOK.process_hook(payload("git diff", "+ changed\n" * 700), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual(
            [name for name, _ in fake.calls],
            ["local_ai_status", "local_ai_route", "local_ai_compress_context", "local_ai_status"],
        )

    def test_status_is_lazy_and_checked_once_per_session(self):
        first = FakeMcp()
        second = FakeMcp()
        large = "FAILED test_case\n" * 400
        HOOK.process_hook(payload("pytest -q", large, "same-session"), lambda: first)
        HOOK.process_hook(payload("pytest -q", large, "same-session"), lambda: second)
        self.assertEqual([name for name, _ in first.calls][0], "local_ai_status")
        self.assertNotIn("local_ai_status", [name for name, _ in second.calls])

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

    def test_credentials_are_redacted_but_private_context_is_allowed(self):
        fake = FakeMcp()
        source = ("password=visible email=user@example.invalid host=192.0.2.10\nFAILED test_case\n" * 120)
        result = HOOK.process_hook(payload("pytest -q", source), lambda: fake)
        compressed_input = fake.calls[2][1]["text"]
        self.assertNotIn("visible", compressed_input)
        self.assertIn("user@example.invalid", compressed_input)
        self.assertIn("192.0.2.10", compressed_input)
        context = json.loads(result["hookSpecificOutput"]["additionalContext"])
        self.assertGreater(context["redactions_applied"], 0)

    def test_composite_and_json_secret_fields_are_redacted(self):
        fake = FakeMcp()
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
        result = HOOK.process_hook(payload("pytest -q", source), lambda: fake)
        compressed_input = fake.calls[2][1]["text"]
        for secret in secrets.values():
            self.assertNotIn(secret, compressed_input)
        self.assertGreater(json.loads(result["hookSpecificOutput"]["additionalContext"])["redactions_applied"], 0)


if __name__ == "__main__":
    unittest.main()
