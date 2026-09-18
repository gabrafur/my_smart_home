#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="$repo_root/homeassistant/.codex-remote-recovery-trigger"
begin="# BEGIN Smart home Codex remote recovery"
end="# END Smart home Codex remote recovery"
worker="* * * * * /usr/bin/flock -n $repo_root/.codex-remote-recovery.lock $repo_root/scripts/process-host-codex-remote-recovery-request.sh >> $repo_root/.codex-remote-recovery.cron.log 2>&1"
health="* * * * * /usr/bin/flock -n $repo_root/.codex-remote-health.lock /usr/bin/nice -n 10 /usr/bin/node $repo_root/scripts/codex-remote-health-publisher.mjs --publish >> $repo_root/.codex-remote-health.cron.log 2>&1"
if [ "${1:-}" = "--dry-run" ]; then printf '%s\n%s\n%s\n%s\n' "$begin" "$worker" "$health" "$end"; exit 0; fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--dry-run]" >&2; exit 64; }
mkdir -p "$trigger_dir"
chmod 2770 "$trigger_dir"
current=$(mktemp)
updated=$(mktemp)
cleanup() { rm -f -- "$current" "$updated"; }
trap cleanup EXIT HUP INT TERM
crontab -l > "$current" 2>/dev/null || true
awk -v begin="$begin" -v end="$end" '$0 == begin { skip=1; next } $0 == end { skip=0; next } !skip { print }' "$current" > "$updated"
printf '%s\n%s\n%s\n%s\n' "$begin" "$worker" "$health" "$end" >> "$updated"
crontab "$updated"
echo "Installed Codex remote recovery bridge"
