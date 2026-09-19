#!/bin/sh
set -eu

stage="${1:-}"
case "$stage" in
  dietpi|home-assistant-core|containers|codex-cli) ;;
  *) echo "Usage: $0 dietpi|home-assistant-core|containers|codex-cli" >&2; exit 64 ;;
esac

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
request_file="$trigger_dir/$stage-requested"
processing_file="$trigger_dir/$stage-processing"
request_lock="$trigger_dir/$stage-request.lock"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Host update trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Host update trigger directory is not writable" >&2; exit 73; }

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "host-update-request stage=$stage status=coalesced request_id=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  request_id=$(sed -n '1p' "$request_file" 2>/dev/null || sed -n '1p' "$processing_file" 2>/dev/null || printf 'pending')
  echo "host-update-request stage=$stage status=coalesced request_id=$request_id"
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/$stage-requested.$$"
umask 007
printf '%s\n' "$request_id" > "$temporary"
mv "$temporary" "$request_file"
echo "host-update-request stage=$stage status=accepted request_id=$request_id"
