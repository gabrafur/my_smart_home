#!/bin/sh
set -eu

trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}"
request_file="$trigger_dir/kia-uvo-requested"
processing_file="$trigger_dir/kia-uvo-processing"
followup_file="$trigger_dir/kia-uvo-followup"
request_lock="$trigger_dir/kia-uvo-request.lock"
request_spec="${1:-}"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Kia UVO update trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Kia UVO update trigger directory is not writable" >&2; exit 73; }
printf '%s' "$request_spec" | grep -Eq '^(audit|install):v[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$' || {
  echo "kia-uvo-update-request status=rejected reason=invalid_request"
  exit 64
}
mode=${request_spec%%:*}
target=${request_spec#*:}

if ! mkdir "$request_lock" 2>/dev/null; then
  echo "kia-uvo-update-request status=coalesced request_id=busy mode=$mode target=$target"
  exit 0
fi
cleanup() { rmdir "$request_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$request_file" ]; then
  request_id=$(sed -n '1p' "$request_file" 2>/dev/null || printf pending)
  pending_mode=$(sed -n '2p' "$request_file" 2>/dev/null || printf unknown)
  pending_target=$(sed -n '3p' "$request_file" 2>/dev/null || printf unknown)
  if [ "$mode" = install ] && [ "$pending_mode" = audit ] && [ "$pending_target" = "$target" ]; then
    temporary="$trigger_dir/kia-uvo-requested.$$"
    umask 007
    printf '%s\ninstall\n%s\n' "$request_id" "$target" > "$temporary"
    mv "$temporary" "$request_file"
    echo "kia-uvo-update-request status=accepted request_id=$request_id mode=install target=$target reason=upgraded"
    exit 0
  fi
  echo "kia-uvo-update-request status=coalesced request_id=$request_id mode=$pending_mode target=$pending_target"
  exit 0
fi
if [ -f "$processing_file" ]; then
  request_id=$(sed -n '1p' "$processing_file" 2>/dev/null || printf pending)
  pending_mode=$(sed -n '2p' "$processing_file" 2>/dev/null || printf unknown)
  pending_target=$(sed -n '3p' "$processing_file" 2>/dev/null || printf unknown)
  if [ "$mode" = install ]; then
    followup_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    temporary="$trigger_dir/kia-uvo-followup.$$"
    umask 007
    printf '%s\ninstall\n%s\n' "$followup_id" "$target" > "$temporary"
    mv "$temporary" "$followup_file"
    echo "kia-uvo-update-request status=accepted request_id=$followup_id mode=install target=$target reason=queued_after_audit"
    exit 0
  fi
  echo "kia-uvo-update-request status=coalesced request_id=$request_id mode=$pending_mode target=$pending_target"
  exit 0
fi

request_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary="$trigger_dir/kia-uvo-requested.$$"
umask 007
printf '%s\n%s\n%s\n' "$request_id" "$mode" "$target" > "$temporary"
mv "$temporary" "$request_file"
echo "kia-uvo-update-request status=accepted request_id=$request_id mode=$mode target=$target"
