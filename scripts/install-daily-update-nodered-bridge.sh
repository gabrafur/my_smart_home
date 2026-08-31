#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
begin="# BEGIN Smart home Node-RED daily update bridge"
end="# END Smart home Node-RED daily update bridge"
request_job="* * * * * /usr/bin/flock -n $repo_root/.daily-update-request-worker.lock /usr/bin/nice -n 15 /usr/bin/ionice -c 3 $repo_root/scripts/process-daily-update-request.sh >> $repo_root/.daily-update-request.cron.log 2>&1"
kia_update_job="* * * * * /usr/bin/flock -n $repo_root/.kia-uvo-update-request-worker.lock /usr/bin/nice -n 15 /usr/bin/ionice -c 3 $repo_root/scripts/process-kia-uvo-update-request.sh >> $repo_root/.kia-uvo-update-check.cron.log 2>&1"
kia_promotion_job="* * * * * /usr/bin/flock -n $repo_root/.kia-uvo-promotion-worker.lock /usr/bin/nice -n 15 /usr/bin/ionice -c 3 /usr/bin/node $repo_root/scripts/promote-kia-uvo-candidate.mjs >> $repo_root/.kia-uvo-promotion.cron.log 2>&1"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n%s\n%s\n%s\n%s\n' "$begin" "$request_job" "$kia_update_job" "$kia_promotion_job" "$end"
  exit 0
fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--dry-run]" >&2; exit 64; }

mkdir -p "$trigger_dir"
chmod 2770 "$trigger_dir"
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
  /docker-auto-update\.mjs[[:space:]]+ha-updates([[:space:]]|$)/ { next }
  { print }
' "$current" > "$updated"
{
  printf '%s\n' "$begin"
  printf '%s\n' "$request_job"
  printf '%s\n' "$kia_update_job"
  printf '%s\n' "$kia_promotion_job"
  printf '%s\n' "$end"
} >> "$updated"
crontab "$updated"
echo "Installed Node-RED update request bridges and removed direct container and Kia UVO schedules"
