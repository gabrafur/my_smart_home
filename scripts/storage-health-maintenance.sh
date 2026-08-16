#!/bin/sh
set -eu

MODE="dry-run"
DEEP="false"
DATA_ROOT="${STORAGE_MAINTENANCE_DATA_ROOT:-/data}"
LOCK_DIR="${STORAGE_MAINTENANCE_LOCK_DIR:-/tmp/storage-health-maintenance.lock}"
BACKUP_RETENTION_DAYS="${STORAGE_BACKUP_RETENTION_DAYS:-30}"
NPM_LOG_RETENTION_DAYS="${STORAGE_NPM_LOG_RETENTION_DAYS:-14}"
manifest=""
lock_acquired="false"

usage() {
  echo "Usage: $0 [--dry-run|--apply] [--deep]" >&2
}

die() {
  echo "$*" >&2
  exit 64
}

cleanup() {
  [ -z "$manifest" ] || rm -f -- "$manifest"
  [ "$lock_acquired" != "true" ] || rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup 0

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
  *) die "DATA_ROOT must be absolute" ;;
esac
[ "$DATA_ROOT" != "/" ] || die "Refusing DATA_ROOT=/"
[ -d "$DATA_ROOT" ] || { echo "DATA_ROOT does not exist: $DATA_ROOT" >&2; exit 66; }

case "$LOCK_DIR" in
  /*) ;;
  *) die "LOCK_DIR must be absolute" ;;
esac
[ "$LOCK_DIR" != "/" ] || die "Refusing LOCK_DIR=/"

case "$BACKUP_RETENTION_DAYS" in
  ''|*[!0-9]*) die "STORAGE_BACKUP_RETENTION_DAYS must be a non-negative integer" ;;
esac
case "$NPM_LOG_RETENTION_DAYS" in
  ''|*[!0-9]*) die "STORAGE_NPM_LOG_RETENTION_DAYS must be a non-negative integer" ;;
esac

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "RESULT|status=skipped|at=$now|mode=$MODE|reason=already_running"
  exit 0
fi
lock_acquired="true"

numeric_value() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

disk_used_bytes() {
  df_output=$(df -P -B1 "$DATA_ROOT") || {
    echo "Cannot read disk usage for $DATA_ROOT" >&2
    return 1
  }
  value=$(printf '%s\n' "$df_output" | awk 'NR == 2 {print $3}')
  numeric_value "$value" || { echo "Cannot read used bytes for $DATA_ROOT" >&2; return 1; }
  printf '%s\n' "$value"
}

dir_bytes() {
  [ -d "$1" ] || { printf '0\n'; return 0; }
  du_output=$(du -sk "$1") || {
    echo "Cannot read size for $1" >&2
    return 1
  }
  value=$(printf '%s\n' "$du_output" | awk 'NR == 1 {print $1 * 1024}')
  numeric_value "$value" || { echo "Cannot read size for $1" >&2; return 1; }
  printf '%s\n' "$value"
}

inspect_and_clean() {
  target_dir=$1
  retention_days=$2
  label=$3
  [ -d "$target_dir" ] || return 0

  manifest=$(mktemp "${TMPDIR:-/tmp}/storage-health-maintenance.XXXXXX") || {
    echo "Cannot create maintenance manifest" >&2
    return 1
  }
  if ! find "$target_dir" -xdev -type f -mtime "+$retention_days" -print > "$manifest"; then
    echo "Cannot inspect allowlisted directory: $target_dir" >&2
    return 1
  fi

  while IFS= read -r candidate || [ -n "$candidate" ]; do
    case "$candidate" in
      "$target_dir"/*) ;;
      *) echo "Refusing candidate outside allowlisted directory: $candidate" >&2; return 1 ;;
    esac
    size=$(wc -c < "$candidate") || {
      echo "Cannot read candidate size: $candidate" >&2
      return 1
    }
    size=$(printf '%s' "$size" | tr -d '[:space:]')
    numeric_value "$size" || { echo "Cannot read candidate size: $candidate" >&2; return 1; }
    candidate_count=$((candidate_count + 1))
    candidate_bytes=$((candidate_bytes + size))
    echo "CANDIDATE|action=$label|bytes=$size|path=$candidate"
    if [ "$MODE" = "apply" ]; then
      rm -f -- "$candidate"
      removed_count=$((removed_count + 1))
      removed_bytes=$((removed_bytes + size))
    fi
  done < "$manifest"

  rm -f -- "$manifest"
  manifest=""
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
before_bytes=$(disk_used_bytes)
candidate_count=0
candidate_bytes=0
removed_count=0
removed_bytes=0
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
echo "RESULT|status=success|at=$finished_at|mode=$MODE|before_bytes=$before_bytes|after_bytes=$after_bytes|reclaimed_bytes=$reclaimed_bytes|candidate_count=$candidate_count|candidate_bytes=$candidate_bytes|removed_count=$removed_count|removed_bytes=$removed_bytes"
