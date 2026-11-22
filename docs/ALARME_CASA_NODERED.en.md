# House alarm (Node-RED)

[Português (principal)](ALARME_CASA_NODERED.md) · [English](ALARME_CASA_NODERED.en.md)

Flow `alarme_casa` (`nodered/flows.json`, tab `alarm_house_tab`). It is the
canonical place that decides, records, and executes arming/disarming through
the logical `security_panel` binding. Policy, decisions, retries, test gates,
and notices are visible on the canvas. It exchanges no events or commands with
the `iluminacao_externa` flow.

## Inputs

- The DuloNode device "Alarme Casa" receives Alexa PowerController ON/OFF
  commands. The Dulo hub lives on the `integracoes_compartilhadas` tab and
  reaches this flow through `alarm_dulo_hub_link_out` -> `alarm_dulo_hub_link_in`.
- The `node_red_moni_mobile_arm` event requests `arm` or `disarm`; a missing
  `action` still means `arm` for compatibility.
- The CarPlay script keeps the same identifier, but now publishes that event
  instead of bypassing the policy with a direct alarm call.
- `alarm_arrival_disarm_command_in` receives only requests confirmed through
  the actionable notification of the `alarme_desarme_chegada` flow.
- The `TESTE 1` to `TESTE 4` controls use isolated synthetic state and end at
  the dry-run terminal. No manual inject is wired to a real service.

## Visual policy

The blue group `0. Política visual — edite os valores` holds the only
definition of the parameters below. Each control states its value and unit in
its name; the validator keeps the last valid persisted configuration when it
receives an out-of-range value.

- retry interval: **10 s**, integer from 1 to 300 s;
- warning cadence: **5 attempts**, integer from 1 to 100;
- attempt limit: **0 (no limit)**, from 0 to 1,000.

The default `0` keeps the previous unlimited retry. Changing it to a positive
value is an explicit, visible operational change.

## Arming and disarming

Arm and disarm commands use the allow-listed `arm_away` and `disarm` actions of
the `security_panel` role through `public_bindings.call`.

- Every input converges on the visual decision `Decisão canônica: armar ou
  desarmar?`. The new state lives in `alarm_house_state_v1`; `flow.alarm_desired`
  is still updated as a reversible bridge to the previous version.
- Moni Mobile integration failures go through the visual blocks `Retry
  permitido pelo limite?`, `Avisar na 1ª / a cada N / no limite?`, and `A
  intenção ainda é a mesma?`.
- A stale retry is cancelled when an opposite intention arrives during the
  wait. Restarting Node-RED never replays a security action automatically: the
  policy and the last intention are recovered, but an interrupted command needs
  a new request.
- The failure notice fires on the first failure and then at the visual
  cadence. The effect uses the logical `mobile_primary` role.
- After an accepted arm, `Atualizar estado Moni Mobile` requests an entity
  refresh before the success notice.

These retries belong only to communication with the Moni Mobile panel. Zigbee
network errors on the `iluminacao_externa` tab never trigger a retry.

## Safe test and rollback

Run on the canvas: `TESTE 1: reset`, `TESTE 2: pedir armar`, `TESTE 3: falha ao
armar`, and `TESTE 4: pedir desarmar`. Wait 10 s after the failure to watch the
retry, or request disarm before then to validate the cancellation. The
synthetic inputs go through adaptation, state, decisions, delay, and the final
gates; at the effect boundary the log contains `ALARM_HOUSE_DRY_RUN`,
`simulated: true`, and `dispatched: false`.

To roll back, restore `nodered/flows.json`, the generator, and this package
from Git and restart only Node-RED. The entity, binding, script IDs, arrival
links, and service IDs were preserved.

## Relevant history

- 2026-08-11: control moved out of the former `iluminacao_externa_alarme` tab
  into `alarme_casa`. The Dulo hub became shared through links and each tab got
  its own notice node.
- 2026-08-11: `DuloNodeHub` moved to the `integracoes_compartilhadas` tab, so
  any flow can consume it through `link out`/`link in` pairs without coupling
  to a specific automation.
- 2026-08-02: guards on `flow.alarm_desired` started preventing an old retry
  from reverting the user's latest command.
- 2026-07-09: transient `unknown`/`unavailable` states stopped counting as a
  real alarm change; arm retries and periodic notices were added.
- 2026-07-10: the same protected retry was applied to disarming.
- 2026-08-19: removed the observer and links that turned exterior lighting off
  when arming. Alarm and lighting became independent in both directions.

## Tests and maintenance

```bash
cd nodered
npm run flows:validate
npm run flows:test-alarm-house
npm run flows:test-alarm-arrival
```

To regenerate the visual implementation idempotently, use
`npm run flows:update-alarm-house`. The legacy command
`npm run flows:split-alarm-house` points to the same generator. Then run the
layout/render validators and restart only Node-RED, safely.
