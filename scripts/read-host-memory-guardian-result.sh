#!/bin/sh
set -eu

trigger_dir="${HOST_MEMORY_GUARDIAN_TRIGGER_DIR:-/run/host-memory-guardian}"
result_file="$trigger_dir/result"

case "$trigger_dir" in
  /*) ;;
  *) echo "HOST_MEMORY_GUARDIAN_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -r "$result_file" ] || exit 0
sed -n '1p' "$result_file"
