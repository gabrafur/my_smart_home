#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${STORAGE_MAINTENANCE_TRIGGER_DIR:-$repo_root/homeassistant/.storage-maintenance-trigger}"
maintenance_script="${STORAGE_MAINTENANCE_SCRIPT:-$script_dir/storage-maintenance.sh}"
request_file="$trigger_dir/manual-trigger"
processing_file="$trigger_dir/processing"

case "$trigger_dir" in
  /*) ;;
  *) echo "STORAGE_MAINTENANCE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -x "$maintenance_script" ] || { echo "Storage maintenance script is unavailable: $maintenance_script" >&2; exit 66; }
mkdir -p "$trigger_dir"

[ -f "$request_file" ] || exit 0
if ! mv "$request_file" "$processing_file" 2>/dev/null; then
  exit 0
fi

restore_request() {
  rm -f -- "$request_file"
  : > "$request_file"
  rm -f -- "$processing_file"
}
trap restore_request HUP INT TERM

if "$maintenance_script" --apply --min-age 24 --max-build-cache 2GB; then
  rm -f -- "$processing_file"
  trap - HUP INT TERM
  exit 0
fi

restore_request
exit 1
