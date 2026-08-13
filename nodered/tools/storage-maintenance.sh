#!/bin/sh
set -eu

MODE="dry-run"
DEEP="false"
DATA_ROOT="${STORAGE_MAINTENANCE_DATA_ROOT:-/data}"
BACKUP_RETENTION_DAYS="${STORAGE_BACKUP_RETENTION_DAYS:-30}"
NPM_LOG_RETENTION_DAYS="${STORAGE_NPM_LOG_RETENTION_DAYS:-14}"

usage() {
  echo "Usage: $0 [--dry-run|--apply] [--deep]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --deep) DEEP="true" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

case "$DATA_ROOT" in
  /*) ;;
  *) echo "DATA_ROOT must be absolute" >&2; exit 64 ;;
esac
[ "$DATA_ROOT" != "/" ] || { echo "Refusing DATA_ROOT=/" >&2; exit 64; }
[ -d "$DATA_ROOT" ] || { echo "DATA_ROOT does not exist: $DATA_ROOT" >&2; exit 66; }

case "$BACKUP_RETENTION_DAYS:$NPM_LOG_RETENTION_DAYS" in
  *[!0-9:]*|:*|*:) echo "Retention values must be non-negative integers" >&2; exit 64 ;;
esac

disk_used_bytes() {
  df -P -B1 "$DATA_ROOT" | awk 'NR == 2 {print $3}'
}

dir_bytes() {
  if [ -d "$1" ]; then
    du -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
  else
    echo 0
  fi
}

inspect_and_clean() {
  target_dir=$1
  retention_days=$2
  label=$3
  [ -d "$target_dir" ] || return 0

  find -P "$target_dir" -xdev -type f -mtime "+$retention_days" -print | while IFS= read -r candidate; do
    case "$candidate" in
      "$target_dir"/*) ;;
      *) echo "Refusing candidate outside allowlisted directory: $candidate" >&2; exit 65 ;;
    esac
    size=$(wc -c < "$candidate" | tr -d ' ')
    echo "CANDIDATE|action=$label|bytes=$size|path=$candidate"
    if [ "$MODE" = "apply" ]; then
      rm -f -- "$candidate"
    fi
  done
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
before_bytes=$(disk_used_bytes)
echo "START|at=$started_at|mode=$MODE|data_root=$DATA_ROOT|before_bytes=$before_bytes"

# The only automatic deletions are regular files in these two explicit,
# non-persistent cache/backup locations. Context, flows, credentials,
# node_modules and arbitrary temporary paths are intentionally out of scope.
inspect_and_clean "$DATA_ROOT/backups/codex-flows" "$BACKUP_RETENTION_DAYS" "old_flow_backup"
inspect_and_clean "$DATA_ROOT/.npm/_logs" "$NPM_LOG_RETENTION_DAYS" "old_npm_log"

if [ "$DEEP" = "true" ]; then
  echo "INSPECT|data_bytes=$(dir_bytes "$DATA_ROOT")|backup_bytes=$(dir_bytes "$DATA_ROOT/backups")|npm_cache_bytes=$(dir_bytes "$DATA_ROOT/.npm")|context_bytes=$(dir_bytes "$DATA_ROOT/context")"
fi

after_bytes=$(disk_used_bytes)
if [ "$before_bytes" -gt "$after_bytes" ]; then
  reclaimed_bytes=$((before_bytes - after_bytes))
else
  reclaimed_bytes=0
fi
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "RESULT|status=success|at=$finished_at|mode=$MODE|before_bytes=$before_bytes|after_bytes=$after_bytes|reclaimed_bytes=$reclaimed_bytes"
