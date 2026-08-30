#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
begin="# BEGIN Smart home Node-RED daily update bridge"
end="# END Smart home Node-RED daily update bridge"
request_job="* * * * * /usr/bin/flock -n $repo_root/.daily-update-request-worker.lock /usr/bin/nice -n 15 /usr/bin/ionice -c 3 $repo_root/scripts/process-daily-update-request.sh >> $repo_root/.daily-update-request.cron.log 2>&1"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n%s\n%s\n' "$begin" "$request_job" "$end"
  exit 0
fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--dry-run]" >&2; exit 64; }

mkdir -p "$trigger_dir"
chmod 0770 "$trigger_dir"
current=$(mktemp)
updated=$(mktemp)
cleanup() { rm -f -- "$current" "$updated"; }
trap cleanup EXIT HUP INT TERM
crontab -l > "$current" 2>/dev/null || true
awk -v begin="$begin" -v end="$end" '
  $0 == begin { skipping = 1; next }
  $0 == end { skipping = 0; next }
  skipping { next }
  /Smart home Docker auto update/ { next }
  /docker-auto-update\.mjs[[:space:]]+daily([[:space:]]|$)/ { next }
  { print }
' "$current" > "$updated"
{
  printf '%s\n' "$begin"
  printf '%s\n' "$request_job"
  printf '%s\n' "$end"
} >> "$updated"
crontab "$updated"
echo "Installed Node-RED daily update request bridge and removed the direct daily container schedule"
