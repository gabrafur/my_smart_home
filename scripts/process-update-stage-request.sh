#!/bin/sh
set -eu

stage="${1:-}"
case "$stage" in
  dietpi|home-assistant-core|containers) ;;
  *) echo "Usage: $0 dietpi|home-assistant-core|containers" >&2; exit 64 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
update_script="${HOST_UPDATE_STAGE_SCRIPT:-$script_dir/run-daily-host-update.sh}"
request_file="$trigger_dir/$stage-requested"
processing_file="$trigger_dir/$stage-processing"
result_file="$trigger_dir/$stage-result"
detail_file="$trigger_dir/$stage-detail"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -x "$update_script" ] || { echo "Host update stage script is unavailable: $update_script" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  mv "$request_file" "$processing_file" 2>/dev/null || exit 0
fi

request_id=$(sed -n '1p' "$processing_file" 2>/dev/null | tr -cd 'A-Za-z0-9_.:-')
[ -n "$request_id" ] || request_id="invalid"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

publish_result() {
  temporary="$trigger_dir/$stage-result.$$"
  umask 007
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$result_file"
}

restore_request() {
  if [ -f "$processing_file" ]; then
    rm -f -- "$request_file"
    mv "$processing_file" "$request_file"
  fi
  publish_result "host-update stage=$stage status=deferred request_id=$request_id started_at=$started_at finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
trap 'restore_request; exit 75' HUP INT TERM

publish_result "host-update stage=$stage status=running request_id=$request_id started_at=$started_at"
rm -f -- "$detail_file"
set +e
DAILY_UPDATE_DETAIL_FILE="$detail_file" "$update_script" "$stage"
status=$?
set -e

detail=""
if [ -r "$detail_file" ]; then
  detail=$(sed -n '1p' "$detail_file" | tr -cd 'A-Za-z0-9_.:= -')
fi
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$status" -eq 75 ]; then
  restore_request
  trap - HUP INT TERM
  exit 75
fi

rm -f -- "$processing_file"
trap - HUP INT TERM
if [ "$status" -eq 0 ]; then
  publish_result "host-update stage=$stage status=success request_id=$request_id started_at=$started_at finished_at=$finished_at $detail"
  exit 0
fi

publish_result "host-update stage=$stage status=failed request_id=$request_id started_at=$started_at finished_at=$finished_at exit_code=$status $detail"
exit "$status"
