#!/bin/sh
set -eu

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
request_file="$trigger_dir/alexa-media-requested"
processing_file="$trigger_dir/alexa-media-processing"
request_lock="$trigger_dir/alexa-media-request.lock"
target="${1:-}"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
case "$target" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "alexa-media-update-request status=rejected reason=invalid_target"; exit 64 ;;
esac
printf '%s' "$target" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$' || {
  echo "alexa-media-update-request status=rejected reason=invalid_target"
  exit 64
}
[ -d "$trigger_dir" ] || { echo "Alexa Media update trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Alexa Media update trigger directory is not writable" >&2; exit 73; }

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "alexa-media-update-request status=coalesced target=$target reason=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  pending_target=$(sed -n '2p' "$request_file" 2>/dev/null || sed -n '2p' "$processing_file" 2>/dev/null || printf unknown)
  echo "alexa-media-update-request status=coalesced target=$pending_target reason=pending"
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/alexa-media-requested.$$"
umask 007
printf '%s\n%s\n' "$request_id" "$target" > "$temporary"
mv "$temporary" "$request_file"
echo "alexa-media-update-request status=accepted target=$target request_id=$request_id"
