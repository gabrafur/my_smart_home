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
declare -a CATEGORIES=()
declare -a DEFAULT_CATEGORIES=(report logs temporary-files docker-images docker-build-cache project-artifacts)
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
  --ha-backup-retention-days DAYS  Report threshold; never deletes HA backups
  --min-free-bytes BYTES           Apply safety floor
  --max-used-percent PERCENT       Apply safety ceiling
  --metrics-file PATH              Apply status JSON inside metrics root
  --allow-privileged-cleanup       Permit explicitly selected apt/journald apply
  -h, --help

Categories:
  report, logs, journald, apt-cache, temporary-files, docker-images,
  docker-build-cache, stopped-containers, git, project-artifacts,
  home-assistant-backups, all

stopped-containers, git and home-assistant-backups are report-only.
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
    report|logs|journald|apt-cache|temporary-files|docker-images|docker-build-cache|stopped-containers|git|project-artifacts|home-assistant-backups) ;;
    *) die "unknown-category-$1" ;;
  esac
}

add_category() {
  local category=$1 item
  if [[ "$category" == all ]]; then
    for item in report logs journald apt-cache temporary-files docker-images docker-build-cache stopped-containers git project-artifacts home-assistant-backups; do
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

for value in "$MIN_AVAILABLE_KB" "$MIN_FREE_BYTES" "$MAX_DISK_PERCENT" "$MIN_AGE_HOURS" "$LOG_RETENTION_DAYS" "$TEMP_RETENTION_DAYS" "$PROJECT_RETENTION_DAYS" "$JOURNAL_RETENTION_DAYS" "$HA_BACKUP_RETENTION_DAYS"; do
  validate_uint "$value" configuration-value
done
[[ "$MAX_BUILD_CACHE" =~ ^[1-9][0-9]*([KMGT]B)?$ ]] || die "invalid-max-build-cache"

STEP="preflight"
for dependency in awk date df du find flock git readlink realpath sed sort stat; do
  command -v "$dependency" >/dev/null 2>&1 || die "missing-dependency-$dependency" 69
done
validate_existing_directory "$REPO_ROOT" repository-root
validate_existing_directory "$FILESYSTEM" filesystem true
validate_existing_directory "$TEMP_ROOT" temporary-root
validate_existing_directory "$METRICS_ROOT" metrics-root
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

warn_unavailable() {
  log "status=skipped reason=$1"
  WARNINGS=$((WARNINGS + 1))
}

measure_category() {
  local category=$1 before=$2 after delta=0
  after=$(filesystem_used_bytes)
  if [[ "$MODE" == apply ]] && (( before > after )); then delta=$((before - after)); fi
  log "status=category-complete category=$category reclaimed_bytes=$delta"
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
  measure_category report "$before"
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

clean_docker_images() {
  local before id repository tag containers created created_epoch cutoff_epoch refs size
  STEP="category-docker-images"
  before=$(filesystem_used_bytes)
  if ! docker_available; then warn_unavailable docker-unavailable; measure_category docker-images "$before"; return; fi
  cutoff_epoch=$(date -u -d "$MIN_AGE_HOURS hours ago" +%s)
  "$DOCKER_BIN" image ls --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Containers}}' |
    while IFS=$'\t' read -r id repository tag containers; do
    [[ "$tag" == '<none>' && "$containers" == 0 ]] || continue
    created=$("$DOCKER_BIN" image inspect -f '{{.Created}}' "$id")
    created_epoch=$(date -u -d "$created" +%s)
    (( created_epoch <= cutoff_epoch )) || continue
    refs=$("$DOCKER_BIN" ps -aq --filter "ancestor=$id")
    [[ -z "$refs" ]] || continue
    size=$("$DOCKER_BIN" image inspect -f '{{.Size}}' "$id")
    log "candidate action=untagged-unreferenced-image content_bytes=$size repository=$repository image_id=$id created=$created"
    if [[ "$MODE" == apply ]]; then
      "$DOCKER_BIN" image rm "$id"
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
      log "removed action=untagged-unreferenced-image approximate_bytes=$size image_id=$id"
    fi
    done
  if [[ "$MODE" == apply ]]; then
    "$DOCKER_BIN" image prune --force --filter "until=${MIN_AGE_HOURS}h"
  else
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
  measure_category stopped-containers "$before"
}

report_git() {
  local before
  STEP="category-git"
  before=$(filesystem_used_bytes)
  git -C "$REPO_ROOT" count-objects -vH
  git -C "$REPO_ROOT" worktree list --porcelain
  log "status=report-only category=git reason=gc-and-worktree-prune-require-review"
  measure_category git "$before"
}

report_home_assistant_backups() {
  local before backup_root count bytes old_count old_bytes summary
  STEP="category-home-assistant-backups"
  before=$(filesystem_used_bytes)
  backup_root="$REPO_ROOT/homeassistant/backups"
  if [[ -d "$backup_root" && ! -L "$backup_root" ]]; then
    summary=$(find "$backup_root" -xdev -maxdepth 1 -type f -printf '%s %T@\n' |
      awk -v cutoff="$(date -u -d "$HA_BACKUP_RETENTION_DAYS days ago" +%s)" '{count++; bytes+=$1; if ($2<cutoff) {old_count++; old_bytes+=$1}} END {printf "%d %d %d %d\n",count,bytes,old_count,old_bytes}')
    read -r count bytes old_count old_bytes <<<"$summary"
    log "metric component=home-assistant-backups count=$count bytes=$bytes older_than_days=$HA_BACKUP_RETENTION_DAYS old_count=$old_count old_bytes=$old_bytes"
  else
    log "metric component=home-assistant-backups count=0 bytes=0"
  fi
  log "status=report-only category=home-assistant-backups reason=external-copy-not-proven"
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
  [[ "$MODE" == apply ]] || return 0
  total=$(df -P -B1 "$FILESYSTEM" | awk 'NR == 2 {print $2 + 0}')
  used=$(filesystem_used_bytes)
  free=$(filesystem_available_bytes)
  used_percent=$(filesystem_used_percent)
  inode_summary=$(df -Pi "$FILESYSTEM" | awk 'NR == 2 {print $2 + 0, $4 + 0}')
  read -r inode_total inode_free <<<"$inode_summary"
  inode_used=$((inode_total - inode_free))
  docker_bytes=$(docker_total_bytes)
  logs_bytes=$(known_logs_bytes)
  repo_bytes=$(bytes_for_path "$REPO_ROOT")
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  METRICS_TEMP=$(mktemp "$metrics_parent/.storage-maintenance-status.XXXXXX")
  chmod 0644 "$METRICS_TEMP"
  printf '{\n  "schema_version": 1,\n  "filesystem_total_bytes": %s,\n  "filesystem_used_bytes": %s,\n  "filesystem_free_bytes": %s,\n  "filesystem_used_percent": %s,\n  "inodes_total": %s,\n  "inodes_used": %s,\n  "docker_logical_bytes": %s,\n  "known_logs_bytes": %s,\n  "repository_bytes": %s,\n  "last_maintenance_at": "%s",\n  "last_reclaimed_bytes": %s,\n  "last_result": "%s"\n}\n' \
    "$total" "$used" "$free" "$used_percent" "$inode_total" "$inode_used" "$docker_bytes" "$logs_bytes" "$repo_bytes" "$now" "$reclaimed" "$result" > "$METRICS_TEMP"
  mv -f -- "$METRICS_TEMP" "$METRICS_FILE"
  METRICS_TEMP=""
  log "metric status_file=$METRICS_FILE"
}

for category in "${CATEGORIES[@]}"; do
  case "$category" in
    report) report_inventory ;;
    logs) clean_logs ;;
    journald) clean_journald ;;
    apt-cache) clean_apt_cache ;;
    temporary-files) clean_temporary_files ;;
    docker-images) clean_docker_images ;;
    docker-build-cache) clean_docker_build_cache ;;
    stopped-containers) report_stopped_containers ;;
    git) report_git ;;
    project-artifacts) clean_project_artifacts ;;
    home-assistant-backups) report_home_assistant_backups ;;
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
