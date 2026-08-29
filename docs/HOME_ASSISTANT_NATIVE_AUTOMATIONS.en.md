# Home Assistant native automation boundary

[Português (primary)](AUTOMACOES_NATIVAS_HOME_ASSISTANT.md) · [English](HOME_ASSISTANT_NATIVE_AUTOMATIONS.en.md)

Node-RED owns normal residential automation and orchestration. Home Assistant
keeps only five automations that belong to the platform boundary or provide a
protection layer independent from Node-RED.

| ID | Responsibility | Why it remains native |
| --- | --- | --- |
| `1783799940000` | translate `samsungtv.turn_on` into Wake-on-LAN | the Samsung integration emits the trigger inside Home Assistant and the MAC remains in `secrets.yaml` |
| `raspberry_pi_health_problem_notification` | notify when a derived health sensor enters an alert state | preserves observability while Node-RED or its websocket is unavailable |
| `raspberry_pi_health_recovery_notification` | close the alert and report recovery | shares the same sensors, notification IDs, and queue semantics as the failure automation |
| `raspberry_pi_home_assistant_started` | record that Home Assistant started | the lifecycle event belongs to the process that has just started and confirms its own recovery |
| `portao_garagem_rele_preso_em_on` | open the contact when the relay stays closed for 5 seconds | this independent watchdog only emits `OFF`; moving it into the runtime that produces pulses would weaken defense in depth |

These exceptions do not allow new native automations merely for convenience. A
new entry must demonstrate a Home Assistant lifecycle/internal-API dependency
or a real safety benefit from remaining independent of Node-RED. The
`homeassistant/tests/test_native_automation_boundary.py` test pins the
inventory and critical invariants.

## Rollback and validation

The five remaining automations are not duplicated. To roll back the garage
pulse migration, restore the Home Assistant cooldown automation and remove the
equivalent Node-RED input in one cutover; both paths must never remain able to
execute the same action.

Validate the boundary with:

```bash
python3 -m unittest homeassistant.tests.test_native_automation_boundary
node nodered/tools/validate-flows.mjs
```
