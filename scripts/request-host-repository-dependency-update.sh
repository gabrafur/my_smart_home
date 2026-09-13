#!/bin/sh
set -eu

package="${1:-}"
printf '%s' "$package" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,79}$' || {
  echo "Usage: $0 package" >&2
  exit 64
}

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
request_file="$trigger_dir/repository-dependency-requested"
processing_file="$trigger_dir/repository-dependency-processing"
request_lock="$trigger_dir/repository-dependency-request.lock"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Repository dependency trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Repository dependency trigger directory is not writable" >&2; exit 73; }

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "repository-dependency-request package=$package status=coalesced request_id=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

pending_file=""
[ -f "$request_file" ] && pending_file="$request_file"
[ -z "$pending_file" ] && [ -f "$processing_file" ] && pending_file="$processing_file"
if [ -n "$pending_file" ]; then
  request_id=$(sed -n '1p' "$pending_file" | tr -cd 'A-Za-z0-9_.:-')
  pending_package=$(sed -n '2p' "$pending_file" | tr -cd 'a-z0-9._-')
  if [ "$pending_package" = "$package" ]; then
    echo "repository-dependency-request package=$package status=coalesced request_id=${request_id:-pending}"
  else
    echo "repository-dependency-request package=$package status=deferred request_id=${request_id:-busy} reason=other-package-pending"
  fi
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/repository-dependency-requested.$$"
umask 007
printf '%s\n%s\n' "$request_id" "$package" > "$temporary"
mv "$temporary" "$request_file"
echo "repository-dependency-request package=$package status=accepted request_id=$request_id"
