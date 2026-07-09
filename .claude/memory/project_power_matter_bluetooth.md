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
