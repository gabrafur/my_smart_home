#!/usr/bin/env python3
"""Fetch the sanitized Codex usage summary from the local agent bridge."""

import json
import urllib.error
import urllib.request


URL = "http://127.0.0.1:8099/usage"


try:
    with urllib.request.urlopen(URL, timeout=5) as response:
        payload = json.load(response)
except (OSError, ValueError, urllib.error.URLError) as error:
    payload = {"status": "error", "error": type(error).__name__}

print(json.dumps(payload, separators=(",", ":")))
