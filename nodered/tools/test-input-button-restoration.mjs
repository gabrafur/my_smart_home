import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { installInputButtonRestorationGuards } from "./install-input-button-restoration-guards.mjs";

const require = createRequire(import.meta.url);
const { default: EventsStateController } = require(
  "../node_modules/node-red-contrib-home-assistant-websocket/dist/nodes/events-state/EventsStateController.js",
);
const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url)));
const generated = installInputButtonRestorationGuards(structuredClone(flows));
assert.deepEqual(generated, flows);
assert.deepEqual(installInputButtonRestorationGuards(generated), flows);
const buttons = flows.filter((node) => node.type === "server-state-changed" &&
  node.entities?.entity?.some((id) => id.startsWith("input_button.")));
assert.equal(buttons.length, 5, "Review new manual button sources for restoration safety");

for (const config of buttons) {
  assert.equal(config.outputInitially, false, config.id);
  assert.equal(config.ignorePrevStateNull, true, config.id);
  // A never-pressed helper exists with state unknown. Its first real press
  // must still pass; a restored entity has no old_state and must never pass.
  assert.equal(config.ignorePrevStateUnknown, false, config.id);
  const emitted = [];
  const homeAssistant = { isHomeAssistantRunning: true };
  const controller = new EventsStateController({
    node: { config, on() {}, debug() {} }, homeAssistant,
    comparatorService: { getComparatorResult: async () => true },
    typedInputService: { getValue: async () => 0 },
    transformState: { transform: (_, value) => value },
  });
  // Exercise the installed native event filter. Stop at its output boundary;
  // the existing tab dry-run tests cover the downstream decisions and effects.
  controller.output = async (event) => emitted.push(event);
  const entity_id = config.entities.entity[0];
  const timestamp = "2026-01-01T12:00:00+00:00";
  const event = (old_state, state, id = entity_id) => ({ entity_id: id,
    event: { entity_id: id, old_state, new_state: { state } },
  });
  for (let restart = 0; restart < 3; restart++) {
    await controller.onHaEventsStateChanged(event(null, timestamp));
  }
  assert.equal(emitted.length, 0, `${config.id}: startup/reconnection must not press buttons`);
  await controller.onHaEventsStateChanged(event({ state: "unknown" }, timestamp));
  assert.equal(emitted.length, 1, `${config.id}: first explicit press must work`);
  await controller.onHaEventsStateChanged(event({ state: timestamp }, timestamp));
  await controller.onHaEventsStateChanged(event({ state: "unknown" }, timestamp, "input_button.unrelated"));
  homeAssistant.isHomeAssistantRunning = false;
  await controller.onHaEventsStateChanged(event({ state: "unknown" }, timestamp));
  assert.equal(emitted.length, 1, `${config.id}: duplicate/unrelated/disconnected events must not dispatch`);
}
console.log("Native input_button restoration and first-press regressions passed (5 sources).");
