#!/bin/sh
# Enable Docker live-restore so a daemon restart or engine upgrade (for example the
# DietPi APT stage upgrading docker-ce) keeps the containers running.
# Idempotent: merges one key into /etc/docker/daemon.json and reloads (SIGHUP) the
# daemon, which applies live-restore without restarting any container.
set -eu

config="${DOCKER_DAEMON_CONFIG:-/etc/docker/daemon.json}"
docker_bin="${DOCKER_BIN:-/usr/bin/docker}"
systemctl_bin="${SYSTEMCTL_BIN:-/usr/bin/systemctl}"

[ "$(id -u)" -eq 0 ] || { echo "install-docker-live-restore must run as root" >&2; exit 77; }
[ ! -L "$config" ] || { echo "refusing symlinked daemon config" >&2; exit 78; }
if [ "$("$docker_bin" info --format '{{.Swarm.LocalNodeState}}')" = active ]; then
  echo "live-restore is incompatible with swarm mode" >&2
  exit 78
fi

directory=$(dirname "$config")
install -d -m 755 "$directory"
temporary="$config.live-restore.$$"
/usr/bin/python3 -I - "$config" "$temporary" <<'EOF'
import json, os, sys
source, target = sys.argv[1], sys.argv[2]
try:
    with open(source, encoding='utf-8') as handle:
        value = json.load(handle)
except FileNotFoundError:
    value = {}
if not isinstance(value, dict):
    raise SystemExit('daemon config must be a JSON object')
value['live-restore'] = True
with open(target, 'x', encoding='utf-8') as handle:
    json.dump(value, handle, indent=2, sort_keys=True)
    handle.write('\n')
os.chmod(target, 0o644)
EOF
if [ -f "$config" ] && cmp -s "$config" "$temporary"; then
  rm -f -- "$temporary"
else
  mv "$temporary" "$config"
fi

"$systemctl_bin" reload docker
if [ "$("$docker_bin" info --format '{{.LiveRestoreEnabled}}')" != true ]; then
  echo "docker-live-restore status=unconfirmed" >&2
  exit 1
fi
echo "docker-live-restore status=enabled"
