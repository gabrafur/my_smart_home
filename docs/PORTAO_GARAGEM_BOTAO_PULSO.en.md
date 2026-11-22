# Garage gate — single pulse in Node-RED

[Português (principal)](PORTAO_GARAGEM_BOTAO_PULSO.md) · [English](PORTAO_GARAGEM_BOTAO_PULSO.en.md)

Complements [`PORTAO_GARAGEM_RELE_LOCAL.md`](PORTAO_GARAGEM_RELE_LOCAL.md)
(Portuguese). Node-RED is the only controller of the physical pulse; Home
Assistant keeps only the dashboard button entity and an independent guard for
a stuck relay.

## Physical contract

`switch.rele_acionador_portao` is a dry contact on the gate controller's
push-button input. Every `ON` is a real physical action — open, close, stop, or
reverse. There is no position sensor; the relay state represents only the
contact. That is why the relay appears on no dashboard, is hidden in the
registry, and is not exposed to Assist ([`DASHBOARDS.md`](DASHBOARDS.md));
only the flow pulses it.

Rules:

- an accepted request produces exactly `ON → 700 ms → OFF`;
- `ON` is never retried;
- the cooldown starts before `ON` is published;
- a relay whose last reported MQTT state is still `ON` receives only `OFF`; a
  new `ON` is refused;
- the expected final state is always `OFF`.

The `TS0001` does not honour `on_time`/`onWithTimedOff`, so the pulse is made
in software with two plain commands. The `change` node `Aplicar largura da
política` gives `msg.delay` to the `delay` node; there is no second pulse width
hidden in JavaScript.

## Inputs

Both inputs converge on `Adaptar envelope do pedido`, go through the `switch`
`Ação é single, probe ou inválida?`, load the visual policy, and are evaluated
without effects in `Avaliar tempos e estado (sem efeitos)`:

| Source | Path |
|---|---|
| Physical Zigbee button | MQTT `action=single` → Node-RED |
| `button.acionar_portao_da_garagem` | local event `portao_garagem_pulso_solicitado` → Node-RED |

The Home Assistant template button only emits the event. The former
`script.portao_garagem_pulso`, its timestamp helpers, and the automation that
synchronised the cooldown were removed; there are no longer two competing
controllers.

## Visual policy, timing, and dedupe

The group `0. Política visual — edite os valores` is the single source of the
four parameters. Each `inject` shows name, unit, and default:

- pulse width: **700 ms**;
- dedupe of the same Zigbee press: **900 ms**;
- cooldown between accepted pulses: **1,000 ms**, counted from the start of
  the pulse;
- MQTT command/state coalescing: **500 ms**; the observer updates the same
  timestamp without producing a second pulse.

The validator accepts only integers within the limits shown on the canvas. It
also requires `pulse < cooldown` and `coalescing <= dedupe <= cooldown`. An
invalid value raises an observable error and does not replace the last valid
persisted policy.

The window leaves 300 ms between the expected `OFF` and the next acceptance.
The normaliser writes `portao_garagem_last_pulse_ms` before `ON`, closing the
race between the physical button and the dashboard button.

## Protections

1. Payloads other than `single` go to a diagnostic terminal with no effects.
2. Retransmissions within 900 ms are dropped.
3. Any new request within 1,000 ms is dropped.
4. If the state topic reported `ON`, the flow sends only `OFF`, raises a
   persistent alert, and does not move the gate again.
5. The command and state topics also observe external pulses and arm the same
   cooldown.
6. The `portao_garagem_rele_preso_em_on` automation stays in Home Assistant as
   an independent guard: after 5 s in `ON` it sends only `OFF` and alerts. It
   covers a Node-RED outage during the 700 ms delay.
7. There is no startup trigger and no retained MQTT command message.

The block `Decisão: pulso, OFF seguro ou bloqueio?` makes the three outcomes
visible. After it, independent gates separate production from `test_mode`.
Only production can reach MQTT, the Logbook, or a notification. Node-RED
records the accepted pulse in the Logbook with the source, width, and cooldown
taken from the policy.

Test state uses `garage_gate_test_state_v1`, separate from production. The
canonical production state uses `garage_gate_state_v1`. During the migration,
legacy timestamps are still read and mirrored to preserve restart and rollback
without opening a second implementation of the rule.

The relay must stay hidden in the entity registry and out of voice assistants.
Those options live in the private `.storage` and are not restored by a clone.
An administrator can still call `switch.turn_on` directly; the Node-RED observer
arms the cooldown for that pulse and the 5 s automation limits the contact
time, but hiding the entity is not an ACL.

## Source and validation

The canonical generator is `nodered/tools/configure-garage-gate-flow.mjs`. To
regenerate into an alternative file:

```bash
npm --prefix nodered run flows:update-garage-gate -- /tmp/flows.json
```

The tab declares `manual_full_dry_run`. The required visual sequence is: reset,
accepted pulse, duplicate at 500 ms, cooldown at 950 ms, limit at 1,000 ms, and
a synthetic relay already on. Every path reuses the production adaptation,
policy, decision, and gates, and ends at `TESTE FINAL: nenhum efeito enviado`
with `simulated: true` and `dispatched: false`. The automated replay is:

```bash
node nodered/tools/test-garage-gate-flow.mjs
node nodered/tools/test-garage-gate-dashboard-event.mjs
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render -- garagem
```

The replays cover both inputs, valid and invalid policy, the 999/1,000 ms
boundary, dedupe, refusal with an `ON` state, migration of the persisted state,
observed-state updates, MQTT `ON`/`OFF` payloads, and the dry-run topology.
They do not publish to the broker and never move the gate.

## Deploy

Changing `flows.json` does not deploy automatically. After validation and
canvas inspection, restart or deploy Node-RED through the normal operating
procedure. Reload the Home Assistant package so the button starts emitting the
local event.

Do not validate with an inject wired to the real path. Any physical test must
be deliberate, with the area clear, and it moves the gate.

## Rollback

The Tuya RF scene and `script.portao_garagem_acionar` remain only as a legacy
fallback. Re-enabling that path is a manual decision; never wire both
implementations to the same button at the same time.
