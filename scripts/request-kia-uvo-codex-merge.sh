#!/bin/sh
set -eu

trigger_dir="${KIA_UVO_MERGE_TRIGGER_DIR:-/run/kia-uvo-merge-trigger}"
status_path="${KIA_UVO_MERGE_STATUS_PATH:-/run/kia-uvo-merge/status.json}"
target="${1:-}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
request_lock="$trigger_dir/request.lock"

case "$trigger_dir" in /*) ;; *) echo "KIA_UVO_MERGE_TRIGGER_DIR must be absolute" >&2; exit 64 ;; esac
case "$target" in
  v[0-9]*.[0-9]*.[0-9]*|[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Kia UVO merge target is invalid" >&2; exit 64 ;;
esac
case "$target" in v*) ;; *) target="v$target" ;; esac
case "$target" in *[!A-Za-z0-9.v+-]*) echo "Kia UVO merge target is invalid" >&2; exit 64 ;; esac

[ -d "$trigger_dir" ] || { echo "Kia UVO merge trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Kia UVO merge trigger directory is not writable" >&2; exit 73; }

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "kia-uvo-codex-merge-request status=coalesced target=$target reason=busy"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ] || [ -f "$processing_file" ]; then
  echo "kia-uvo-codex-merge-request status=coalesced target=$target reason=pending"
  exit 0
fi
if [ -r "$status_path" ] && grep -Fq '"state":"success"' "$status_path" \
    && grep -Fq "\"target\":\"$target\"" "$status_path"; then
  echo "kia-uvo-codex-merge-request status=coalesced target=$target reason=completed"
  exit 0
fi

temporary="$trigger_dir/requested.$$"
umask 007
printf '%s\n' "$target" > "$temporary"
mv "$temporary" "$request_file"
echo "kia-uvo-codex-merge-request status=accepted target=$target"
