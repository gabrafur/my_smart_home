#!/bin/sh
set -eu

trigger_dir="${GIT_BACKUP_TRIGGER_DIR:-/run/git-backup-trigger}"
timeout_seconds="${GIT_BACKUP_REQUEST_TIMEOUT_SECONDS:-180}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
result_file="$trigger_dir/result"
enqueue_lock="$trigger_dir/enqueue-lock"

case "$trigger_dir" in
  /*) ;;
  *) echo "git-backup request directory must be absolute" >&2; exit 64 ;;
esac
case "$timeout_seconds" in
  ''|*[!0-9]*) echo "git-backup request timeout must be numeric" >&2; exit 64 ;;
esac

mkdir -p "$trigger_dir"
if ! mkdir "$enqueue_lock" 2>/dev/null; then
  echo "git-backup request already being queued" >&2
  exit 75
fi
cleanup() { rmdir "$enqueue_lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

if [ -f "$processing_file" ]; then
  request_id=$(sed -n '1p' "$processing_file")
elif [ -f "$request_file" ]; then
  request_id=$(sed -n '1p' "$request_file")
else
  request_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  request_tmp="$trigger_dir/requested.tmp.$$"
  printf '%s\n' "$request_id" > "$request_tmp"
  mv "$request_tmp" "$request_file"
fi
rmdir "$enqueue_lock"
trap - EXIT HUP INT TERM

elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if [ -f "$result_file" ] \
    && grep -qx "request_id=$request_id" "$result_file"; then
    status=$(sed -n 's/^status=//p' "$result_file" | head -n 1)
    finished_at=$(sed -n 's/^finished_at=//p' "$result_file" | head -n 1)
    printf 'git-backup status=%s request_id=%s finished_at=%s\n' \
      "$status" "$request_id" "$finished_at"
    case "$status" in
      success|deferred) exit 0 ;;
      failed) exit 1 ;;
      *) echo "git-backup result has invalid status" >&2; exit 65 ;;
    esac
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "git-backup request timed out while waiting for host worker" >&2
exit 75
