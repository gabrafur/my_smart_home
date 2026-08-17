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

    def test_large_eligible_test_output_routes_and_compresses(self):
        fake = FakeMcp()
        result = HOOK.process_hook(
            payload("pytest -q", "FAILED test_case\n" * 400),
            lambda: fake,
        )
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_status", "local_ai_route", "local_ai_compress_context"])
        self.assertIs(result["continue"], False)
        context = json.loads(result["hookSpecificOutput"]["additionalContext"])
        self.assertTrue(context["local_ai_context_replacement"])
        self.assertEqual(context["local_ai"]["job_id"], "job-test-success")
        self.assertTrue(context["local_ai"]["executed"])
        self.assertTrue(context["local_ai"]["success"])
        self.assertTrue(fake.closed)

    def test_small_output_is_not_routed(self):
        created = []
        result = HOOK.process_hook(payload("pytest -q", "1 passed"), lambda: created.append(True))
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_medium_deterministic_output_is_final_without_inference(self):
        fake = FakeMcp("DETERMINISTIC")
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 400), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_route"])
        self.assertTrue(fake.calls[0][1]["deterministic_preprocessing_available"])

    def test_large_deterministic_text_output_routes_as_postprocessing(self):
        fake = FakeMcp()
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
        self.assertEqual(
            [name for name, _ in fake.calls],
            ["local_ai_status", "local_ai_route", "local_ai_compress_context"],
        )
        self.assertFalse(fake.calls[1][1]["deterministic_preprocessing_available"])
        self.assertIs(result["continue"], False)

    def test_large_structured_json_remains_deterministic(self):
        fake = FakeMcp("DETERMINISTIC")
        source = json.dumps([{"path": f"src/file-{number}.py"} for number in range(900)])
        result = HOOK.process_hook(payload("jq -c . inventory.json", source), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_route"])
        self.assertTrue(fake.calls[0][1]["deterministic_preprocessing_available"])

    def test_unavailable_rtx_falls_back_to_original_result(self):
        fake = FakeMcp("LOCAL_AI_UNAVAILABLE")
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in fake.calls], ["local_ai_status", "local_ai_route"])

    def test_failed_compression_falls_back_without_recording_a_second_terminal_decision(self):
        fake = FailingCompressMcp()
        result = HOOK.process_hook(payload("rg -n TODO src", "src/a.py:1:TODO\n" * 900), lambda: fake)
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


if __name__ == "__main__":
    unittest.main()
