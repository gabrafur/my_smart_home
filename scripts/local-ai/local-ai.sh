#!/usr/bin/env bash
# Keep the shell entry point tiny: Python handles JSON, HTTP and input limits.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/local-ai.py" "$@"
