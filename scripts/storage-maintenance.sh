#!/usr/bin/env bash
set -Eeuo pipefail

MODE="dry-run"
MIN_AGE="168h"
STEP="startup"

usage() {
  echo "Usage: $0 [--dry-run|--apply] [--min-age HOURS]" >&2
}

while (($#)); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --min-age)
      shift
      [[ ${1:-} =~ ^[0-9]+$ ]] || { echo "--min-age must be an integer number of hours" >&2; exit 64; }
      MIN_AGE="${1}h"
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

log() {
  printf '%s step=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEP" "$*"
}

on_error() {
  local exit_code=$?
  log "status=failed exit_code=$exit_code"
  exit "$exit_code"
}
trap on_error ERR

disk_used_bytes() {
  df -B1 --output=used / | awk 'NR == 2 {print $1}'
}

STEP="preflight"
command -v docker >/dev/null
docker info >/dev/null
BEFORE_BYTES=$(disk_used_bytes)
log "status=started mode=$MODE min_age=$MIN_AGE filesystem=/ used_bytes=$BEFORE_BYTES"

STEP="inventory"
docker system df
echo "Dangling image candidates (the daemon always preserves images used by containers):"
docker image ls --filter dangling=true --format '  {{.ID}} {{.CreatedSince}} {{.Size}}'
echo "Stopped containers (diagnostic only; never removed by this script):"
docker ps -a --filter status=exited --format '  {{.ID}} {{.Names}} {{.Status}} {{.Size}}'

if [[ "$MODE" == "apply" ]]; then
  STEP="build-cache-prune"
  docker builder prune --force --filter "until=$MIN_AGE"

  STEP="dangling-image-prune"
  docker image prune --force --filter "until=$MIN_AGE"
else
  STEP="dry-run"
  log "status=skipped reason=dry-run actions=builder-prune,dangling-image-prune"
fi

STEP="final-metrics"
AFTER_BYTES=$(disk_used_bytes)
if (( BEFORE_BYTES > AFTER_BYTES )); then
  RECLAIMED_BYTES=$((BEFORE_BYTES - AFTER_BYTES))
else
  RECLAIMED_BYTES=0
fi
docker system df
log "status=success mode=$MODE filesystem=/ before_bytes=$BEFORE_BYTES after_bytes=$AFTER_BYTES reclaimed_bytes=$RECLAIMED_BYTES"
