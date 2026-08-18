#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${GIT_BACKUP_TRIGGER_DIR:-$repo_root/homeassistant/.git-backup-trigger}"
begin="# BEGIN Smart home Node-RED Git backup bridge"
end="# END Smart home Node-RED Git backup bridge"
job="* * * * * RESOURCE_SAFE_LOCK_FILE=$repo_root/.git-backup-request-worker.lock $repo_root/scripts/run-resource-safe.sh $repo_root/scripts/process-git-backup-request.sh >> $repo_root/.git-backup-request.cron.log 2>&1"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n%s\n%s\n' "$begin" "$job" "$end"
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
  $0 == "# Smart home Git backup - created by Codex" { next }
  /\/scripts\/git-backup\.sh([[:space:]]|$)/ { next }
  { print }
' "$current" > "$updated"
{
  printf '%s\n' "$begin"
  printf '%s\n' "$job"
  printf '%s\n' "$end"
} >> "$updated"
crontab "$updated"
echo "Installed Node-RED Git backup host bridge and removed direct Git backup cron entries"
