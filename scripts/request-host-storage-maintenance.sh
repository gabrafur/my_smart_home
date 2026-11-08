#!/bin/sh
set -eu

trigger_dir="${STORAGE_MAINTENANCE_TRIGGER_DIR:-/run/storage-maintenance-trigger}"
case "$#:$*" in
  0:) request_kind="metadata"; trigger_file="$trigger_dir/manual-trigger" ;;
  1:--daily-build-cache) request_kind="build-cache"; trigger_file="$trigger_dir/build-cache-trigger" ;;
  *) echo "Unsupported storage request" >&2; exit 64 ;;
esac

case "$trigger_dir" in
  /*) ;;
  *) echo "STORAGE_MAINTENANCE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Storage maintenance trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Storage maintenance trigger directory is not writable" >&2; exit 73; }

umask 077
if [ "$request_kind" = build-cache ] && { [ -e "$trigger_dir/build-cache-processing" ] || [ -L "$trigger_dir/build-cache-processing" ]; }; then
  echo "Build cache operation requires receipt reconciliation" >&2
  exit 75
fi
# Exclusive creation coalesces requests without replacing an in-flight marker.
if (set -C; : > "$trigger_file") 2>/dev/null; then
  echo "Host storage $request_kind requested"
elif [ -f "$trigger_file" ] && [ ! -L "$trigger_file" ]; then
  echo "Host storage $request_kind already queued"
else
  echo "Storage request marker refused" >&2
  exit 73
fi
