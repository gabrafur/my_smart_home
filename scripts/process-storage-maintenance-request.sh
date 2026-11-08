#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${STORAGE_MAINTENANCE_TRIGGER_DIR:-$repo_root/homeassistant/.storage-maintenance-trigger}"
maintenance_script="${STORAGE_MAINTENANCE_SCRIPT:-$script_dir/storage-maintenance.sh}"
request_file="$trigger_dir/manual-trigger"
processing_file="$trigger_dir/processing"
build_cache_helper="${STORAGE_BUILD_CACHE_HELPER:-$script_dir/docker-build-cache-maintenance.py}"
python_bin="${STORAGE_BUILD_CACHE_PYTHON:-python3}"
processor_lock="${STORAGE_MAINTENANCE_PROCESSOR_LOCK:-$repo_root/.local-state/storage-request-processor.lock}"

case "$trigger_dir" in
  /*) ;;
  *) echo "STORAGE_MAINTENANCE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -x "$maintenance_script" ] || { echo "Storage maintenance script is unavailable: $maintenance_script" >&2; exit 66; }
mkdir -p "$trigger_dir"

# One transport worker owns both marker lifecycles; the cache helper also locks
# maintenance and records its intent durably before any destructive request.
[ ! -L "$processor_lock" ] || { echo "Processor lock refused" >&2; exit 73; }
exec 9>"$processor_lock"
flock -n 9 || exit 0
cache_status=0
if [ -e "$trigger_dir/build-cache-processing" ] || [ -L "$trigger_dir/build-cache-processing" ]; then
  echo "Build cache receipt reconciliation required; no retry" >&2
  cache_status=75
fi
if [ "$cache_status" -eq 0 ] && [ -f "$trigger_dir/build-cache-trigger" ] && [ ! -L "$trigger_dir/build-cache-trigger" ]; then
  [ -f "$build_cache_helper" ] || { echo "Build cache helper unavailable" >&2; exit 66; }
  mv -- "$trigger_dir/build-cache-trigger" "$trigger_dir/build-cache-processing"
  if "$python_bin" "$build_cache_helper" --daily; then
    rm -- "$trigger_dir/build-cache-processing"
  else
    helper_status=$?
    if [ "$helper_status" -eq 75 ] && [ ! -e "$trigger_dir/build-cache-trigger" ] && [ ! -L "$trigger_dir/build-cache-trigger" ]; then
      # The fixed helper reserves 75 for lock refusal before run()/dispatch.
      # Preserve the same request for the next worker; never replay uncertainty.
      mv -- "$trigger_dir/build-cache-processing" "$trigger_dir/build-cache-trigger"
      echo "Build cache deferred before dispatch: maintenance busy"
      cache_status=75
    else
      # Even a timeout can follow dispatch. Keep the exact marker and helper
      # receipt for reconciliation instead of restoring an executable request.
      echo "Build cache result not confirmed; inspect existing receipt" >&2
      cache_status=1
    fi
  fi
fi
[ -f "$request_file" ] && [ ! -L "$request_file" ] || exit "$cache_status"
if ! mv "$request_file" "$processing_file" 2>/dev/null; then
  exit 0
fi

restore_request() {
  rm -f -- "$request_file"
  : > "$request_file"
  rm -f -- "$processing_file"
}
trap restore_request HUP INT TERM

# Health requests refresh metadata only. Cleanup belongs to the closed,
# owner-approved recoverable catalogue and its separate execution gates.
# The separate scheduled cache marker above is the only added execution route.
if "$maintenance_script" --apply --category report; then
  rm -f -- "$processing_file"
  trap - HUP INT TERM
  exit "$cache_status"
fi

restore_request
exit 1
