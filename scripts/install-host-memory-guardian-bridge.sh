#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${HOST_MEMORY_GUARDIAN_TRIGGER_DIR:-$repo_root/.local-state/host-memory-guardian}"
begin="# BEGIN Smart home Node-RED host memory guardian"
end="# END Smart home Node-RED host memory guardian"
job="* * * * * /usr/bin/flock -n $repo_root/.host-memory-guardian-worker.lock /usr/bin/nice -n 5 /usr/bin/ionice -c 2 -n 4 $repo_root/scripts/process-host-memory-guardian-request.sh >> $repo_root/.host-memory-guardian.cron.log 2>&1"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n%s\n%s\n' "$begin" "$job" "$end"
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
  { print }
' "$current" > "$updated"
{
  printf '%s\n' "$begin"
  printf '%s\n' "$job"
  printf '%s\n' "$end"
} >> "$updated"
crontab "$updated"
echo "Installed the Node-RED host memory guardian bridge"
