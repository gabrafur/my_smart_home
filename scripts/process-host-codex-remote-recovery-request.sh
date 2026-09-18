#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${CODEX_REMOTE_RECOVERY_TRIGGER_DIR:-$repo_root/homeassistant/.codex-remote-recovery-trigger}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
result_file="$trigger_dir/result"
[ -f "$request_file" ] || exit 0
mv "$request_file" "$processing_file" 2>/dev/null || exit 0
request_id=$(sed -n '1p' "$processing_file" | tr -cd 'A-Za-z0-9_.:-')
temporary="$trigger_dir/result.$$"
set +e
output=$(/usr/bin/node "$script_dir/codex-remote-recovery.mjs" --recover 2>&1)
status=$?
set -e
rm -f -- "$processing_file"
detail=$(printf '%s\n' "$output" | tail -n 1 | tr -cd 'A-Za-z0-9_.:= -' | cut -c 1-300)
umask 007
printf 'request_id=%s exit_code=%s %s checked_at=%s\n' "$request_id" "$status" "$detail" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"
mv "$temporary" "$result_file"
exit "$status"
