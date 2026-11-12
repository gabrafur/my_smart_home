#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$root" = /mnt/data/docker ] || { echo 'Unexpected active checkout' >&2; exit 1; }
node -e 'require("js-yaml")' >/dev/null
install -d -m 0755 /opt/zigbee-coordinator-recovery
install -m 0644 "$root/scripts/zigbee-coordinator-recovery.mjs" /opt/zigbee-coordinator-recovery/recovery.mjs
install -m 0644 "$root/scripts/zigbee-coordinator-recovery.mjs" /opt/zigbee-coordinator-recovery/zigbee-coordinator-recovery.mjs
install -m 0644 "$root/scripts/zigbee-firmware-maintenance.mjs" /opt/zigbee-coordinator-recovery/firmware.mjs
install -d -m 0700 /var/lib/zigbee-coordinator-recovery
install -d -o 1000 -g 1000 -m 0750 "$root/nodered/zigbee-recovery"
install -d -o 1000 -g 1000 -m 0750 "$root/nodered/zigbee-recovery/firmware-requests"
if [ ! -e "$root/nodered/zigbee-recovery/firmware-result.json" ]; then
  printf '%s\n' '{"schema_version":1,"observed_at":0,"latest":null,"events":[]}' > "$root/nodered/zigbee-recovery/firmware-result.json.new"
  chmod 0644 "$root/nodered/zigbee-recovery/firmware-result.json.new"
  mv "$root/nodered/zigbee-recovery/firmware-result.json.new" "$root/nodered/zigbee-recovery/firmware-result.json"
fi
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
TimeoutStartSec=240
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
cat > /etc/systemd/system/zigbee-firmware-maintenance.service <<'EOF'
[Unit]
Description=Validated daily SMLIGHT firmware transaction
After=docker.service
Requires=docker.service
ConditionPathExistsGlob=/mnt/data/docker/nodered/zigbee-recovery/firmware-requests/*.json
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -w 3600 /mnt/data/docker/.daily-maintenance.lock /usr/bin/node /opt/zigbee-coordinator-recovery/firmware.mjs
UMask=0077
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=4200
MemoryMax=256M
EOF
cat > /etc/systemd/system/zigbee-firmware-maintenance.timer <<'EOF'
[Unit]
Description=Process the daily coordinator firmware queue
[Timer]
OnBootSec=120s
OnUnitInactiveSec=60s
AccuracySec=3s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now zigbee-firmware-maintenance.timer

cat > /etc/systemd/system/zigbee-firmware-inventory.service <<'EOF'
[Unit]
Description=Read-only SMLIGHT stable firmware inventory
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/zigbee-coordinator-recovery/firmware.mjs --inventory
UMask=0077
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=100
MemoryMax=192M
EOF
cat > /etc/systemd/system/zigbee-firmware-inventory.timer <<'EOF'
[Unit]
Description=Refresh stable coordinator firmware facts every 30 minutes
[Timer]
OnBootSec=60s
OnUnitInactiveSec=1800s
AccuracySec=10s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now zigbee-firmware-inventory.timer
