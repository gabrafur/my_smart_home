#!/usr/bin/env bash
set -Eeuo pipefail

MODE="dry-run"
MIN_AGE="24h"
MAX_BUILD_CACHE="2GB"
STEP="startup"
LOCK_FILE="${STORAGE_MAINTENANCE_LOCK_FILE:-/tmp/my-smart-home-storage-maintenance.lock}"
FILESYSTEM="${STORAGE_MAINTENANCE_FILESYSTEM:-/}"
MEMINFO_FILE="${STORAGE_MAINTENANCE_MEMINFO_FILE:-/proc/meminfo}"
MIN_AVAILABLE_KB="${STORAGE_MAINTENANCE_MIN_AVAILABLE_KB:-2097152}"
MAX_DISK_PERCENT="${STORAGE_MAINTENANCE_MAX_DISK_PERCENT:-85}"

usage() {
  echo "Usage: $0 [--dry-run|--apply] [--min-age HOURS] [--max-build-cache SIZE]" >&2
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
    --max-build-cache)
      shift
      [[ ${1:-} =~ ^[1-9][0-9]*([KMGT]B)?$ ]] || { echo "--max-build-cache must be a positive Docker size such as 2GB" >&2; exit 64; }
      MAX_BUILD_CACHE="$1"
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

STEP="lock"
if command -v flock >/dev/null 2>&1; then
  exec 8>"$LOCK_FILE"
  if ! flock -n 8; then
    log "status=skipped reason=already_running"
    exit 0
  fi
fi

disk_used_bytes() {
  df -B1 --output=used "$FILESYSTEM" | awk 'NR == 2 {print $1}'
}

STEP="preflight"
command -v docker >/dev/null
docker info >/dev/null
BEFORE_BYTES=$(disk_used_bytes)
log "status=started mode=$MODE min_age=$MIN_AGE max_build_cache=$MAX_BUILD_CACHE filesystem=$FILESYSTEM used_bytes=$BEFORE_BYTES"

if [[ "$MODE" == "apply" ]]; then
  STEP="resource-safety"
  AVAILABLE_KB=$(awk '/^MemAvailable:/ { print $2; exit }' "$MEMINFO_FILE" 2>/dev/null || true)
  DISK_PERCENT=$(df -P "$FILESYSTEM" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
  if [[ -n "$AVAILABLE_KB" ]] && (( AVAILABLE_KB < MIN_AVAILABLE_KB )); then
    log "status=skipped reason=low_available_memory available_kb=$AVAILABLE_KB required_kb=$MIN_AVAILABLE_KB"
    exit 75
  fi
  if [[ -n "$DISK_PERCENT" ]] && (( DISK_PERCENT >= MAX_DISK_PERCENT )); then
    log "status=skipped reason=filesystem_pressure used_percent=$DISK_PERCENT maximum_percent=$MAX_DISK_PERCENT"
    exit 75
  fi
fi

STEP="inventory"
docker system df
echo "Dangling image candidates (the daemon always preserves images used by containers):"
docker image ls --filter dangling=true --format '  {{.ID}} {{.CreatedSince}} {{.Size}}'
echo "Stopped containers (diagnostic only; never removed by this script):"
docker ps -a --filter status=exited --format '  {{.ID}} {{.Names}} {{.Status}} {{.Size}}'

if [[ "$MODE" == "apply" ]]; then
  STEP="build-cache-prune"
  # A recent build can keep an entire old dependency chain reachable, so an
  # age-only filter does not bound disk usage. Keep a useful hot cache while
  # pruning only BuildKit records that no container or image needs.
  docker builder prune --all --force --max-used-space "$MAX_BUILD_CACHE"

  STEP="dangling-image-prune"
  docker image prune --force --filter "until=$MIN_AGE"
else
  STEP="dry-run"
  log "status=skipped reason=dry-run actions=builder-prune-to-${MAX_BUILD_CACHE},dangling-image-prune"
fi

STEP="final-metrics"
AFTER_BYTES=$(disk_used_bytes)
if (( BEFORE_BYTES > AFTER_BYTES )); then
  RECLAIMED_BYTES=$((BEFORE_BYTES - AFTER_BYTES))
else
  RECLAIMED_BYTES=0
fi
docker system df
log "status=success mode=$MODE filesystem=$FILESYSTEM before_bytes=$BEFORE_BYTES after_bytes=$AFTER_BYTES reclaimed_bytes=$RECLAIMED_BYTES"
