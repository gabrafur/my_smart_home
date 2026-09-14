#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
node_bin="${ALEXA_MEDIA_UPDATE_NODE_BIN:-/usr/bin/node}"
updater="${ALEXA_MEDIA_UPDATE_SCRIPT:-$script_dir/alexa-media-safe-update.mjs}"
request_file="$trigger_dir/alexa-media-requested"
processing_file="$trigger_dir/alexa-media-processing"
result_file="$trigger_dir/alexa-media-result"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -r "$updater" ] || { echo "Alexa Media safe updater is unavailable: $updater" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  if ! mv "$request_file" "$processing_file" 2>/dev/null; then
    exit 0
  fi
fi

request_id=$(sed -n '1p' "$processing_file" | tr -cd 'A-Za-z0-9_.:-')
target=$(sed -n '2p' "$processing_file" | tr -cd 'A-Za-z0-9.+-')
[ -n "$request_id" ] || request_id=invalid
printf '%s' "$target" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$' || {
  printf 'alexa-media-update status=failed request_id=%s target=unknown reason=invalid_target\n' "$request_id" > "$result_file"
  rm -f -- "$processing_file"
  exit 64
}

publish_result() {
  temporary="$trigger_dir/alexa-media-result.$$"
  umask 007
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$result_file"
}

restore_request() {
  if [ -f "$processing_file" ]; then
    rm -f -- "$request_file"
    mv "$processing_file" "$request_file"
  fi
  publish_result "alexa-media-update status=deferred request_id=$request_id target=$target"
}
trap 'restore_request; exit 75' HUP INT TERM

for active_stage in dietpi home-assistant-core containers repository-dependency; do
  if [ -f "$trigger_dir/$active_stage-processing" ]; then
    restore_request
    trap - HUP INT TERM
    exit 75
  fi
done

publish_result "alexa-media-update status=running request_id=$request_id target=$target"
set +e
"$node_bin" "$updater" apply --target "$target"
status=$?
set -e

if [ "$status" -eq 75 ]; then
  restore_request
  trap - HUP INT TERM
  exit 75
fi

rm -f -- "$processing_file"
trap - HUP INT TERM
if [ "$status" -eq 0 ]; then
  summary=$("$node_bin" "$updater" status)
  publish_result "$summary request_id=$request_id"
  exit 0
fi

publish_result "alexa-media-update status=failed request_id=$request_id target=$target exit_code=$status"
exit "$status"
