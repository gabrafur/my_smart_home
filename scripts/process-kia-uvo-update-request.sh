#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
node_bin="${KIA_UVO_UPDATE_NODE_BIN:-/usr/bin/node}"
status_script="${KIA_UVO_UPDATE_SCRIPT:-$script_dir/kia-uvo-safe-update.mjs}"
request_file="$trigger_dir/kia-uvo-requested"
processing_file="$trigger_dir/kia-uvo-processing"
followup_file="$trigger_dir/kia-uvo-followup"
result_file="$trigger_dir/kia-uvo-result"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -r "$status_script" ] || { echo "Kia UVO safe updater is unavailable: $status_script" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  if ! mv "$request_file" "$processing_file" 2>/dev/null; then
    exit 0
  fi
fi

if [ -r "$processing_file" ]; then
  request_id=$(sed -n '1p' "$processing_file" | tr -cd 'A-Za-z0-9_.:-')
  mode=$(sed -n '2p' "$processing_file" | tr -cd 'a-z')
  target=$(sed -n '3p' "$processing_file" | tr -cd 'A-Za-z0-9.+-')
else
  request_id="unreadable"
  mode="invalid"
  target="invalid"
fi
[ -n "$request_id" ] || request_id="invalid"
printf '%s:%s' "$mode" "$target" | grep -Eq '^(audit|install):v[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$' || {
  publish_invalid="$trigger_dir/kia-uvo-result.$$"
  umask 007
  printf 'kia-uvo-update status=failed request_id=%s mode=invalid latest_version=unknown reason=invalid_request\n' "$request_id" > "$publish_invalid"
  mv "$publish_invalid" "$result_file"
  rm -f -- "$processing_file"
  exit 64
}

publish_result() {
  temporary="$trigger_dir/kia-uvo-result.$$"
  umask 007
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$result_file"
}

promote_followup() {
  if [ -f "$followup_file" ] && [ ! -f "$request_file" ]; then
    mv "$followup_file" "$request_file"
  fi
}

restore_request() {
  if [ -f "$processing_file" ]; then
    rm -f -- "$request_file"
    mv "$processing_file" "$request_file"
  fi
  publish_result "kia-uvo-update status=deferred request_id=$request_id mode=$mode latest_version=$target"
}
trap 'restore_request; exit 75' HUP INT TERM

for active_stage in dietpi home-assistant-core containers repository-dependency; do
  if [ -f "$trigger_dir/$active_stage-processing" ]; then
    restore_request
    trap - HUP INT TERM
    exit 75
  fi
done

publish_result "kia-uvo-update status=running request_id=$request_id mode=$mode latest_version=$target"
set +e
"$node_bin" "$status_script" check --target "$target"
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
  summary=$("$node_bin" "$status_script" status)
  publish_result "$summary request_id=$request_id mode=$mode"
  promote_followup
  exit 0
fi

publish_result "kia-uvo-update status=failed request_id=$request_id mode=$mode latest_version=$target exit_code=$status"
promote_followup
exit "$status"
