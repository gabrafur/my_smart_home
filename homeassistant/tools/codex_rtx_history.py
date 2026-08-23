#!/usr/bin/env python3
"""Fetch the compact 48-hour Local AI execution history."""

import json
import urllib.error
import urllib.request


URL = "http://127.0.0.1:8099/local-ai/history"


try:
    with urllib.request.urlopen(URL, timeout=5) as response:
        response_payload = json.load(response)
    history = response_payload.get("local_ai") or {}
    payload = {
        "status": "ok",
        "window_hours": history.get("window_hours", 48),
        "count": history.get("count", 0),
        "jobs": history.get("jobs", []),
    }
except (OSError, ValueError, urllib.error.URLError) as error:
    payload = {
        "status": "error",
        "window_hours": 48,
        "count": 0,
        "jobs": [],
        "error": type(error).__name__,
    }

print(json.dumps(payload, separators=(",", ":")))
