# Household lights and actions through MCP

[Português (principal)](household-lights.md) · [English](household-lights.en.md)

The AI assistant (Eva) reads and switches a fixed set of household lights
through two MCP tools:

- `ha_lights_read` lists the registered lights with their current Home
  Assistant state (`on`, `off`, `unavailable`). Read-only.
- `ha_light_set` turns a registered light `on` or `off` and then reads the real
  state. `state=confirmed` means Home Assistant reports the requested state.
  `unconfirmed` (state not reached within 6 s) and `uncertain` (service response
  lost) are never resent automatically; observe with `ha_lights_read`.

Registered targets (policy `/usr/local/lib/raspberry-ha-lights/policy.json`):
`lampadas_garagem`, `lampada_varanda`, `abajour_sala_de_estar`,
`refletores_jardim`, and `refletor_portao_carros`. Only `switch`/`light`
entities can be registered. These tools are v1/v2. The "Whole-house control
(v4)" section below widens the reach: the assistant can now command any
household device.

## Household actions (v3, 2026-11-20)

After the assistant could not switch off the air conditioner or the PC, and the
owner asked for the gate as well, two tools were added on the same broker,
route, and socket:

- `ha_actions_read` lists the registered actions and whether each one can run
  now.
- `ha_action_run` (`destructiveHint: true`, so the connector asks for
  confirmation) runs one action: `target` + `action`, nothing else.

| Target | Action | What Home Assistant runs | Confirmation |
| --- | --- | --- | --- |
| `ar_condicionado_escritorio` | `on` / `off` | `switch.turn_on/off` on `switch.ar_condicionado_escritorio_power` | state read back |
| `workstation_primary` | `poweroff` | `script.turn_on` on `script.pc_desligar` | only that the script ran; the PC is not read |
| `portao_garagem` | `pulse` | `button.press` on `button.acionar_portao_da_garagem` | only that the button registered the pulse |

The service is fixed by the action type (`power`, `poweroff`, `pulse`); the
policy only names the entity and the label. Each type has its own limit,
separate from the lights: `power` 20/h and 5 s, `poweroff` 3/h and 30 s,
`pulse` 6/h and 20 s. None is resent automatically: `unconfirmed` and
`uncertain` call for observation, not repetition.

The gate has no position sensor. A pulse runs the controller's next cycle step
(open, stop, or close), and the result carries `position_unknown`. The button
only publishes the event; Node-RED still owns the physical pulse (OFF → ON →
OFF) and its locks, described in
[the garage gate pulse guide](../../PORTAO_GARAGEM_BOTAO_PULSO.en.md). Turning
the PC on does not exist (it would be Wake-on-LAN, outside the requested scope).

## Path

```
ChatGPT/Claude connector -> tunnel -> raspberry-mcp@ frontend (no network)
  maintenance-entry.mjs -> private-content-route.mjs -> lights-route.mjs
  -> /run/raspberry-mcp/ha-lights.sock -> raspberry-ha-lights@.service
  -> Home Assistant REST on localhost
```

- `maintenance-entry.mjs` has its hash pinned by the maintenance interface gate
  and does not change. `private-content-route.mjs` (not pinned) re-exports its
  route wrapped by `makeLightsRoute`; `overlay.py` derives those bytes from the
  exact installed base.
- The broker runs per request as a `DynamicUser`, without capabilities, with IP
  access to localhost only and `/mnt/data/docker` inaccessible. The Home
  Assistant token arrives only through `LoadCredential` and belongs to a
  dedicated, non-administrator, local-only user (`eva-household-lights`, group
  `system-users`): it reads states and calls `turn_on`/`turn_off`, but cannot
  reach administrative services and APIs. The long-lived administrator token is
  no longer used by the broker.
- Light limits: 30 commands per hour and 3 s between them. Every command is
  written to `/var/lib/raspberry-ha-lights/commands.json` before it is sent
  (24 h history).
- `ha_light_set` is not read-only, so the connector keeps its interface
  confirmation.
- Every call to the two tools enters the frontend audit log (namespace
  `raspberry-mcp`, fields `tool`, `id`, and `success`).
- `maintenance_capabilities` gains a `household_lights` block with the tools and
  targets. The `no_actuators` of the sealed diagnostic broker still applies to
  the diagnostic and maintenance tools and is not rewritten.

## Operation

Sources and tests live in `scripts/raspberry-mcp/ha-lights/`
(`test_broker.py`, `lights-route.test.mjs`). `install.py` is the Root operator,
with the verbs `prepare`, `apply`, `verify`, and `rollback`; that `rollback`
restores the previous image of the private content route and removes the
socket, units, and broker. `upgrade.py` swaps the v1 route for v2 with a
compare-and-swap on the exact v1 bytes, and its `rollback` returns to v1.

New tools appear only on a new frontend connection. After installing, restart
the tunnel (`raspberry-mcp-tunnel.service`) with no MCP operation in progress
and, if the list is cached, refresh the connector's tools in the client.

To disable control while keeping reads, set `enabled` to false in the policy.
Any future change to `private-content-route.mjs` must keep the lighting
wrapper.

v3 was installed by the Root operator `closure-claude-1720/ha-lights-r3/deploy.py`
(compare-and-swap on the exact v2 bytes of `broker.py`, `policy.json`, and
`lights-route.mjs`; previous images in `BEFORE-V2`; `rollback` returns to v2).
The broker runs per connection, so no service restarts; the frontend loads the
new route on the next connection (restart `raspberry-mcp-tunnel.service`).

## `workstation_primary` role (2026-11-22)

The PC shutdown target is now the logical role `workstation_primary`; the
previous personal name left the tracked policy and route. An optional,
private, temporary alias can be rendered at install time for prompts that
still use the old name: the route accepts it, converts it to
`workstation_primary` before the broker, and lists it in
`deprecated_action_aliases`. Redeploy, verification, and alias removal are in
[host logical roles](host-identity-roles.md) (Portuguese).

## Whole-house control (v4, 2026-11-20)

The owner asked for the assistant to control everything in the house (devices,
TV, and the rest), because only the owner and the residents have access to it.
Two tools, on the same broker:

- `ha_entities_read` lists controllable entities (filter by `domain` and
  `search`, up to 100 rows) with state and accepted services.
- `ha_service_call` (`destructiveHint: true`) calls a service on one entity:
  `domain`, `service`, `entity_id`, and optional `data`.

Scope (Root `generic` policy): `light`, `switch`, `fan`, `climate`,
`media_player` (including the TV and streaming sticks), `cover`, `vacuum`,
`remote`, `button`, `scene`, `script`, `input_boolean`, `input_button`,
`number`, `select`, `lock`, and `alarm_control_panel`, each with a closed list
of services. `data` accepts only simple, known fields (`brightness_pct`,
`temperature`, `hvac_mode`, `volume_level`, `source`, ...), with no nested
objects.

Denied in code, not in the policy: `script.raspberry_desligar`,
`script.raspberry_reiniciar`, any entity ending in `_restart`/`_reboot` (the
assistant cannot take down its own Raspberry), and the gate relay
(`switch.rele_acionador_portao`) and its scripts, which only Node-RED drives.
The gate opens only through `ha_action_run` (`portao_garagem`), with its own
limit. Home Assistant administration, `homeassistant.*`, `shell_command`, and
automations are out of scope.

Limits: 120 commands per hour and 1 s between them; `lock` and
`alarm_control_panel` have 10 per hour and 10 s. Every command is recorded
before it is sent and is never resent.

Since v5 (2026-11-26) the state is read back (`confirmed`/`unconfirmed`) whenever
the outcome is predictable: on/off for lights, `switch`, `fan`, `input_boolean`,
and the TV (`media_player`: on is `on`, `idle`, `playing`, `paused`, or
`buffering`; off is `off` or `standby`), play/pause/stop, `lock`, opening and
closing a `cover`, `climate.turn_off`, `climate.set_hvac_mode` (against the
requested mode), vacuum start/pause/return to base, and arming or disarming the
alarm. The TV gets a 20 s window because it wakes over the network. The vacuum,
covers, and alarm get 15 s, and the air conditioner 10 s. The Moni panel always
reports `unknown`, so alarm commands come back `unconfirmed`, which is the honest
result. Volume, source, temperature, and the rest return `accepted` when Home
Assistant accepted the service. To undo the wide scope, remove `generic` from
the policy (the tools answer `generic_control_not_installed`) or return to v3
with `ha-lights-r4/deploy.py rollback`.
