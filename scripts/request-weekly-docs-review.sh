#!/bin/sh
set -eu

trigger_dir="${WEEKLY_DOCS_REVIEW_TRIGGER_DIR:-/run/docs-review-trigger}"
trigger_file="$trigger_dir/manual-trigger"

case "$trigger_dir" in
  /*) ;;
  *) echo "WEEKLY_DOCS_REVIEW_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -d "$trigger_dir" ] || { echo "Documentation review trigger directory is unavailable" >&2; exit 66; }
[ -w "$trigger_dir" ] || { echo "Documentation review trigger directory is not writable" >&2; exit 73; }

umask 077
: > "$trigger_file"
echo "Documentation review requested"
