#!/bin/sh
set -eu

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
result_file="$trigger_dir/kia-uvo-result"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Kia UVO update trigger directory is unavailable" >&2; exit 66; }
[ -r "$result_file" ] || exit 0
sed -n '1p' "$result_file"
