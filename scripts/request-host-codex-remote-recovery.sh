#!/bin/sh
set -eu

trigger_dir="${CODEX_REMOTE_RECOVERY_TRIGGER_DIR:-/run/codex-remote-recovery}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
request_lock="$trigger_dir/request.lock"
case "$trigger_dir" in /*) ;; *) echo "Trigger directory must be absolute" >&2; exit 64 ;; esac
[ -d "$trigger_dir" ] && [ -w "$trigger_dir" ] || { echo "Recovery trigger unavailable" >&2; exit 73; }
if ! mkdir "$request_lock" 2>/dev/null; then
  echo "codex-remote-recovery-request status=coalesced request_id=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  echo "codex-remote-recovery-request status=coalesced request_id=pending"
  exit 0
fi
request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/requested.$$"
umask 007
printf '%s\n' "$request_id" > "$temporary"
mv "$temporary" "$request_file"
echo "codex-remote-recovery-request status=accepted request_id=$request_id"
