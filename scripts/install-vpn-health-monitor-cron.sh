#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
begin="# BEGIN Smart home VPN health publisher"
end="# END Smart home VPN health publisher"
job="* * * * * /usr/bin/flock -n $repo_root/.vpn-health-publisher.lock /usr/bin/nice -n 10 /usr/bin/node $repo_root/scripts/vpn-health-publisher.mjs --publish >> $repo_root/.vpn-health-publisher.cron.log 2>&1"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n%s\n%s\n' "$begin" "$job" "$end"
  exit 0
fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--dry-run]" >&2; exit 64; }

current=$(mktemp)
updated=$(mktemp)
cleanup() { rm -f -- "$current" "$updated"; }
trap cleanup EXIT HUP INT TERM
crontab -l > "$current" 2>/dev/null || true
awk -v begin="$begin" -v end="$end" '
  $0 == begin { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "$current" > "$updated"
{
  printf '%s\n' "$begin"
  printf '%s\n' "$job"
  printf '%s\n' "$end"
} >> "$updated"
crontab "$updated"
echo "Installed smart home VPN health publisher"
