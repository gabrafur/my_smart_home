#!/usr/bin/env python3
from __future__ import annotations

import unittest
from unittest.mock import patch

from mcp_server import LocalAiMcp, SERVER_VERSION


class McpServerTests(unittest.TestCase):
    def test_lists_separate_production_only_structured_tool(self):
        tools = {tool["name"]: tool for tool in LocalAiMcp.tools()}
        self.assertIn("local_ai_structured_extract", tools)
        schema = tools["local_ai_structured_extract"]["inputSchema"]
        self.assertEqual(schema["properties"]["execution_mode"]["enum"], ["production"])
        self.assertEqual(schema["properties"]["source"]["maxLength"], 12000)
        self.assertEqual(SERVER_VERSION, "1.5.0")

    def test_structured_tool_returns_fail_closed_result(self):
        expected = {"route": "GPT_DIRECT", "reason": "rollout_zero", "result": None, "fallback": True, "telemetry": None}
        with patch("mcp_server.extract_payload", return_value=expected):
            response = LocalAiMcp().call_tool("local_ai_structured_extract", {"source": "x", "schema": {}})
        self.assertFalse(response["isError"])
        self.assertEqual(response["structuredContent"]["route"], "GPT_DIRECT")

    def test_mcp_rejects_probe_mode_and_unknown_fields_by_schema_contract(self):
        schema = next(tool for tool in LocalAiMcp.tools() if tool["name"] == "local_ai_structured_extract")["inputSchema"]
        self.assertFalse(schema["additionalProperties"])
        self.assertNotIn("canary_probe", schema["properties"]["execution_mode"]["enum"])


if __name__ == "__main__":
    unittest.main()
