#!/bin/sh
set -eu

# Installs (or with --remove, uninstalls) the single managed crontab block of
# the proactive maintenance review. Frequency comes from the versioned policy.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
policy="$script_dir/proactive-maintenance-review.policy.json"
begin="# BEGIN Smart home proactive maintenance review"
end="# END Smart home proactive maintenance review"
interval=$(sed -n 's/.*"interval_hours": *\([0-9][0-9]*\).*/\1/p' "$policy" | head -n 1)
minute=$(sed -n 's/.*"cron_minute": *\([0-9][0-9]*\).*/\1/p' "$policy" | head -n 1)
case "$interval" in 1|2|3|4|6|8|12|24) ;; *) echo "Unsupported interval_hours: $interval" >&2; exit 65 ;; esac
case "$minute" in [0-9]|[1-5][0-9]) ;; *) echo "Unsupported cron_minute: $minute" >&2; exit 65 ;; esac
if [ "$interval" -eq 24 ]; then hours="5"; else hours="*/$interval"; fi
job="$minute $hours * * * /usr/bin/flock -n $repo_root/.proactive-maintenance-review.lock /usr/bin/nice -n 15 /usr/bin/ionice -c 3 /usr/bin/node $repo_root/scripts/proactive-maintenance-review.mjs run --json >> $repo_root/.proactive-maintenance-review.cron.log 2>&1"

mode=install
case "${1:-}" in
  "") ;;
  --dry-run) printf '%s\n%s\n%s\n' "$begin" "$job" "$end"; exit 0 ;;
  --remove) mode=remove ;;
  *) echo "Usage: $0 [--dry-run|--remove]" >&2; exit 64 ;;
esac

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
if [ "$mode" = install ]; then
  {
    printf '%s\n' "$begin"
    printf '%s\n' "$job"
    printf '%s\n' "$end"
  } >> "$updated"
fi
crontab "$updated"
echo "Proactive maintenance review schedule: $mode"
