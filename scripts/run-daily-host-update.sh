#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_bin="${DAILY_UPDATE_NODE_BIN:-/usr/bin/node}"
docker_update_script="${DOCKER_UPDATE_SCRIPT:-$script_dir/docker-auto-update.mjs}"
codex_cli_update_script="${CODEX_CLI_UPDATE_SCRIPT:-$script_dir/update-codex-cli.sh}"
offsite_backup_script="${OFFSITE_BACKUP_SCRIPT:-$script_dir/offsite-backup.mjs}"
sudo_bin="${DAILY_UPDATE_SUDO_BIN:-/usr/bin/sudo}"
dietpi_helper="${DIETPI_UPDATE_HELPER:-/usr/local/sbin/smart-home-dietpi-daily-upgrade}"
dietpi_status_file="${DIETPI_UPDATE_STATUS_FILE:-/run/smart-home-dietpi-daily-upgrade.result}"
detail_file="${DAILY_UPDATE_DETAIL_FILE:-}"
docker_bin="${DAILY_UPDATE_DOCKER_BIN:-/usr/bin/docker}"
readiness_script="${DAILY_UPDATE_READINESS_SCRIPT:-$script_dir/service-readiness-report.mjs}"
meminfo_file="${DAILY_UPDATE_MEMINFO:-/proc/meminfo}"
minimum_available_mib="${DAILY_UPDATE_MIN_AVAILABLE_MIB:-2048}"
dry_run=false
stage="all"

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    offsite-backup|dietpi|home-assistant-core|containers|codex-cli)
      [ "$stage" = "all" ] || { echo "Only one update stage may be selected" >&2; exit 64; }
      stage=$argument
      ;;
    all) ;;
    *) echo "Usage: $0 [offsite-backup|dietpi|home-assistant-core|containers|codex-cli|all] [--dry-run]" >&2; exit 64 ;;
  esac
done

write_detail() {
  [ -n "$detail_file" ] || return 0
  case "$detail_file" in
    /*) ;;
    *) echo "DAILY_UPDATE_DETAIL_FILE must be absolute" >&2; exit 64 ;;
  esac
  temporary="${detail_file}.$$"
  umask 077
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$detail_file"
}

# Heavy stages wait (exit 75: the request is kept and retried next minute) while the
# host has less than the minimum available memory, so an update never starts under pressure.
require_memory() {
  available_kib=$(sed -n 's/^MemAvailable: *\([0-9][0-9]*\) kB$/\1/p' "$meminfo_file" 2>/dev/null | head -n 1)
  case "$available_kib" in ''|*[!0-9]*) available_kib=0 ;; esac
  available_mib=$((available_kib / 1024))
  if [ "$available_mib" -lt "$minimum_available_mib" ]; then
    echo "daily-host-update stage=$1 deferred reason=memory_low available_mib=$available_mib minimum_mib=$minimum_available_mib"
    exit 75
  fi
}

# Running containers and their start times; used to report which ones a stage restarted.
container_starts() {
  ids=$("$docker_bin" ps --quiet --no-trunc 2>/dev/null) || return 1
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  "$docker_bin" inspect --format '{{.Id}} {{.State.StartedAt}}' $ids 2>/dev/null | sort
}

restarted_count() {
  before=$1
  after=$2
  [ "$before" != unknown ] && [ "$after" != unknown ] || { echo unknown; return; }
  printf '%s\n' "$before" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s\n' "$after" | grep -qxF -- "$line" || echo changed
  done | wc -l | tr -d ' '
}

run_dietpi() {
  if [ "$dry_run" = true ]; then
    echo "dry-run: $sudo_bin -n $dietpi_helper"
    dietpi_status=0
    dietpi_stage="dry-run"
    return
  fi

  echo "daily-host-update stage=dietpi started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dietpi_status_before=$(stat -c '%y' "$dietpi_status_file" 2>/dev/null || true)
  set +e
  "$sudo_bin" -n "$dietpi_helper"
  dietpi_status=$?
  set -e
  dietpi_status_after=$(stat -c '%y' "$dietpi_status_file" 2>/dev/null || true)

  dietpi_stage="unknown"
  if [ "$dietpi_status" -ne 0 ] && [ "$dietpi_status_before" = "$dietpi_status_after" ]; then
    dietpi_stage="sudo"
  elif [ -r "$dietpi_status_file" ]; then
    parsed_stage=$(sed -n '1p' "$dietpi_status_file" | sed -n 's/.* stage=\([A-Za-z0-9_.-]*\).*/\1/p')
    [ -z "$parsed_stage" ] || dietpi_stage=$parsed_stage
  fi
}

run_images() {
  image_mode=$1
  if [ "$dry_run" = true ]; then
    "$node_bin" "$docker_update_script" "$image_mode" --dry-run
  else
    "$node_bin" "$docker_update_script" "$image_mode"
  fi
}

# Report (never act) whether HA, MQTT, Node-RED and Zigbee are ready after a stage
# that stops or recreates services. Prints one static field for the detail line.
readiness_field() {
  local value
  value=$("$node_bin" "$readiness_script" 2>/dev/null | sed -n '1p' | tr -cd 'a-z0-9_=:,') || value=""
  case "$value" in readiness=ok|readiness=degraded:*) ;; *) value=readiness=unknown ;; esac
  printf '%s' "$value"
}

if [ "$stage" = "offsite-backup" ]; then
  if [ "$dry_run" = true ]; then
    write_detail "stage=offsite-backup stage_exit=0 components=13 capture_verified=false remote_verified=false protected=false action=dry-run mode=dry-run"
    echo "dry-run: $node_bin $offsite_backup_script daily-cycle"
    exit 0
  fi
  [ -r "$offsite_backup_script" ] || {
    write_detail "stage=offsite-backup stage_exit=66 components=0 capture_verified=false remote_verified=false protected=false action=unavailable mode=production"
    exit 66
  }
  set +e
  offsite_detail=$($node_bin "$offsite_backup_script" daily-cycle)
  offsite_status=$?
  set -e
  offsite_detail=$(printf '%s\n' "$offsite_detail" | sed -n '1p' | tr -cd 'A-Za-z0-9_.:=@ -')
  # The consistent capture stops services with data for about a minute.
  readiness=$(readiness_field)
  echo "daily-host-update stage=offsite-backup $readiness"
  write_detail "stage=offsite-backup stage_exit=$offsite_status $offsite_detail $readiness mode=production"
  exit "$offsite_status"
fi

if [ "$stage" = "dietpi" ]; then
  [ "$dry_run" = true ] || require_memory dietpi
  starts_before=$(container_starts) || starts_before=unknown
  run_dietpi
  starts_after=$(container_starts) || starts_after=unknown
  containers_restarted=$(restarted_count "$starts_before" "$starts_after")
  # Report (never act) whether HA, MQTT, Node-RED and Zigbee are ready after the stage.
  readiness=readiness=not_checked
  if [ "$dry_run" != true ]; then
    readiness=$(readiness_field)
    echo "daily-host-update stage=dietpi $readiness"
  fi
  write_detail "stage=dietpi stage_exit=$dietpi_status failure_stage=$dietpi_stage containers_restarted=$containers_restarted $readiness mode=$([ "$dry_run" = true ] && printf dry-run || printf production)"
  exit "$dietpi_status"
fi

if [ "$stage" = "home-assistant-core" ] || [ "$stage" = "containers" ]; then
  [ "$dry_run" = true ] || require_memory "$stage"
  echo "daily-host-update stage=$stage started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Keep streaming to the cron log, but also record the last static refusal code so the
  # result says why the stage stopped (for example a safety gate) instead of only exit 1.
  image_output=$(mktemp)
  image_status_file=$(mktemp)
  set +e
  { run_images "$stage" 2>&1; echo $? > "$image_status_file"; } | tee "$image_output"
  image_status=$(cat "$image_status_file")
  set -e
  image_reason=$(grep -aoE '(update blocked reason|git-backup-reason)=[a-z0-9_]{1,64}' "$image_output" | tail -n 1 | sed 's/.*=//')
  # 19/11: the stage stopped before recreating anything because a service had no healthcheck
  # and was reported only as "unclassified".
  if [ -z "$image_reason" ] && grep -aqE 'Service [A-Za-z0-9_.-]+ has no readiness probe or healthcheck' "$image_output"; then
    image_reason=readiness_coverage_missing
  fi
  rm -f -- "$image_output" "$image_status_file"
  case "$image_status" in ''|*[!0-9]*) image_status=70 ;; esac
  reason_field=""
  [ "$image_status" -eq 0 ] || reason_field=" reason=${image_reason:-unclassified}"
  # The updater already waits for each recreated service; this reports the core
  # services as a whole after the stage, including the ones it did not touch.
  readiness_detail=""
  if [ "$dry_run" != true ]; then
    readiness_detail=" $(readiness_field)"
    echo "daily-host-update stage=$stage${readiness_detail}"
  fi
  write_detail "stage=$stage stage_exit=$image_status${reason_field}${readiness_detail} mode=$([ "$dry_run" = true ] && printf dry-run || printf production)"
  exit "$image_status"
fi

if [ "$stage" = "codex-cli" ]; then
  if [ "$dry_run" = true ]; then
    write_detail "stage=codex-cli stage_exit=0 action=dry-run mode=dry-run"
    echo "dry-run: $codex_cli_update_script"
    exit 0
  fi

  [ -x "$codex_cli_update_script" ] || {
    write_detail "stage=codex-cli stage_exit=66 action=unavailable mode=production"
    echo "Codex CLI update script is unavailable: $codex_cli_update_script" >&2
    exit 66
  }
  echo "daily-host-update stage=codex-cli started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  codex_cli_detail=$($codex_cli_update_script)
  codex_cli_status=$?
  set -e
  codex_cli_detail=$(printf '%s\n' "$codex_cli_detail" | sed -n '1p' | tr -cd 'A-Za-z0-9_.:=@ -')
  write_detail "stage=codex-cli stage_exit=$codex_cli_status $codex_cli_detail mode=production"
  exit "$codex_cli_status"
fi

# Compatibility entrypoint for operators and rollback: preserve the former
# combined behavior while Node-RED uses the four explicit stage entrypoints.
if [ "$dry_run" = true ]; then
  run_dietpi
  run_images daily
  write_detail "dietpi_exit=0 containers_exit=0 mode=dry-run"
  exit 0
fi

run_dietpi
echo "daily-host-update stage=containers started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
run_images daily
containers_status=$?
set -e

write_detail "dietpi_exit=$dietpi_status dietpi_stage=$dietpi_stage containers_exit=$containers_status"
if [ "$dietpi_status" -eq 75 ] || [ "$containers_status" -eq 75 ]; then
  exit 75
fi
if [ "$dietpi_status" -ne 0 ]; then
  exit "$dietpi_status"
fi
exit "$containers_status"
