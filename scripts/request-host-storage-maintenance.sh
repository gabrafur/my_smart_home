#!/bin/sh
set -eu

trigger_dir="${STORAGE_MAINTENANCE_TRIGGER_DIR:-/run/storage-maintenance-trigger}"
trigger_file="$trigger_dir/manual-trigger"

case "$trigger_dir" in
  /*) ;;
  *) echo "STORAGE_MAINTENANCE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Storage maintenance trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Storage maintenance trigger directory is not writable" >&2; exit 73; }

umask 077
rm -f -- "$trigger_file"
: > "$trigger_file"
echo "Host storage maintenance requested"
