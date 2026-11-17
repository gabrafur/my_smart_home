#!/bin/sh
# Stop the containers gracefully when the host shuts down.
# With Docker live-restore (install-docker-live-restore.sh) stopping dockerd no longer
# stops the containers, so on a reboot they were only killed by the final systemd sweep;
# after the 17/11 reboot Home Assistant reported that its previous run did not close
# cleanly. This unit does nothing at start; its stop action runs before docker.service
# stops (reverse order of After=), giving every container up to 60 s to exit.
# A Docker upgrade or `systemctl restart docker` does not stop this unit, so live-restore
# still keeps the house running in that case. Containers come back at boot through their
# `restart: always` policy, which the installer verifies.
set -eu

unit_dir="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
unit="$unit_dir/smart-home-container-shutdown.service"
docker_bin="${DOCKER_BIN:-/usr/bin/docker}"
systemctl_bin="${SYSTEMCTL_BIN:-/usr/bin/systemctl}"

[ "$(id -u)" -eq 0 ] || { echo "install-container-shutdown-guard must run as root" >&2; exit 77; }

# A container stopped with `docker stop` comes back at boot only with restart=always.
not_always=$("$docker_bin" ps --quiet | while read -r id; do
  "$docker_bin" inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' "$id"
done | awk '$2 != "always" {sub("^/", "", $1); print $1}')
if [ -n "$not_always" ]; then
  echo "refusing: these running containers would not return at boot: $not_always" >&2
  exit 78
fi

temporary="$unit.tmp.$$"
cat > "$temporary" <<'EOF'
[Unit]
Description=Stop containers gracefully before shutdown (Docker live-restore keeps them running)
After=docker.service containerd.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/bin/sh -c 'ids=$(/usr/bin/docker ps --quiet); [ -z "$ids" ] || /usr/bin/docker stop --time 60 $ids'
TimeoutStopSec=150

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$temporary"
if [ -f "$unit" ] && cmp -s "$unit" "$temporary"; then
  rm -f -- "$temporary"
else
  mv "$temporary" "$unit"
  "$systemctl_bin" daemon-reload
fi
# Only start (a no-op); never restart, which would stop every container.
"$systemctl_bin" enable --now smart-home-container-shutdown.service >/dev/null
[ "$("$systemctl_bin" is-active smart-home-container-shutdown.service)" = active ] || {
  echo "container-shutdown-guard status=unconfirmed" >&2; exit 1; }
echo "container-shutdown-guard status=enabled"
