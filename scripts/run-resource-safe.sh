#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/run-resource-safe.sh COMMAND [ARG ...]" >&2
  exit 2
fi

min_available_kb=${RESOURCE_SAFE_MIN_AVAILABLE_KB:-2097152}
max_disk_percent=${RESOURCE_SAFE_MAX_DISK_PERCENT:-85}
lock_file=${RESOURCE_SAFE_LOCK_FILE:-/tmp/my-smart-home-public-validation.lock}

available_kb=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)
if [ -n "$available_kb" ] && [ "$available_kb" -lt "$min_available_kb" ]; then
  echo "resource-safe: refusing validation; less than 2 GiB of RAM is available" >&2
  exit 75
fi

disk_percent=${RESOURCE_SAFE_DISK_USE_PERCENT:-$(df -P . | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')}
if [ -n "$disk_percent" ] && [ "$disk_percent" -ge "$max_disk_percent" ]; then
  echo "resource-safe: refusing validation; repository filesystem is at or above ${max_disk_percent}%" >&2
  exit 75
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "resource-safe: another broad validation is already running" >&2
    exit 75
  fi
else
  lock_dir="${lock_file}.d"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "resource-safe: another broad validation is already running" >&2
    exit 75
  fi
  cleanup() {
    rmdir "$lock_dir" 2>/dev/null || true
  }
  trap cleanup EXIT HUP INT TERM
fi

# Keep repository validation below interactive SSH and home-automation work.
# `nice` and idle-class `ionice` are best-effort so CI remains portable.
if command -v ionice >/dev/null 2>&1; then
  nice -n 15 ionice -c 3 "$@"
  exit $?
fi
nice -n 15 "$@"
