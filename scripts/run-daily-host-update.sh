#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_bin="${DAILY_UPDATE_NODE_BIN:-/usr/bin/node}"
docker_update_script="${DOCKER_UPDATE_SCRIPT:-$script_dir/docker-auto-update.mjs}"
codex_cli_update_script="${CODEX_CLI_UPDATE_SCRIPT:-$script_dir/update-codex-cli.sh}"
sudo_bin="${DAILY_UPDATE_SUDO_BIN:-/usr/bin/sudo}"
dietpi_helper="${DIETPI_UPDATE_HELPER:-/usr/local/sbin/smart-home-dietpi-daily-upgrade}"
dietpi_status_file="${DIETPI_UPDATE_STATUS_FILE:-/run/smart-home-dietpi-daily-upgrade.result}"
detail_file="${DAILY_UPDATE_DETAIL_FILE:-}"
dry_run=false
stage="all"

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    dietpi|home-assistant-core|containers|codex-cli)
      [ "$stage" = "all" ] || { echo "Only one update stage may be selected" >&2; exit 64; }
      stage=$argument
      ;;
    all) ;;
    *) echo "Usage: $0 [dietpi|home-assistant-core|containers|codex-cli|all] [--dry-run]" >&2; exit 64 ;;
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

if [ "$stage" = "dietpi" ]; then
  run_dietpi
  write_detail "stage=dietpi stage_exit=$dietpi_status failure_stage=$dietpi_stage mode=$([ "$dry_run" = true ] && printf dry-run || printf production)"
  exit "$dietpi_status"
fi

if [ "$stage" = "home-assistant-core" ] || [ "$stage" = "containers" ]; then
  echo "daily-host-update stage=$stage started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  run_images "$stage"
  image_status=$?
  set -e
  write_detail "stage=$stage stage_exit=$image_status mode=$([ "$dry_run" = true ] && printf dry-run || printf production)"
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
