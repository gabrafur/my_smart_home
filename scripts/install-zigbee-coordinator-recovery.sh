#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$root" = /mnt/data/docker ] || { echo 'Unexpected active checkout' >&2; exit 1; }
node -e 'require("js-yaml")' >/dev/null
install -d -m 0755 /opt/zigbee-coordinator-recovery
install -m 0644 "$root/scripts/zigbee-coordinator-recovery.mjs" /opt/zigbee-coordinator-recovery/recovery.mjs
install -d -m 0700 /var/lib/zigbee-coordinator-recovery
install -d -o 1000 -g 1000 -m 0750 "$root/nodered/zigbee-recovery"
cat > /etc/systemd/system/zigbee-coordinator-recovery.service <<'EOF'
[Unit]
Description=Zigbee facts and bounded Node-RED recovery adapter
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /run/zigbee-coordinator-recovery.lock /usr/bin/node /opt/zigbee-coordinator-recovery/recovery.mjs
UMask=0077
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=100
MemoryMax=192M
EOF
cat > /etc/systemd/system/zigbee-coordinator-recovery.timer <<'EOF'
[Unit]
Description=Publish Zigbee recovery facts and process fixed requests
[Timer]
OnBootSec=90s
OnUnitInactiveSec=15s
AccuracySec=2s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now zigbee-coordinator-recovery.timer
