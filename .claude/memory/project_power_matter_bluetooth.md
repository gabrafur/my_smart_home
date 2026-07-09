---
name: project-power-matter-bluetooth
description: "User approved host-level access (NET_ADMIN/NET_RAW, /run/dbus, host-networked matter_server) so Home Assistant can control Raspberry/PC power and Matter/Bluetooth"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95081cf6-6e00-4f9a-9ab5-e6f884808b23
---

User gave explicit approval (in a prior Codex session, 2026-07-05) to recreate
the `homeassistant` container with `cap_add: NET_ADMIN, NET_RAW`, mount
`/run/dbus:/run/dbus:ro`, and run a `matter_server` container in
`network_mode: host` with `/run/dbus` mounted — increasing host access for the
containers — specifically to enable: Bluetooth (Matter/BLE devices showing as
"discovered" but not completable), Matter integration, and D-Bus-based power
control of the Raspberry Pi itself.

As part of the same approval, the user authorized SSH-based reboot/shutdown of
their PC (`gabra@192.168.0.153:22`) from Home Assistant, with the instruction
"faça até dar certo" (keep at it until it works).

**Why:** Bluetooth/Matter devices were stuck at "discovered" and could not be
finished from inside the container without host D-Bus access; there was no
other way to reboot/power off the Raspberry (host) or the user's PC from
Home Assistant.

**How to apply:** This is already implemented — see
`docker-compose.yml` (homeassistant has the caps + dbus mount; `matter_server`
runs `network_mode: host`) and
[docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md](docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md)
(scripts `script.raspberry_reiniciar/desligar`, `script.pc_reiniciar/desligar`,
SSH key at `homeassistant/.ssh/ha_power_ed25519.pub`, secrets
`pc_power_*`). Treat further host-access expansions for this container as
already pre-approved in spirit, but still confirm scope for anything beyond
power/Bluetooth/Matter.

**2026-07-09 follow-up:** the compose-level access alone wasn't enough —
Bluetooth stayed stuck at "discovered" because (1) the running `homeassistant`
container was created before `cap_add`/dbus were added to compose, so it was
live with none of those permissions until recreated; (2) `matter_server` was
defined in compose but had never actually been created/started; (3) the host
had no BlueZ (`bluetoothd`) installed at all, and the onboard Broadcom
BT firmware never loaded (adapter stuck at placeholder MAC
`AA:AA:AA:AA:AA:AA`). Fixed by installing `bluez`/`pi-bluetooth`/
`firmware-brcm80211` on the host, force-reloading firmware via
unbind/rebind of `serial0-0` from `hci_uart_bcm` (no reboot needed), then
`docker compose up -d homeassistant matter_server` to recreate with current
config. Full details and the exact commands are in
[docs/BLUETOOTH_MATTER.md](docs/BLUETOOTH_MATTER.md). User provided a
Home Assistant long-lived access token, stored at
`.local-secrets/ha-long-lived-token.txt` (mode 600, gitignored) — usable for
finishing config_entries flows (e.g. bluetooth/matter setup) via the HA REST
API when the UI can't be driven directly. Also learned: HA's local Bluetooth
adapter does NOT auto-create a config entry on restart even when everything
is correctly wired — it must be triggered explicitly (POST to
`/api/config/config_entries/flow` with `handler: bluetooth`, then confirm the
returned flow_id) after any stale/ignored entry for the old MAC is deleted.
