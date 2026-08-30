#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "DietPi daily upgrade must run as root" >&2; exit 77; }

lock_file="/run/lock/smart-home-dietpi-daily-upgrade.lock"
status_file="/run/smart-home-dietpi-daily-upgrade.result"
exec 9>"$lock_file"
if ! /usr/bin/flock -n 9; then
  echo "DietPi package update is already running" >&2
  exit 75
fi

publish_status() {
  temporary="${status_file}.$$"
  printf '%s\n' "$1" > "$temporary"
  chmod 0644 "$temporary"
  mv "$temporary" "$status_file"
}

run_stage() {
  stage=$1
  shift
  publish_status "dietpi-maintenance status=running stage=$stage"
  set +e
  "$@"
  stage_status=$?
  set -e
  if [ "$stage_status" -ne 0 ]; then
    publish_status "dietpi-maintenance status=failed stage=$stage exit_code=$stage_status"
    exit "$stage_status"
  fi
}

echo "dietpi-update stage=apt-get-update started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_stage apt-get-update /usr/bin/timeout 1800 /usr/bin/apt-get \
  -o APT::Update::Lock::Timeout=300 \
  update

echo "dietpi-update stage=apt-get-upgrade started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_stage apt-get-upgrade /usr/bin/timeout 7200 /usr/bin/apt-get \
  -y \
  --with-new-pkgs \
  -o DPkg::Lock::Timeout=300 \
  -o Dpkg::Options::=--force-confold \
  upgrade

[ -x /boot/dietpi/dietpi-update ] || {
  publish_status "dietpi-maintenance status=failed stage=dietpi-update exit_code=66"
  echo "DietPi updater is unavailable" >&2
  exit 66
}
install_stage=$(sed -n '1p' /boot/dietpi/.install_stage 2>/dev/null || true)
[ "$install_stage" = "2" ] || {
  publish_status "dietpi-maintenance status=failed stage=dietpi-update-safety exit_code=78"
  echo "DietPi updater refused outside completed install stage" >&2
  exit 78
}
echo "dietpi-update stage=dietpi-update started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
publish_status "dietpi-maintenance status=running stage=dietpi-update"
set +e
/usr/bin/timeout 7200 /boot/dietpi/dietpi-update 1 < /dev/null
dietpi_update_status=$?
set -e
if [ "$dietpi_update_status" -ne 0 ]; then
  publish_status "dietpi-maintenance status=failed stage=dietpi-update exit_code=$dietpi_update_status"
  exit "$dietpi_update_status"
fi

if [ -f /var/run/reboot-required ]; then
  publish_status "dietpi-maintenance status=success stage=complete reboot_required=true"
  echo "dietpi-update status=success reboot_required=true"
else
  publish_status "dietpi-maintenance status=success stage=complete reboot_required=false"
  echo "dietpi-update status=success reboot_required=false"
fi
