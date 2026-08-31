#!/bin/sh
set -eu

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
request_file="$trigger_dir/kia-uvo-requested"
processing_file="$trigger_dir/kia-uvo-processing"
request_lock="$trigger_dir/kia-uvo-request.lock"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Kia UVO update trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Kia UVO update trigger directory is not writable" >&2; exit 73; }

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "kia-uvo-update-request status=coalesced request_id=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  request_id=$(sed -n '1p' "$request_file" 2>/dev/null || sed -n '1p' "$processing_file" 2>/dev/null || printf 'pending')
  echo "kia-uvo-update-request status=coalesced request_id=$request_id"
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/kia-uvo-requested.$$"
umask 007
printf '%s\n' "$request_id" > "$temporary"
mv "$temporary" "$request_file"
echo "kia-uvo-update-request status=accepted request_id=$request_id"
