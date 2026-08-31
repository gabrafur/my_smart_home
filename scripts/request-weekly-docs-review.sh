#!/bin/sh
set -eu

trigger_dir="${WEEKLY_DOCS_REVIEW_TRIGGER_DIR:-/run/docs-review-trigger}"
trigger_file="$trigger_dir/manual-trigger"
source="${1:-manual}"

case "$trigger_dir" in
  /*) ;;
  *) echo "WEEKLY_DOCS_REVIEW_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
case "$source" in
  manual|scheduled) ;;
  *) echo "documentation review source must be manual or scheduled" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Documentation review trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Documentation review trigger directory is not writable" >&2; exit 73; }

umask 007
if [ -e "$trigger_file" ]; then
  echo "Documentation review already pending: source=$source"
  exit 0
fi

trigger_tmp="$trigger_dir/manual-trigger.tmp.$$"
cleanup() { rm -f -- "$trigger_tmp"; }
trap cleanup EXIT HUP INT TERM
printf '%s\n' "$source" > "$trigger_tmp"
mv "$trigger_tmp" "$trigger_file"
trap - EXIT HUP INT TERM
echo "Documentation review requested: source=$source"
