#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${HOST_MEMORY_GUARDIAN_TRIGGER_DIR:-$repo_root/.local-state/host-memory-guardian}"
guardian_script="${HOST_MEMORY_GUARDIAN_SCRIPT:-$script_dir/host-memory-guardian.mjs}"
state_file="${HOST_MEMORY_GUARDIAN_STATE_FILE:-$trigger_dir/state.json}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
result_file="$trigger_dir/result"

case "$trigger_dir" in
  /*) ;;
  *) echo "HOST_MEMORY_GUARDIAN_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -f "$guardian_script" ] || { echo "Host memory guardian is unavailable" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  if ! mv "$request_file" "$processing_file" 2>/dev/null; then
    exit 0
  fi
fi

request_id=$(sed -n '1p' "$processing_file" 2>/dev/null | tr -cd 'A-Za-z0-9_.:-')
[ -n "$request_id" ] || request_id="invalid"

publish_result() {
  temporary="$trigger_dir/result.$$"
  umask 007
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$result_file"
}

publish_result "host-memory-guardian status=running request_id=$request_id checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
output=$(/usr/bin/node "$guardian_script" --state-file "$state_file" 2>&1)
status=$?
set -e
rm -f -- "$processing_file"

checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
detail=$(printf '%s\n' "$output" | tail -n 1 | tr -cd 'A-Za-z0-9_.:= -' | cut -c 1-600)
if [ "$status" -eq 0 ] && printf '%s\n' "$detail" | grep -q '^memory-guardian status='; then
  publish_result "host-$detail request_id=$request_id checked_at=$checked_at"
  exit 0
fi

reason=$(printf '%s' "$detail" | tr ' ' '_' | cut -c 1-160)
[ -n "$reason" ] || reason="guardian_failed"
publish_result "host-memory-guardian status=failed request_id=$request_id checked_at=$checked_at reason=$reason"
exit 1
