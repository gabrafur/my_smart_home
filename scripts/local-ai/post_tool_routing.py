#!/usr/bin/env python3
"""Compatibility shim for clients that cached the former hook path."""

import os
from pathlib import Path
import runpy

configured = os.getenv("LOCAL_AI_MCP_RUNTIME_DIR")
runtime = Path(configured).expanduser() if configured else Path.home() / ".local/share/local-ai-rtx/current"
legacy = Path.home() / ".local/share/codex-local-ai/current"
target = runtime / "post_tool_routing.py"
if not target.is_file():
    target = legacy / "post_tool_routing.py"
runpy.run_path(str(target), run_name="__main__")
