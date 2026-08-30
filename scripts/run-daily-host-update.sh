#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
node_bin="${DAILY_UPDATE_NODE_BIN:-/usr/bin/node}"
docker_update_script="${DOCKER_UPDATE_SCRIPT:-$script_dir/docker-auto-update.mjs}"
sudo_bin="${DAILY_UPDATE_SUDO_BIN:-/usr/bin/sudo}"
dietpi_helper="${DIETPI_UPDATE_HELPER:-/usr/local/sbin/smart-home-dietpi-daily-upgrade}"
dietpi_status_file="${DIETPI_UPDATE_STATUS_FILE:-/run/smart-home-dietpi-daily-upgrade.result}"
detail_file="${DAILY_UPDATE_DETAIL_FILE:-}"
dry_run=false

if [ "${1:-}" = "--dry-run" ]; then
  dry_run=true
  shift
fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--dry-run]" >&2; exit 64; }

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

if [ "$dry_run" = true ]; then
  echo "dry-run: $sudo_bin -n $dietpi_helper"
  "$node_bin" "$docker_update_script" daily --dry-run
  write_detail "dietpi_exit=0 containers_exit=0 mode=dry-run"
  exit 0
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

echo "daily-host-update stage=containers started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
"$node_bin" "$docker_update_script" daily
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
