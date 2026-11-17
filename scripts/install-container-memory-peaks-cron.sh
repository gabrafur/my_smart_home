#!/bin/sh
# Record each container's memory peak every 10 minutes (read only; see
# scripts/container-memory-peaks.mjs). Idempotent; --remove uninstalls.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
begin="# BEGIN Smart home container memory peaks"
end="# END Smart home container memory peaks"
job="*/10 * * * * /usr/bin/flock -n $repo_root/.container-memory-peaks.lock /usr/bin/nice -n 15 /usr/bin/node $repo_root/scripts/container-memory-peaks.mjs >> $repo_root/.container-memory-peaks.cron.log 2>&1"

case "${1:-}" in
  --dry-run) printf '%s\n%s\n%s\n' "$begin" "$job" "$end"; exit 0 ;;
  --remove|"") ;;
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
if [ "${1:-}" != --remove ]; then
  printf '%s\n%s\n%s\n' "$begin" "$job" "$end" >> "$updated"
fi
crontab "$updated"
echo "container memory peaks cron: ${1:-installed}"
