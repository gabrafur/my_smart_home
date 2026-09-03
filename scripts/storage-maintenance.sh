#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s lastpipe

MODE="dry-run"
ALLOW_PRIVILEGED_CLEANUP="false"
STEP="startup"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")
FILESYSTEM="${STORAGE_MAINTENANCE_FILESYSTEM-/}"
MEMINFO_FILE="${STORAGE_MAINTENANCE_MEMINFO_FILE-/proc/meminfo}"
LOCK_PATH="${STORAGE_MAINTENANCE_LOCK_PATH-/tmp}"
METRICS_ROOT="${STORAGE_MAINTENANCE_METRICS_ROOT-$REPO_ROOT/homeassistant}"
METRICS_FILE="${STORAGE_MAINTENANCE_METRICS_FILE-$METRICS_ROOT/storage-maintenance-status.json}"
TEMP_ROOT="${STORAGE_MAINTENANCE_TEMP_ROOT-/tmp}"
NODE_RED_ROOT="${STORAGE_MAINTENANCE_NODE_RED_ROOT-$REPO_ROOT/nodered}"
DOCKER_BIN="${STORAGE_MAINTENANCE_DOCKER_BIN-docker}"
JOURNALCTL_BIN="${STORAGE_MAINTENANCE_JOURNALCTL_BIN-journalctl}"
APT_GET_BIN="${STORAGE_MAINTENANCE_APT_GET_BIN-apt-get}"
NPM_BIN="${STORAGE_MAINTENANCE_NPM_BIN-npm}"
PYTHON_BIN="${STORAGE_MAINTENANCE_PYTHON_BIN-python3}"
USER_HOME="${STORAGE_MAINTENANCE_USER_HOME-/home/gabriel}"
USER_CACHE_ROOT="${STORAGE_MAINTENANCE_USER_CACHE_ROOT-$USER_HOME/.cache}"
NPM_CACHE_ROOT="${STORAGE_MAINTENANCE_NPM_CACHE_ROOT-$USER_HOME/.npm}"
PM2_ROOT="${STORAGE_MAINTENANCE_PM2_ROOT-$USER_HOME/.pm2}"
VSCODE_ROOT="${STORAGE_MAINTENANCE_VSCODE_ROOT-$USER_HOME/.vscode-server}"
CURSOR_ROOT="${STORAGE_MAINTENANCE_CURSOR_ROOT-$USER_HOME/.cursor-server}"
MIN_AVAILABLE_KB="${STORAGE_MAINTENANCE_MIN_AVAILABLE_KB-2097152}"
MIN_FREE_BYTES="${STORAGE_MAINTENANCE_MIN_FREE_BYTES-2147483648}"
MAX_DISK_PERCENT="${STORAGE_MAINTENANCE_MAX_DISK_PERCENT-85}"
MIN_AGE_HOURS="${STORAGE_MAINTENANCE_IMAGE_MIN_AGE_HOURS-24}"
MAX_BUILD_CACHE="${STORAGE_MAINTENANCE_MAX_BUILD_CACHE-2GB}"
LOG_RETENTION_DAYS="${STORAGE_MAINTENANCE_LOG_RETENTION_DAYS-14}"
TEMP_RETENTION_DAYS="${STORAGE_MAINTENANCE_TEMP_RETENTION_DAYS-7}"
PROJECT_RETENTION_DAYS="${STORAGE_MAINTENANCE_PROJECT_RETENTION_DAYS-30}"
JOURNAL_RETENTION_DAYS="${STORAGE_MAINTENANCE_JOURNAL_RETENTION_DAYS-30}"
HA_BACKUP_RETENTION_DAYS="${STORAGE_MAINTENANCE_HA_BACKUP_RETENTION_DAYS-14}"
HA_BACKUP_KEEP_COUNT="${STORAGE_MAINTENANCE_HA_BACKUP_KEEP_COUNT-2}"
HA_CONFIG_ROOT="${STORAGE_MAINTENANCE_HA_CONFIG_ROOT-$REPO_ROOT/homeassistant}"
HA_BACKUP_ROOT="${STORAGE_MAINTENANCE_HA_BACKUP_ROOT-$HA_CONFIG_ROOT/backups}"
HA_CONTAINER="${STORAGE_MAINTENANCE_HA_CONTAINER-homeassistant}"
PM2_LOG_MAX_BYTES="${STORAGE_MAINTENANCE_PM2_LOG_MAX_BYTES-10485760}"
PM2_LOG_RETENTION_FILES="${STORAGE_MAINTENANCE_PM2_LOG_RETENTION_FILES-7}"
VSCODE_KEEP_VERSIONS="${STORAGE_MAINTENANCE_VSCODE_KEEP_VERSIONS-2}"
declare -a CATEGORIES=()
declare -a DEFAULT_CATEGORIES=(
  report logs pm2-logs temporary-files docker-images docker-build-cache
  project-artifacts npm-cache python-cache vscode-versions vscode-cache
  home-assistant-backups
)
declare -A CATEGORY_RECLAIMED=()
declare -a TEMP_PREFIXES=(
  local-ai-mcp- privacy-git-fixture- public-memory-check- security-scan-test-
  storage-maintenance-test- storage-request-test- storage-request-retry-test-
  weekly-review-test-
)
WARNINGS=0
REMOVED_COUNT=0
REMOVED_BYTES=0
METRICS_TEMP=""

usage() {
  cat >&2 <<'EOF'
Usage: storage-maintenance.sh [--dry-run|--apply] [options]

Default mode: --dry-run. Default categories are low-risk only.

Options:
  --category NAME                  Run one category; may be repeated
  --min-age HOURS                  Minimum age for untagged Docker images
  --max-build-cache SIZE           BuildKit cache ceiling, for example 2GB
  --log-retention-days DAYS        Allowlisted rotated-log retention
  --temporary-retention-days DAYS  Known generated /tmp directory retention
  --project-retention-days DAYS    Allowlisted project-artifact retention
  --journal-retention-days DAYS    Explicit journald category retention
  --ha-backup-retention-days DAYS  Age threshold used in backup reporting
  --ha-backup-keep-count COUNT     Keep this many newest HA backup archives
  --pm2-log-max-bytes BYTES        Rotate allowlisted PM2 logs at this size
  --pm2-log-retention-files COUNT  Keep this many compressed rotations per log
  --vscode-keep-versions COUNT     Keep at least this many newest server versions
  --min-free-bytes BYTES           Apply safety floor
  --max-used-percent PERCENT       Apply safety ceiling
  --metrics-file PATH              Apply status JSON inside metrics root
  --allow-privileged-cleanup       Permit explicitly selected apt/journald apply
  -h, --help

Categories:
  report, logs, pm2-logs, journald, apt-cache, temporary-files,
  docker-images, docker-build-cache, docker-tagged-images,
  stopped-containers, git, project-artifacts, developer-tools,
  user-caches, npm-cache, python-cache, vscode-versions, vscode-cache,
  deleted-open-files, home-assistant-recorder, home-assistant-backups, all

docker-tagged-images, stopped-containers, git, developer-tools, user-caches,
deleted-open-files and home-assistant-recorder are report-only. The default
apply profile safely cleans npm/pip caches, obsolete VS Code versions, cached
VSIX files, PM2 logs and HA backup archives beyond the newest retained set.
Cursor Server removal is intentionally never recurring.
Volumes and persistent service data are never removed.
EOF
}

log() {
  printf '%s step=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STEP" "$*"
}

die() {
  local message=$1 code=${2:-64}
  log "status=failed reason=$message exit_code=$code" >&2
  exit "$code"
}

cleanup() {
  if [[ -n "$METRICS_TEMP" && -e "$METRICS_TEMP" ]]; then
    rm -f -- "$METRICS_TEMP"
  fi
}

on_error() {
  local code=$?
  log "status=failed exit_code=$code" >&2
  exit "$code"
}

trap cleanup EXIT
trap on_error ERR

is_uint() {
  [[ $1 =~ ^[0-9]+$ ]]
}

validate_uint() {
  is_uint "$1" || die "$2-must-be-a-non-negative-integer"
}

validate_safe_absolute() {
  local path=$1 label=$2 allow_root=${3:-false}
  [[ -n "$path" ]] || die "$label-is-empty"
  [[ "$path" == /* ]] || die "$label-must-be-absolute"
  if [[ "$allow_root" != true && "$path" == / ]]; then
    die "$label-cannot-be-root"
  fi
  [[ ! -L "$path" ]] || die "$label-cannot-be-a-symlink" 65
}

validate_existing_directory() {
  validate_safe_absolute "$1" "$2" "${3:-false}"
  [[ -d "$1" ]] || die "$2-is-not-a-directory" 66
}

path_is_within() {
  [[ "$1" == "$2" || "$1" == "$2"/* ]]
}

bytes_for_path() {
  local output
  if [[ ! -e "$1" ]]; then
    printf '0\n'
    return
  fi
  output=$(du -sx -B1 -- "$1" 2>/dev/null || true)
  if [[ -n "$output" ]]; then
    awk 'NR == 1 {print $1 + 0}' <<<"$output"
  else
    printf '0\n'
  fi
}

logical_bytes_for_path() {
  local output
  if [[ ! -e "$1" ]]; then
    printf '0\n'
    return
  fi
  output=$(du -s -b -x -- "$1" 2>/dev/null || true)
  if [[ -n "$output" ]]; then
    awk 'NR == 1 {print $1 + 0}' <<<"$output"
  else
    printf '0\n'
  fi
}

path_in_use() {
  local target=$1 procdir ref cmdline fd
  for procdir in /proc/[0-9]*; do
    for ref in "$procdir/exe" "$procdir/cwd" "$procdir/root"; do
      [[ -L "$ref" ]] || continue
      case "$(readlink "$ref" 2>/dev/null || true)" in
        "$target"|"$target"/*) return 0 ;;
      esac
    done
    cmdline="$procdir/cmdline"
    if [[ -r "$cmdline" ]] && tr '\0' '\n' < "$cmdline" 2>/dev/null | grep -Fqx "$target"; then
      return 0
    fi
    for fd in "$procdir"/fd/*; do
      [[ -L "$fd" ]] || continue
      case "$(readlink "$fd" 2>/dev/null || true)" in
        "$target"|"$target"/*) return 0 ;;
      esac
    done
  done
  return 1
}

filesystem_used_bytes() {
  df -P -B1 "$FILESYSTEM" | awk 'NR == 2 {print $3 + 0}'
}

filesystem_available_bytes() {
  df -P -B1 "$FILESYSTEM" | awk 'NR == 2 {print $4 + 0}'
}

filesystem_used_percent() {
  df -P "$FILESYSTEM" | awk 'NR == 2 {gsub(/%/, "", $5); print $5 + 0}'
}

validate_category() {
  case "$1" in
    report|logs|pm2-logs|journald|apt-cache|temporary-files|docker-images|docker-build-cache|docker-tagged-images|stopped-containers|git|project-artifacts|developer-tools|user-caches|npm-cache|python-cache|vscode-versions|vscode-cache|deleted-open-files|home-assistant-recorder|home-assistant-backups) ;;
    *) die "unknown-category-$1" ;;
  esac
}

add_category() {
  local category=$1 item
  if [[ "$category" == all ]]; then
    for item in report logs pm2-logs journald apt-cache temporary-files docker-images docker-build-cache docker-tagged-images stopped-containers git project-artifacts developer-tools user-caches npm-cache python-cache vscode-versions vscode-cache deleted-open-files home-assistant-recorder home-assistant-backups; do
      add_category "$item"
    done
    return
  fi
  validate_category "$category"
  for item in "${CATEGORIES[@]}"; do
    [[ "$item" == "$category" ]] && return
  done
  CATEGORIES+=("$category")
}

while (($#)); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --allow-privileged-cleanup) ALLOW_PRIVILEGED_CLEANUP="true" ;;
    --category)
      shift
      [[ -n ${1:-} ]] || die "category-is-required"
      add_category "$1"
      ;;
    --min-age)
      shift; MIN_AGE_HOURS=${1:-}; validate_uint "$MIN_AGE_HOURS" min-age ;;
    --max-build-cache)
      shift; MAX_BUILD_CACHE=${1:-}
      [[ "$MAX_BUILD_CACHE" =~ ^[1-9][0-9]*([KMGT]B)?$ ]] || die "invalid-max-build-cache"
      ;;
    --log-retention-days)
      shift; LOG_RETENTION_DAYS=${1:-}; validate_uint "$LOG_RETENTION_DAYS" log-retention-days ;;
    --temporary-retention-days)
      shift; TEMP_RETENTION_DAYS=${1:-}; validate_uint "$TEMP_RETENTION_DAYS" temporary-retention-days ;;
    --project-retention-days)
      shift; PROJECT_RETENTION_DAYS=${1:-}; validate_uint "$PROJECT_RETENTION_DAYS" project-retention-days ;;
    --journal-retention-days)
      shift; JOURNAL_RETENTION_DAYS=${1:-}; validate_uint "$JOURNAL_RETENTION_DAYS" journal-retention-days ;;
    --ha-backup-retention-days)
      shift; HA_BACKUP_RETENTION_DAYS=${1:-}; validate_uint "$HA_BACKUP_RETENTION_DAYS" ha-backup-retention-days ;;
    --ha-backup-keep-count)
      shift; HA_BACKUP_KEEP_COUNT=${1:-}; validate_uint "$HA_BACKUP_KEEP_COUNT" ha-backup-keep-count ;;
    --pm2-log-max-bytes)
      shift; PM2_LOG_MAX_BYTES=${1:-}; validate_uint "$PM2_LOG_MAX_BYTES" pm2-log-max-bytes ;;
    --pm2-log-retention-files)
      shift; PM2_LOG_RETENTION_FILES=${1:-}; validate_uint "$PM2_LOG_RETENTION_FILES" pm2-log-retention-files ;;
    --vscode-keep-versions)
      shift; VSCODE_KEEP_VERSIONS=${1:-}; validate_uint "$VSCODE_KEEP_VERSIONS" vscode-keep-versions ;;
    --min-free-bytes)
      shift; MIN_FREE_BYTES=${1:-}; validate_uint "$MIN_FREE_BYTES" min-free-bytes ;;
    --max-used-percent)
      shift; MAX_DISK_PERCENT=${1:-}; validate_uint "$MAX_DISK_PERCENT" max-used-percent
      (( MAX_DISK_PERCENT >= 1 && MAX_DISK_PERCENT <= 100 )) || die "max-used-percent-out-of-range"
      ;;
    --metrics-file)
      shift; METRICS_FILE=${1:-} ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown-option-$1" ;;
  esac
  shift
done

if ((${#CATEGORIES[@]} == 0)); then
  CATEGORIES=("${DEFAULT_CATEGORIES[@]}")
fi

for value in "$MIN_AVAILABLE_KB" "$MIN_FREE_BYTES" "$MAX_DISK_PERCENT" "$MIN_AGE_HOURS" "$LOG_RETENTION_DAYS" "$TEMP_RETENTION_DAYS" "$PROJECT_RETENTION_DAYS" "$JOURNAL_RETENTION_DAYS" "$HA_BACKUP_RETENTION_DAYS" "$HA_BACKUP_KEEP_COUNT" "$PM2_LOG_MAX_BYTES" "$PM2_LOG_RETENTION_FILES" "$VSCODE_KEEP_VERSIONS"; do
  validate_uint "$value" configuration-value
done
[[ "$MAX_BUILD_CACHE" =~ ^[1-9][0-9]*([KMGT]B)?$ ]] || die "invalid-max-build-cache"
(( PM2_LOG_MAX_BYTES > 0 )) || die "pm2-log-max-bytes-must-be-positive"
(( PM2_LOG_RETENTION_FILES > 0 )) || die "pm2-log-retention-files-must-be-positive"
(( VSCODE_KEEP_VERSIONS > 0 )) || die "vscode-keep-versions-must-be-positive"
(( HA_BACKUP_KEEP_COUNT > 0 )) || die "ha-backup-keep-count-must-be-positive"

STEP="preflight"
for dependency in awk date df du find flock git readlink realpath sed sort stat; do
  command -v "$dependency" >/dev/null 2>&1 || die "missing-dependency-$dependency" 69
done
validate_existing_directory "$REPO_ROOT" repository-root
validate_existing_directory "$FILESYSTEM" filesystem true
validate_existing_directory "$TEMP_ROOT" temporary-root
validate_existing_directory "$METRICS_ROOT" metrics-root
validate_existing_directory "$USER_HOME" user-home
validate_safe_absolute "$USER_CACHE_ROOT" user-cache-root
validate_safe_absolute "$NPM_CACHE_ROOT" npm-cache-root
validate_safe_absolute "$PM2_ROOT" pm2-root
validate_safe_absolute "$VSCODE_ROOT" vscode-root
validate_safe_absolute "$CURSOR_ROOT" cursor-root
validate_existing_directory "$HA_CONFIG_ROOT" home-assistant-config-root
validate_safe_absolute "$HA_BACKUP_ROOT" home-assistant-backup-root
[[ "$HA_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "home-assistant-container-name-invalid" 65
validate_safe_absolute "$METRICS_FILE" metrics-file
metrics_parent=$(dirname "$METRICS_FILE")
validate_existing_directory "$metrics_parent" metrics-parent
metrics_root_real=$(realpath -e -- "$METRICS_ROOT")
metrics_parent_real=$(realpath -e -- "$metrics_parent")
path_is_within "$metrics_parent_real" "$metrics_root_real" || die "metrics-file-outside-allowlisted-root" 65
[[ ! -L "$METRICS_FILE" ]] || die "metrics-file-cannot-be-a-symlink" 65
validate_existing_directory "$LOCK_PATH" lock-path
exec 9<"$LOCK_PATH"
if ! flock -n 9; then
  log "status=skipped reason=already-running"
  exit 0
fi

BEFORE_BYTES=$(filesystem_used_bytes)
AVAILABLE_BYTES=$(filesystem_available_bytes)
USED_PERCENT=$(filesystem_used_percent)
log "status=started mode=$MODE categories=$(IFS=,; echo "${CATEGORIES[*]}") filesystem=$FILESYSTEM used_bytes=$BEFORE_BYTES available_bytes=$AVAILABLE_BYTES used_percent=$USED_PERCENT"

if [[ "$MODE" == apply ]]; then
  AVAILABLE_KB=$(awk '/^MemAvailable:/ {print $2; exit}' "$MEMINFO_FILE" 2>/dev/null || true)
  [[ -z "$AVAILABLE_KB" ]] || is_uint "$AVAILABLE_KB" || die "invalid-memavailable" 65
  if [[ -n "$AVAILABLE_KB" ]] && (( AVAILABLE_KB < MIN_AVAILABLE_KB )); then
    die "low-available-memory-available_kb_${AVAILABLE_KB}-required_kb_${MIN_AVAILABLE_KB}" 75
  fi
  (( AVAILABLE_BYTES >= MIN_FREE_BYTES )) || die "low-free-space-available_bytes_${AVAILABLE_BYTES}-required_bytes_${MIN_FREE_BYTES}" 75
  (( USED_PERCENT < MAX_DISK_PERCENT )) || die "filesystem-pressure-used_percent_${USED_PERCENT}-maximum_percent_${MAX_DISK_PERCENT}" 75
fi

docker_available() {
  command -v "$DOCKER_BIN" >/dev/null 2>&1 && "$DOCKER_BIN" info >/dev/null 2>&1
}

docker_image_referenced_by_repository() {
  local image_id=$1 digest=${1#sha256:}
  command -v git >/dev/null 2>&1 || return 0
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git -C "$REPO_ROOT" grep --quiet --fixed-strings -e "$image_id" -- . 2>/dev/null ||
    git -C "$REPO_ROOT" grep --quiet --fixed-strings -e "$digest" -- . 2>/dev/null
}

warn_unavailable() {
  log "status=skipped reason=$1"
  WARNINGS=$((WARNINGS + 1))
}

measure_category() {
  local category=$1 before=$2 after delta=0
  after=$(filesystem_used_bytes)
  if [[ "$MODE" == apply ]] && (( before > after )); then delta=$((before - after)); fi
  CATEGORY_RECLAIMED["$category"]=$delta
  log "status=category-complete category=$category reclaimed_bytes=$delta"
}

measure_report_category() {
  local category=$1
  CATEGORY_RECLAIMED["$category"]=0
  log "status=category-complete category=$category reclaimed_bytes=0 measurement=report-only"
}

remove_directory_tree() {
  local candidate=$1 root=$2 action=$3 root_real candidate_real logical allocated
  [[ -n "$candidate" && "$candidate" != / ]] || die "unsafe-empty-or-root-candidate" 65
  [[ -d "$candidate" && ! -L "$candidate" ]] || die "unsafe-non-directory-candidate" 65
  root_real=$(realpath -e -- "$root")
  candidate_real=$(realpath -e -- "$candidate")
  [[ "$candidate_real" != "$root_real" ]] || die "candidate-matches-allowlist-root" 65
  path_is_within "$candidate_real" "$root_real" || die "candidate-outside-allowlist" 65
  if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$candidate_real"; then
    die "candidate-is-mountpoint" 65
  fi
  path_in_use "$candidate_real" && die "candidate-is-in-use" 75
  logical=$(logical_bytes_for_path "$candidate_real")
  allocated=$(bytes_for_path "$candidate_real")
  log "candidate action=$action logical_bytes=$logical allocated_bytes=$allocated path=$candidate_real"
  if [[ "$MODE" == apply ]]; then
    find -P "$candidate_real" -xdev -depth -delete
    [[ ! -e "$candidate_real" ]] || die "candidate-removal-incomplete" 74
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
    REMOVED_BYTES=$((REMOVED_BYTES + logical))
    log "removed action=$action logical_bytes=$logical allocated_bytes=$allocated path=$candidate_real"
  fi
}

remove_regular_file() {
  local candidate=$1 root=$2 action=$3 root_real candidate_real size
  [[ -n "$candidate" && "$candidate" != / ]] || die "unsafe-empty-or-root-candidate" 65
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "unsafe-non-regular-candidate" 65
  root_real=$(realpath -e -- "$root")
  candidate_real=$(realpath -e -- "$candidate")
  path_is_within "$candidate_real" "$root_real" || die "candidate-outside-allowlist" 65
  size=$(stat -c %s -- "$candidate")
  log "candidate action=$action bytes=$size path=$candidate"
  if [[ "$MODE" == apply ]]; then
    rm -f -- "$candidate"
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
    REMOVED_BYTES=$((REMOVED_BYTES + size))
    log "removed action=$action bytes=$size path=$candidate"
  fi
}

remove_home_assistant_backup() {
  local candidate=$1 root=$2 action=$3 root_real candidate_real size config_real mounted_config container_path
  [[ -n "$candidate" && "$candidate" != / ]] || die "unsafe-empty-or-root-candidate" 65
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "unsafe-non-regular-candidate" 65
  root_real=$(realpath -e -- "$root")
  candidate_real=$(realpath -e -- "$candidate")
  path_is_within "$candidate_real" "$root_real" || die "candidate-outside-allowlist" 65
  [[ $(dirname -- "$candidate_real") == "$root_real" ]] || die "backup-candidate-must-be-direct-child" 65
  size=$(stat -c %s -- "$candidate_real")
  log "candidate action=$action bytes=$size path=$candidate_real"
  if [[ "$MODE" == apply ]]; then
    if ! rm -f -- "$candidate_real" 2>/dev/null; then
      docker_available || die "home-assistant-backup-removal-requires-container" 77
      config_real=$(realpath -e -- "$HA_CONFIG_ROOT")
      [[ "$root_real" == "$config_real/backups" ]] || die "home-assistant-backup-root-not-under-config" 65
      mounted_config=$("$DOCKER_BIN" inspect --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{println .Source}}{{end}}{{end}}' "$HA_CONTAINER" | awk 'NF {print; exit}')
      [[ -n "$mounted_config" && -d "$mounted_config" ]] || die "home-assistant-config-mount-unavailable" 77
      [[ $(realpath -e -- "$mounted_config") == "$config_real" ]] || die "home-assistant-config-mount-mismatch" 65
      container_path="/config/backups/$(basename -- "$candidate_real")"
      "$DOCKER_BIN" exec "$HA_CONTAINER" rm -- "$container_path"
    fi
    [[ ! -e "$candidate_real" ]] || die "home-assistant-backup-removal-incomplete" 74
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
    REMOVED_BYTES=$((REMOVED_BYTES + size))
    log "removed action=$action bytes=$size path=$candidate_real"
  fi
}

report_inventory() {
  local before
  STEP="category-report"
  before=$(filesystem_used_bytes)
  df -P -B1 "$FILESYSTEM"
  df -Pi "$FILESYSTEM"
  log "metric component=repository bytes=$(bytes_for_path "$REPO_ROOT")"
  log "metric component=home-assistant bytes=$(bytes_for_path "$REPO_ROOT/homeassistant")"
  log "metric component=nodered bytes=$(bytes_for_path "$NODE_RED_ROOT")"
  log "metric component=zigbee2mqtt bytes=$(bytes_for_path "$REPO_ROOT/zigbee2mqtt")"
  if docker_available; then "$DOCKER_BIN" system df; else warn_unavailable docker-unavailable; fi
  measure_report_category report
}

clean_logs() {
  local before root candidate
  STEP="category-logs"
  before=$(filesystem_used_bytes)
  for root in "$REPO_ROOT/homeassistant" "$REPO_ROOT/mosquitto/log"; do
    [[ -d "$root" && ! -L "$root" ]] || continue
    find "$root" -xdev -maxdepth 1 -type f -mtime "+$LOG_RETENTION_DAYS" -regextype posix-extended -regex '.*\.log\.[0-9]+(\.gz)?' -print0 |
      while IFS= read -r -d '' candidate; do
      remove_regular_file "$candidate" "$root" rotated-log
      done
  done
  log "metric component=system-logs bytes=$(bytes_for_path /var/log)"
  log "metric component=zigbee2mqtt-logs bytes=$(bytes_for_path "$REPO_ROOT/zigbee2mqtt/log")"
  measure_category logs "$before"
}

temporary_candidate_active() {
  local candidate=$1 ref target
  for ref in /proc/[0-9]*/fd/* /proc/[0-9]*/cwd /proc/[0-9]*/root; do
    [[ -L "$ref" ]] || continue
    target=$(readlink "$ref" 2>/dev/null || true)
    [[ "$target" == "$candidate" || "$target" == "$candidate"/* ]] && return 0
  done
  return 1
}

known_temp_name() {
  local prefix
  for prefix in "${TEMP_PREFIXES[@]}"; do
    [[ "$1" == "$prefix"* ]] && return 0
  done
  return 1
}

clean_temporary_files() {
  local before candidate name size candidate_real temp_real
  STEP="category-temporary-files"
  before=$(filesystem_used_bytes)
  temp_real=$(realpath -e -- "$TEMP_ROOT")
  find "$TEMP_ROOT" -xdev -mindepth 1 -maxdepth 1 -type d -mtime "+$TEMP_RETENTION_DAYS" -print0 |
    while IFS= read -r -d '' candidate; do
    name=${candidate##*/}
    known_temp_name "$name" || continue
    [[ ! -L "$candidate" && -d "$candidate" ]] || continue
    [[ $(stat -c %u -- "$candidate") -eq $EUID ]] || continue
    candidate_real=$(realpath -e -- "$candidate")
    path_is_within "$candidate_real" "$temp_real" || die "temporary-candidate-outside-root" 65
    if temporary_candidate_active "$candidate_real"; then
      log "status=skipped reason=temporary-candidate-active path=$candidate"
      continue
    fi
    size=$(bytes_for_path "$candidate")
    log "candidate action=old-generated-temporary bytes=$size path=$candidate"
    if [[ "$MODE" == apply ]]; then
      find "$candidate" -xdev -depth -delete
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
      REMOVED_BYTES=$((REMOVED_BYTES + size))
      log "removed action=old-generated-temporary bytes=$size path=$candidate"
    fi
    done
  log "metric component=temporary-files bytes=$(bytes_for_path "$TEMP_ROOT")"
  measure_category temporary-files "$before"
}

clean_project_artifacts() {
  local before root days action candidate
  STEP="category-project-artifacts"
  before=$(filesystem_used_bytes)
  if [[ -e "$NODE_RED_ROOT" ]]; then
    validate_existing_directory "$NODE_RED_ROOT" node-red-root
    [[ $(realpath -e -- "$NODE_RED_ROOT") == "$NODE_RED_ROOT" ]] || die "node-red-root-has-symlink-component" 65
  fi
  while IFS='|' read -r root days action; do
    [[ -d "$root" && ! -L "$root" ]] || continue
    validate_existing_directory "$root" project-artifact-root
    find "$root" -xdev -type f -mtime "+$days" -print0 |
      while IFS= read -r -d '' candidate; do
      remove_regular_file "$candidate" "$root" "$action"
      done
  done <<EOF
$NODE_RED_ROOT/.npm/_logs|$LOG_RETENTION_DAYS|old-npm-log
$NODE_RED_ROOT/backups/codex-flows|$PROJECT_RETENTION_DAYS|old-flow-backup
EOF
  measure_category project-artifacts "$before"
}

pm2_log_bytes() {
  local total=0 file
  [[ -d "$PM2_ROOT" && ! -L "$PM2_ROOT" ]] || { printf '0\n'; return; }
  while IFS= read -r -d '' file; do
    total=$((total + $(stat -c %s -- "$file")))
  done < <(find "$PM2_ROOT/logs" -xdev -maxdepth 1 -type f -name '*.log' -print0 2>/dev/null)
  if [[ -f "$PM2_ROOT/pm2.log" && ! -L "$PM2_ROOT/pm2.log" ]]; then
    total=$((total + $(stat -c %s -- "$PM2_ROOT/pm2.log")))
  fi
  printf '%s\n' "$total"
}

rotate_pm2_log() {
  local file=$1 root=$2 size timestamp rotated temporary count index old
  [[ -f "$file" && ! -L "$file" ]] || return 0
  size=$(stat -c %s -- "$file")
  (( size >= PM2_LOG_MAX_BYTES )) || return 0
  log "candidate action=pm2-copytruncate logical_bytes=$size path=$file"
  [[ "$MODE" == apply ]] || return 0
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  rotated="$file.$timestamp.gz"
  [[ ! -e "$rotated" ]] || die "pm2-rotation-target-exists" 73
  temporary=$(mktemp "$(dirname "$file")/.storage-maintenance-pm2.XXXXXX")
  if ! cp --preserve=mode,ownership,timestamps -- "$file" "$temporary"; then
    rm -f -- "$temporary"
    die "pm2-log-copy-failed" 74
  fi
  if ! : > "$file"; then
    rm -f -- "$temporary"
    die "pm2-log-truncate-failed" 74
  fi
  if ! gzip -c -- "$temporary" > "$rotated"; then
    rm -f -- "$temporary" "$rotated"
    die "pm2-log-compression-failed" 74
  fi
  rm -f -- "$temporary"
  REMOVED_COUNT=$((REMOVED_COUNT + 1))
  REMOVED_BYTES=$((REMOVED_BYTES + size))
  log "rotated action=pm2-copytruncate source_bytes=$size archive_bytes=$(stat -c %s -- "$rotated") path=$file"

  mapfile -t rotations < <(find "$root" -xdev -maxdepth 1 -type f -name "$(basename "$file").????????T??????Z.gz" -printf '%T@ %p\n' | sort -nr | sed 's/^[^ ]* //')
  count=${#rotations[@]}
  if (( count > PM2_LOG_RETENTION_FILES )); then
    for ((index=PM2_LOG_RETENTION_FILES; index<count; index++)); do
      old=${rotations[$index]}
      remove_regular_file "$old" "$root" old-pm2-rotation
    done
  fi
}

clean_pm2_logs() {
  local before file
  STEP="category-pm2-logs"
  before=$(filesystem_used_bytes)
  if [[ ! -d "$PM2_ROOT" ]]; then
    warn_unavailable pm2-home-unavailable
    measure_category pm2-logs "$before"
    return
  fi
  validate_existing_directory "$PM2_ROOT" pm2-root
  [[ $(realpath -e -- "$PM2_ROOT") == "$PM2_ROOT" ]] || die "pm2-root-has-symlink-component" 65
  if [[ -d "$PM2_ROOT/logs" && ! -L "$PM2_ROOT/logs" ]]; then
    find "$PM2_ROOT/logs" -xdev -maxdepth 1 -type f -name '*.log' -print0 |
      while IFS= read -r -d '' file; do rotate_pm2_log "$file" "$PM2_ROOT/logs"; done
  fi
  rotate_pm2_log "$PM2_ROOT/pm2.log" "$PM2_ROOT"
  log "metric component=pm2-logs bytes=$(pm2_log_bytes) max_bytes=$PM2_LOG_MAX_BYTES retention_files=$PM2_LOG_RETENTION_FILES"
  measure_category pm2-logs "$before"
}

report_developer_tools() {
  local before path name
  STEP="category-developer-tools"
  before=$(filesystem_used_bytes)
  while IFS='|' read -r name path; do
    log "metric component=$name logical_bytes=$(logical_bytes_for_path "$path") allocated_bytes=$(bytes_for_path "$path")"
  done <<EOF
vscode-server|$VSCODE_ROOT
cursor-server|$CURSOR_ROOT
npm-cache|$NPM_CACHE_ROOT
pm2|$PM2_ROOT
EOF
  log "status=report-only category=developer-tools"
  measure_report_category developer-tools
}

report_user_caches() {
  local before path name
  STEP="category-user-caches"
  before=$(filesystem_used_bytes)
  while IFS='|' read -r name path; do
    log "metric component=$name logical_bytes=$(logical_bytes_for_path "$path") allocated_bytes=$(bytes_for_path "$path")"
  done <<EOF
npm|$NPM_CACHE_ROOT
pip|$USER_CACHE_ROOT/pip
puppeteer|$USER_CACHE_ROOT/puppeteer
chromium-headless|$USER_CACHE_ROOT/chromium-headless
typescript|$USER_CACHE_ROOT/typescript
EOF
  log "status=report-only category=user-caches reason=unknown-and-browser-caches-require-owner-review"
  measure_report_category user-caches
}

clean_npm_cache() {
  local before configured configured_real expected_real content_root content_files
  STEP="category-npm-cache"
  before=$(filesystem_used_bytes)
  if ! command -v "$NPM_BIN" >/dev/null 2>&1; then
    warn_unavailable npm-unavailable
    measure_category npm-cache "$before"
    return
  fi
  if [[ "$MODE" == apply ]]; then
    configured=$($NPM_BIN config get cache 2>/dev/null | tail -n 1)
  else
    configured=$NPM_CACHE_ROOT
    log "status=deferred reason=npm-config-query-can-write-logs-until-apply"
  fi
  [[ -n "$configured" && "$configured" == /* ]] || die "npm-cache-path-invalid" 65
  [[ "$configured" != *'/node_modules' && "$configured" != *'/node_modules/'* ]] || die "npm-cache-points-to-node-modules" 65
  if [[ -e "$configured" ]]; then
    [[ -d "$configured" && ! -L "$configured" ]] || die "npm-cache-is-not-safe-directory" 65
    configured_real=$(realpath -e -- "$configured")
    expected_real=$(realpath -e -- "$NPM_CACHE_ROOT")
    [[ "$configured_real" == "$expected_real" ]] || die "npm-cache-path-not-allowlisted" 65
  else
    log "status=skipped reason=npm-cache-absent path=$configured"
    measure_category npm-cache "$before"
    return
  fi
  content_root="$configured_real/_cacache"
  content_files=$(find "$content_root" -xdev -type f ! -name '_lastverified' -printf . 2>/dev/null | wc -c)
  if (( content_files == 0 )); then
    log "status=no-candidates action=npm-supported-cache-clean path=$content_root"
    measure_category npm-cache "$before"
    return
  fi
  log "candidate action=npm-supported-cache-clean files=$content_files logical_bytes=$(logical_bytes_for_path "$content_root") allocated_bytes=$(bytes_for_path "$content_root") path=$content_root"
  if [[ "$MODE" == apply ]]; then
    "$NPM_BIN" cache verify
    "$NPM_BIN" cache clean --force
    "$NPM_BIN" cache verify
  fi
  measure_category npm-cache "$before"
}

clean_python_cache() {
  local before configured configured_real expected content_files
  STEP="category-python-cache"
  before=$(filesystem_used_bytes)
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 || ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    warn_unavailable pip-unavailable
    measure_category python-cache "$before"
    return
  fi
  configured=$($PYTHON_BIN -m pip cache dir 2>/dev/null || true)
  [[ -n "$configured" && "$configured" == /* ]] || die "pip-cache-path-invalid" 65
  expected="$USER_CACHE_ROOT/pip"
  if [[ -e "$configured" ]]; then
    [[ -d "$configured" && ! -L "$configured" ]] || die "pip-cache-is-not-safe-directory" 65
    configured_real=$(realpath -e -- "$configured")
    [[ -e "$expected" ]] || die "pip-cache-allowlist-missing" 65
    [[ "$configured_real" == "$(realpath -e -- "$expected")" ]] || die "pip-cache-path-not-allowlisted" 65
  else
    log "status=skipped reason=pip-cache-absent path=$configured"
    measure_category python-cache "$before"
    return
  fi
  "$PYTHON_BIN" -m pip cache info
  content_files=$(find "$configured_real" -xdev -type f -printf . 2>/dev/null | wc -c)
  if (( content_files == 0 )); then
    log "status=no-candidates action=pip-supported-cache-purge path=$configured_real"
    measure_category python-cache "$before"
    return
  fi
  log "candidate action=pip-supported-cache-purge logical_bytes=$(logical_bytes_for_path "$configured_real") allocated_bytes=$(bytes_for_path "$configured_real") path=$configured_real"
  if [[ "$MODE" == apply ]]; then "$PYTHON_BIN" -m pip cache purge; fi
  measure_category python-cache "$before"
}

clean_vscode_versions() {
  local before servers entry commit index keep candidate procdir ref value fd argument obsolete extension extensions_root
  local -a versions=()
  local -A active_commits=()
  STEP="category-vscode-versions"
  before=$(filesystem_used_bytes)
  servers="$VSCODE_ROOT/cli/servers"
  if [[ ! -d "$servers" ]]; then
    warn_unavailable vscode-servers-unavailable
    measure_category vscode-versions "$before"
    return
  fi
  validate_existing_directory "$VSCODE_ROOT" vscode-root
  [[ $(realpath -e -- "$VSCODE_ROOT") == "$VSCODE_ROOT" ]] || die "vscode-root-has-symlink-component" 65
  for procdir in /proc/[0-9]*; do
    for ref in "$procdir/exe" "$procdir/cwd" "$procdir/root" "$procdir"/fd/*; do
      [[ -L "$ref" ]] || continue
      value=$(readlink "$ref" 2>/dev/null || true)
      case "$value" in
        "$servers"/Stable-*/*)
          commit=${value#"$servers/Stable-"}; active_commits["${commit%%/*}"]=1 ;;
        "$VSCODE_ROOT"/code-*)
          commit=${value#"$VSCODE_ROOT/code-"}; active_commits["${commit%%/*}"]=1 ;;
      esac
    done
    if [[ -r "$procdir/cmdline" ]]; then
      while IFS= read -r -d '' argument; do
        case "$argument" in
          "$servers"/Stable-*/*)
            commit=${argument#"$servers/Stable-"}; active_commits["${commit%%/*}"]=1 ;;
          "$VSCODE_ROOT"/code-*)
            commit=${argument#"$VSCODE_ROOT/code-"}; active_commits["${commit%%/*}"]=1 ;;
        esac
      done < "$procdir/cmdline" 2>/dev/null || true
    fi
  done
  mapfile -t versions < <(find "$servers" -xdev -mindepth 1 -maxdepth 1 -type d -name 'Stable-*' -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
  index=0
  for entry in "${versions[@]}"; do
    commit=${entry#Stable-}
    keep=false
    if (( index < VSCODE_KEEP_VERSIONS )) || [[ -n ${active_commits[$commit]+x} ]]; then keep=true; fi
    if [[ "$keep" == true ]]; then
      log "status=preserved component=vscode-server commit=$commit reason=active-or-retained"
    else
      candidate="$servers/$entry"
      log "candidate action=obsolete-vscode-server commit=$commit logical_bytes=$(logical_bytes_for_path "$candidate") allocated_bytes=$(bytes_for_path "$candidate") path=$candidate"
      if [[ "$MODE" == apply ]]; then
        remove_directory_tree "$candidate" "$servers" obsolete-vscode-server
        [[ ! -e "$VSCODE_ROOT/code-$commit" ]] || remove_regular_file "$VSCODE_ROOT/code-$commit" "$VSCODE_ROOT" obsolete-vscode-launcher
        [[ ! -e "$VSCODE_ROOT/.cli.$commit.log" ]] || remove_regular_file "$VSCODE_ROOT/.cli.$commit.log" "$VSCODE_ROOT" obsolete-vscode-cli-log
      fi
    fi
    index=$((index + 1))
  done
  obsolete="$VSCODE_ROOT/extensions/.obsolete"
  extensions_root="$VSCODE_ROOT/extensions"
  if [[ -f "$obsolete" && ! -L "$obsolete" ]]; then
    if ! command -v jq >/dev/null 2>&1; then
      warn_unavailable jq-unavailable-for-vscode-obsolete-extensions
    else
      while IFS= read -r extension; do
        [[ "$extension" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe-obsolete-extension-name" 65
        candidate="$extensions_root/$extension"
        [[ -d "$candidate" && ! -L "$candidate" ]] || continue
        if path_in_use "$candidate"; then
          log "status=preserved component=vscode-extension extension=$extension reason=active"
          continue
        fi
        log "candidate action=obsolete-vscode-extension extension=$extension logical_bytes=$(logical_bytes_for_path "$candidate") allocated_bytes=$(bytes_for_path "$candidate") path=$candidate"
        if [[ "$MODE" == apply ]]; then
          remove_directory_tree "$candidate" "$extensions_root" obsolete-vscode-extension
        fi
      done < <(jq -r 'keys[]' "$obsolete")
    fi
  fi
  measure_category vscode-versions "$before"
}

clean_vscode_cache() {
  local before cache file
  STEP="category-vscode-cache"
  before=$(filesystem_used_bytes)
  cache="$VSCODE_ROOT/data/CachedExtensionVSIXs"
  if [[ ! -d "$cache" ]]; then
    warn_unavailable vscode-extension-cache-unavailable
    measure_category vscode-cache "$before"
    return
  fi
  validate_existing_directory "$cache" vscode-extension-cache
  [[ $(realpath -e -- "$cache") == "$cache" ]] || die "vscode-extension-cache-has-symlink-component" 65
  if path_in_use "$cache"; then die "vscode-extension-cache-is-in-use" 75; fi
  find "$cache" -xdev -maxdepth 1 -type f -print0 |
    while IFS= read -r -d '' file; do remove_regular_file "$file" "$cache" cached-extension-vsix; done
  measure_category vscode-cache "$before"
}

report_docker_tagged_images() {
  local before id repository tag containers size created
  local -A seen=()
  STEP="category-docker-tagged-images"
  before=$(filesystem_used_bytes)
  if ! docker_available; then warn_unavailable docker-unavailable; measure_category docker-tagged-images "$before"; return; fi
  "$DOCKER_BIN" image ls --all --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Containers}}' |
    while IFS=$'\t' read -r id repository tag containers; do
      [[ -z ${seen[$id]+x} ]] || continue
      seen[$id]=1
      [[ "$tag" != '<none>' && "$containers" == 0 ]] || continue
      size=$($DOCKER_BIN image inspect -f '{{.Size}}' "$id")
      created=$($DOCKER_BIN image inspect -f '{{.Created}}' "$id")
      log "candidate action=review-unused-tagged-image content_bytes=$size repository=$repository tag=$tag image_id=$id created=$created"
    done
  log "status=report-only category=docker-tagged-images reason=compose-registry-and-rollback-proof-required"
  measure_report_category docker-tagged-images
}

deleted_open_metrics() {
  local procdir fd ref record key size count=0 bytes=0 inaccessible=0
  local -A seen=()
  for procdir in /proc/[0-9]*; do
    if [[ ! -r "$procdir/fd" ]]; then inaccessible=$((inaccessible + 1)); continue; fi
    for fd in "$procdir"/fd/*; do
      ref=$(readlink "$fd" 2>/dev/null || true)
      [[ "$ref" == *' (deleted)' ]] || continue
      record=$(stat -Lc '%d:%i:%s' "$fd" 2>/dev/null || true)
      [[ -n "$record" ]] || continue
      key=${record%:*}
      [[ -z ${seen[$key]+x} ]] || continue
      seen[$key]=1
      size=${record##*:}
      count=$((count + 1))
      bytes=$((bytes + size))
    done
  done
  printf '%s %s %s\n' "$count" "$bytes" "$inaccessible"
}

report_deleted_open_files() {
  local before count bytes inaccessible
  STEP="category-deleted-open-files"
  before=$(filesystem_used_bytes)
  read -r count bytes inaccessible < <(deleted_open_metrics)
  log "metric component=deleted-open-files count=$count bytes=$bytes inaccessible_processes=$inaccessible complete=$([[ $inaccessible -eq 0 ]] && echo true || echo false)"
  log "status=report-only category=deleted-open-files"
  measure_report_category deleted-open-files
}

report_home_assistant_recorder() {
  local before db wal
  STEP="category-home-assistant-recorder"
  before=$(filesystem_used_bytes)
  db="$REPO_ROOT/homeassistant/home-assistant_v2.db"
  wal="$db-wal"
  log "metric component=home-assistant-recorder logical_bytes=$(logical_bytes_for_path "$db") allocated_bytes=$(bytes_for_path "$db") wal_logical_bytes=$(logical_bytes_for_path "$wal") wal_allocated_bytes=$(bytes_for_path "$wal")"
  log "status=report-only category=home-assistant-recorder reason=live-database"
  measure_report_category home-assistant-recorder
}

clean_docker_images() {
  local before id repository tag containers created created_epoch cutoff_epoch refs size
  local -A seen=()
  STEP="category-docker-images"
  before=$(filesystem_used_bytes)
  if ! docker_available; then warn_unavailable docker-unavailable; measure_category docker-images "$before"; return; fi
  cutoff_epoch=$(date -u -d "$MIN_AGE_HOURS hours ago" +%s)
  "$DOCKER_BIN" image ls --all --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Containers}}' |
    while IFS=$'\t' read -r id repository tag containers; do
    [[ -z ${seen[$id]+x} ]] || continue
    seen[$id]=1
    [[ "$tag" == '<none>' && "$containers" == 0 ]] || continue
    created=$("$DOCKER_BIN" image inspect -f '{{.Created}}' "$id")
    created_epoch=$(date -u -d "$created" +%s)
    (( created_epoch <= cutoff_epoch )) || continue
    refs=$("$DOCKER_BIN" ps -aq --filter "ancestor=$id")
    [[ -z "$refs" ]] || continue
    if docker_image_referenced_by_repository "$id"; then
      log "status=preserved component=docker-image reason=repository-reference image_id=$id"
      continue
    fi
    size=$("$DOCKER_BIN" image inspect -f '{{.Size}}' "$id")
    log "candidate action=untagged-unreferenced-image content_bytes=$size repository=$repository image_id=$id created=$created"
    if [[ "$MODE" == apply ]]; then
      "$DOCKER_BIN" image rm "$id"
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
      log "removed action=untagged-unreferenced-image approximate_bytes=$size image_id=$id"
    fi
    done
  if [[ "$MODE" != apply ]]; then
    "$DOCKER_BIN" image ls --filter dangling=true --format 'candidate action=dangling-image image_id={{.ID}} created={{.CreatedAt}} size={{.Size}}'
  fi
  measure_category docker-images "$before"
}

clean_docker_build_cache() {
  local before
  STEP="category-docker-build-cache"
  before=$(filesystem_used_bytes)
  if ! docker_available; then warn_unavailable docker-unavailable; measure_category docker-build-cache "$before"; return; fi
  "$DOCKER_BIN" builder du
  if [[ "$MODE" == apply ]]; then
    "$DOCKER_BIN" builder prune --all --force --max-used-space "$MAX_BUILD_CACHE"
  else
    log "status=skipped reason=dry-run action=builder-prune max_used_space=$MAX_BUILD_CACHE"
  fi
  measure_category docker-build-cache "$before"
}

report_stopped_containers() {
  local before
  STEP="category-stopped-containers"
  before=$(filesystem_used_bytes)
  if docker_available; then
    "$DOCKER_BIN" ps -a --filter status=exited --format 'candidate action=review-stopped-container id={{.ID}} name={{.Names}} status={{.Status}} size={{.Size}}'
    log "status=report-only category=stopped-containers"
  else
    warn_unavailable docker-unavailable
  fi
  measure_report_category stopped-containers
}

report_git() {
  local before
  STEP="category-git"
  before=$(filesystem_used_bytes)
  git -C "$REPO_ROOT" count-objects -vH
  git -C "$REPO_ROOT" worktree list --porcelain
  log "status=report-only category=git reason=gc-and-worktree-prune-require-review"
  measure_report_category git
}

clean_home_assistant_backups() {
  local before backup_root count bytes old_count old_bytes summary entry path index=0
  local -a backup_archives=()
  STEP="category-home-assistant-backups"
  before=$(filesystem_used_bytes)
  backup_root="$HA_BACKUP_ROOT"
  if [[ -d "$backup_root" && ! -L "$backup_root" ]]; then
    validate_existing_directory "$backup_root" home-assistant-backup-root
    [[ $(realpath -e -- "$backup_root") == "$backup_root" ]] || die "home-assistant-backup-root-has-symlink-component" 65
    summary=$(find "$backup_root" -xdev -maxdepth 1 -type f -printf '%s %T@\n' |
      awk -v cutoff="$(date -u -d "$HA_BACKUP_RETENTION_DAYS days ago" +%s)" '{count++; bytes+=$1; if ($2<cutoff) {old_count++; old_bytes+=$1}} END {printf "%d %d %d %d\n",count,bytes,old_count,old_bytes}')
    read -r count bytes old_count old_bytes <<<"$summary"
    log "metric component=home-assistant-backups count=$count bytes=$bytes older_than_days=$HA_BACKUP_RETENTION_DAYS old_count=$old_count old_bytes=$old_bytes"
    mapfile -d '' -t backup_archives < <(find "$backup_root" -xdev -maxdepth 1 -type f -name '*.tar' -printf '%T@|%p\0' | sort -z -nr)
    for entry in "${backup_archives[@]}"; do
      path=${entry#*|}
      if (( index < HA_BACKUP_KEEP_COUNT )); then
        log "status=preserved component=home-assistant-backup reason=newest-retained path=$path"
      else
        log "candidate action=surplus-home-assistant-backup logical_bytes=$(logical_bytes_for_path "$path") allocated_bytes=$(bytes_for_path "$path") path=$path"
        if [[ "$MODE" == apply ]]; then
          remove_home_assistant_backup "$path" "$backup_root" surplus-home-assistant-backup
        fi
      fi
      index=$((index + 1))
    done
  else
    log "metric component=home-assistant-backups count=0 bytes=0"
  fi
  log "status=policy category=home-assistant-backups archives_only=true keep_count=$HA_BACKUP_KEEP_COUNT"
  measure_category home-assistant-backups "$before"
}

clean_apt_cache() {
  local before
  STEP="category-apt-cache"
  before=$(filesystem_used_bytes)
  log "metric component=apt-archives bytes=$(bytes_for_path /var/cache/apt/archives)"
  if [[ "$MODE" == apply ]]; then
    if [[ "$ALLOW_PRIVILEGED_CLEANUP" != true ]]; then warn_unavailable privileged-cleanup-not-authorized
    elif (( EUID != 0 )); then warn_unavailable apt-cache-requires-root
    elif command -v "$APT_GET_BIN" >/dev/null 2>&1; then "$APT_GET_BIN" clean
    else warn_unavailable apt-get-unavailable
    fi
  fi
  measure_category apt-cache "$before"
}

clean_journald() {
  local before
  STEP="category-journald"
  before=$(filesystem_used_bytes)
  if command -v "$JOURNALCTL_BIN" >/dev/null 2>&1; then
    "$JOURNALCTL_BIN" --disk-usage 2>&1 || warn_unavailable journal-unreadable
    if [[ "$MODE" == apply ]]; then
      if [[ "$ALLOW_PRIVILEGED_CLEANUP" != true ]]; then warn_unavailable privileged-cleanup-not-authorized
      elif (( EUID != 0 )); then warn_unavailable journald-vacuum-requires-root
      else "$JOURNALCTL_BIN" --vacuum-time="${JOURNAL_RETENTION_DAYS}days"
      fi
    fi
  else
    warn_unavailable journalctl-unavailable
  fi
  measure_category journald "$before"
}

human_size_to_bytes() {
  local value=$1 number unit factor=1
  if [[ ! "$value" =~ ^([0-9]+([.][0-9]+)?)([kMGT]?B)$ ]]; then
    printf '0\n'
    return
  fi
  number=${BASH_REMATCH[1]}
  unit=${BASH_REMATCH[3]}
  case "$unit" in
    kB) factor=1000 ;;
    MB) factor=1000000 ;;
    GB) factor=1000000000 ;;
    TB) factor=1000000000000 ;;
  esac
  awk -v number="$number" -v factor="$factor" 'BEGIN {printf "%.0f\n", number * factor}'
}

docker_total_bytes() {
  local line size total=0
  if ! docker_available; then printf '0\n'; return; fi
  "$DOCKER_BIN" system df --format '{{json .}}' |
    while IFS= read -r line; do
    size=$(sed -n 's/.*"Size":"\([^"]*\)".*/\1/p' <<<"$line")
    total=$((total + $(human_size_to_bytes "$size")))
    done
  printf '%s\n' "$total"
}

docker_image_metrics() {
  local id repository tag containers size total=0 unused_tagged=0 unused_untagged=0
  local -A seen=()
  if ! docker_available; then printf '0 0 0\n'; return; fi
  "$DOCKER_BIN" image ls --all --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Containers}}' |
    while IFS=$'\t' read -r id repository tag containers; do
      [[ -z ${seen[$id]+x} ]] || continue
      seen[$id]=1
      size=$($DOCKER_BIN image inspect -f '{{.Size}}' "$id" 2>/dev/null || printf '0')
      is_uint "$size" || size=0
      total=$((total + size))
      [[ "$containers" == 0 ]] || continue
      if [[ "$tag" == '<none>' ]]; then
        unused_untagged=$((unused_untagged + size))
      else
        unused_tagged=$((unused_tagged + size))
      fi
    done
  printf '%s %s %s\n' "$total" "$unused_tagged" "$unused_untagged"
}

home_assistant_backup_bytes() {
  local root="$HA_BACKUP_ROOT"
  [[ -d "$root" && ! -L "$root" ]] || { printf '0\n'; return; }
  find "$root" -xdev -maxdepth 1 -type f -printf '%s\n' 2>/dev/null |
    awk '{total += $1} END {print total + 0}'
}

allowlisted_user_cache_bytes() {
  local total=0 path
  for path in "$NPM_CACHE_ROOT" "$USER_CACHE_ROOT/pip" "$USER_CACHE_ROOT/puppeteer" "$USER_CACHE_ROOT/chromium-headless" "$USER_CACHE_ROOT/typescript"; do
    total=$((total + $(logical_bytes_for_path "$path")))
  done
  printf '%s\n' "$total"
}

known_logs_bytes() {
  local total=0 path ha_logs=0
  for path in /var/log "$REPO_ROOT/zigbee2mqtt/log" "$REPO_ROOT/mosquitto/log"; do
    [[ -e "$path" ]] || continue
    total=$((total + $(bytes_for_path "$path")))
  done
  if [[ -d "$REPO_ROOT/homeassistant" ]]; then
    ha_logs=$(find "$REPO_ROOT/homeassistant" -xdev -maxdepth 1 -type f -name 'home-assistant.log*' -printf '%s\n' 2>/dev/null | awk '{total += $1} END {print total + 0}')
    total=$((total + ha_logs))
  fi
  printf '%s\n' "$total"
}

write_metrics() {
  local result=$1 reclaimed=$2 total used free used_percent inode_total inode_free inode_used docker_bytes logs_bytes repo_bytes now inode_summary
  local vscode_bytes cursor_bytes npm_bytes user_cache_bytes pm2_bytes recorder_bytes backup_bytes deleted_count deleted_bytes deleted_inaccessible
  local docker_images_bytes docker_unused_tagged_bytes docker_unused_untagged_bytes category category_json separator
  [[ "$MODE" == apply ]] || return 0
  total=$(df -P -B1 "$FILESYSTEM" | awk 'NR == 2 {print $2 + 0}')
  used=$(filesystem_used_bytes)
  free=$(filesystem_available_bytes)
  used_percent=$(filesystem_used_percent)
  inode_summary=$(df -Pi "$FILESYSTEM" | awk 'NR == 2 {print $2 + 0, $4 + 0}')
  read -r inode_total inode_free <<<"$inode_summary"
  inode_used=$((inode_total - inode_free))
  docker_bytes=$(docker_total_bytes)
  read -r docker_images_bytes docker_unused_tagged_bytes docker_unused_untagged_bytes < <(docker_image_metrics)
  logs_bytes=$(known_logs_bytes)
  repo_bytes=$(bytes_for_path "$REPO_ROOT")
  vscode_bytes=$(logical_bytes_for_path "$VSCODE_ROOT")
  cursor_bytes=$(logical_bytes_for_path "$CURSOR_ROOT")
  npm_bytes=$(logical_bytes_for_path "$NPM_CACHE_ROOT")
  user_cache_bytes=$(allowlisted_user_cache_bytes)
  pm2_bytes=$(pm2_log_bytes)
  recorder_bytes=$(logical_bytes_for_path "$REPO_ROOT/homeassistant/home-assistant_v2.db")
  backup_bytes=$(home_assistant_backup_bytes)
  read -r deleted_count deleted_bytes deleted_inaccessible < <(deleted_open_metrics)
  category_json='{'
  separator=''
  for category in "${CATEGORIES[@]}"; do
    category_json+="$separator\"$category\":${CATEGORY_RECLAIMED[$category]:-0}"
    separator=','
  done
  category_json+='}'
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  METRICS_TEMP=$(mktemp "$metrics_parent/.storage-maintenance-status.XXXXXX")
  chmod 0644 "$METRICS_TEMP"
  printf '{\n  "schema_version": 1,\n  "filesystem_total_bytes": %s,\n  "filesystem_used_bytes": %s,\n  "filesystem_free_bytes": %s,\n  "filesystem_used_percent": %s,\n  "inodes_total": %s,\n  "inodes_used": %s,\n  "docker_logical_bytes": %s,\n  "docker_images_logical_bytes": %s,\n  "docker_unused_tagged_logical_bytes": %s,\n  "docker_unused_untagged_logical_bytes": %s,\n  "known_logs_bytes": %s,\n  "repository_bytes": %s,\n  "vscode_server_logical_bytes": %s,\n  "cursor_server_logical_bytes": %s,\n  "npm_cache_logical_bytes": %s,\n  "allowlisted_user_caches_logical_bytes": %s,\n  "pm2_logs_logical_bytes": %s,\n  "home_assistant_recorder_logical_bytes": %s,\n  "home_assistant_backups_logical_bytes": %s,\n  "deleted_open_bytes": %s,\n  "deleted_open_count": %s,\n  "deleted_open_scan_complete": %s,\n  "last_maintenance_at": "%s",\n  "phase2_last_maintenance_at": "%s",\n  "last_reclaimed_bytes": %s,\n  "last_filesystem_net_reclaimed_bytes": %s,\n  "last_reclaimed_by_category": %s,\n  "last_result": "%s"\n}\n' \
    "$total" "$used" "$free" "$used_percent" "$inode_total" "$inode_used" "$docker_bytes" "$docker_images_bytes" "$docker_unused_tagged_bytes" "$docker_unused_untagged_bytes" "$logs_bytes" "$repo_bytes" "$vscode_bytes" "$cursor_bytes" "$npm_bytes" "$user_cache_bytes" "$pm2_bytes" "$recorder_bytes" "$backup_bytes" "$deleted_bytes" "$deleted_count" "$([[ $deleted_inaccessible -eq 0 ]] && echo true || echo false)" "$now" "$now" "$reclaimed" "$reclaimed" "$category_json" "$result" > "$METRICS_TEMP"
  mv -f -- "$METRICS_TEMP" "$METRICS_FILE"
  METRICS_TEMP=""
  log "metric status_file=$METRICS_FILE"
}

for category in "${CATEGORIES[@]}"; do
  case "$category" in
    report) report_inventory ;;
    logs) clean_logs ;;
    pm2-logs) clean_pm2_logs ;;
    journald) clean_journald ;;
    apt-cache) clean_apt_cache ;;
    temporary-files) clean_temporary_files ;;
    docker-images) clean_docker_images ;;
    docker-build-cache) clean_docker_build_cache ;;
    docker-tagged-images) report_docker_tagged_images ;;
    stopped-containers) report_stopped_containers ;;
    git) report_git ;;
    project-artifacts) clean_project_artifacts ;;
    developer-tools) report_developer_tools ;;
    user-caches) report_user_caches ;;
    npm-cache) clean_npm_cache ;;
    python-cache) clean_python_cache ;;
    vscode-versions) clean_vscode_versions ;;
    vscode-cache) clean_vscode_cache ;;
    deleted-open-files) report_deleted_open_files ;;
    home-assistant-recorder) report_home_assistant_recorder ;;
    home-assistant-backups) clean_home_assistant_backups ;;
  esac
done

STEP="final-metrics"
AFTER_BYTES=$(filesystem_used_bytes)
RECLAIMED_BYTES=0
if [[ "$MODE" == apply ]] && (( BEFORE_BYTES > AFTER_BYTES )); then RECLAIMED_BYTES=$((BEFORE_BYTES - AFTER_BYTES)); fi
RESULT=success
if (( WARNINGS > 0 )); then RESULT=partial; fi
write_metrics "$RESULT" "$RECLAIMED_BYTES"
log "status=$RESULT mode=$MODE filesystem=$FILESYSTEM before_bytes=$BEFORE_BYTES after_bytes=$AFTER_BYTES reclaimed_bytes=$RECLAIMED_BYTES removed_count=$REMOVED_COUNT removed_bytes=$REMOVED_BYTES warnings=$WARNINGS"
