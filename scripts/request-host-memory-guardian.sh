#!/bin/sh
set -eu

trigger_dir="${HOST_MEMORY_GUARDIAN_TRIGGER_DIR:-/run/host-memory-guardian}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
request_lock="$trigger_dir/request.lock"
stale_lock_seconds="${HOST_MEMORY_GUARDIAN_STALE_LOCK_SECONDS:-120}"

case "$trigger_dir" in
  /*) ;;
  *) echo "HOST_MEMORY_GUARDIAN_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Host memory guardian trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Host memory guardian trigger directory is not writable" >&2; exit 73; }

lock_recovered=false
if ! mkdir "$request_lock" 2>/dev/null; then
  lock_mtime=$(stat -c %Y "$request_lock" 2>/dev/null || printf '0')
  now=$(date +%s)
  case "$lock_mtime:$stale_lock_seconds" in
    *[!0-9:]*|:*|*:) lock_mtime=0 ;;
  esac
  if [ ! -f "$request_file" ] && [ ! -f "$processing_file" ] &&
     [ "$lock_mtime" -gt 0 ] && [ $((now - lock_mtime)) -ge "$stale_lock_seconds" ] &&
     rmdir "$request_lock" 2>/dev/null && mkdir "$request_lock" 2>/dev/null; then
    lock_recovered=true
  else
    echo "host-memory-guardian-request status=coalesced request_id=busy"
    exit 0
  fi
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  request_id=$(sed -n '1p' "$request_file" 2>/dev/null || sed -n '1p' "$processing_file" 2>/dev/null || printf 'pending')
  echo "host-memory-guardian-request status=coalesced request_id=$request_id"
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/requested.$$"
umask 007
printf '%s\n' "$request_id" > "$temporary"
mv "$temporary" "$request_file"
echo "host-memory-guardian-request status=accepted request_id=$request_id lock_recovered=$lock_recovered"
