#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${GIT_BACKUP_TRIGGER_DIR:-$repo_root/homeassistant/.git-backup-trigger}"
backup_script="${GIT_BACKUP_SCRIPT:-$script_dir/git-backup.sh}"
request_file="$trigger_dir/requested"
processing_file="$trigger_dir/processing"
result_file="$trigger_dir/result"

case "$trigger_dir" in
  /*) ;;
  *) echo "GIT_BACKUP_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -x "$backup_script" ] || { echo "Git backup script is unavailable: $backup_script" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  mv "$request_file" "$processing_file" 2>/dev/null || exit 0
fi

request_id=$(sed -n '1p' "$processing_file")
case "$request_id" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9]*) ;;
  *) rm -f -- "$processing_file"; echo "Invalid Git backup request" >&2; exit 65 ;;
esac

status=success
exit_code=0
if "$backup_script"; then
  :
else
  exit_code=$?
  if [ "$exit_code" -eq 75 ]; then
    # Keep the claimed request in place, but publish the recoverable state so
    # Node-RED can stop waiting and schedule a new observation without raising
    # a definitive-failure alert. The minute worker will resume this same
    # request after the shared validation slot or resource preflight clears.
    result_tmp="$trigger_dir/result.tmp.$$"
    {
      printf 'request_id=%s\n' "$request_id"
      printf 'status=deferred\n'
      printf 'exit_code=%s\n' "$exit_code"
      printf 'finished_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    } > "$result_tmp"
    mv "$result_tmp" "$result_file"
    exit 75
  fi
  status=failed
fi

result_tmp="$trigger_dir/result.tmp.$$"
{
  printf 'request_id=%s\n' "$request_id"
  printf 'status=%s\n' "$status"
  printf 'exit_code=%s\n' "$exit_code"
  printf 'finished_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$result_tmp"
mv "$result_tmp" "$result_file"
rm -f -- "$processing_file"
[ "$status" = "success" ]
