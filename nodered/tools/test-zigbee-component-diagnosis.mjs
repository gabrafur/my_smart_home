#!/usr/bin/env node
// 24 h power-versus-signal diagnosis of Zigbee modules. No MQTT or HA effects.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
assert.deepEqual(byId.get("zigbee_component_state_mutate").wires, [["zigbee_component_diagnose"]]);
assert.deepEqual(byId.get("zigbee_component_diagnose").wires, [["zigbee_component_effect_out", "zigbee_path_offline_out"]]);
assert.deepEqual(byId.get("zigbee_live_in").wires, [["zigbee_route_telemetry", "zigbee_announce_store"]]);

const T = Date.UTC(2026, 10, 24, 5);
const MIN = 60000;
function harness(test = false) {
  const stores = { default: new Map(), persistent: new Map() };
  const flow = {
    get: (key, store = "default") => stores[store].get(key),
    set: (key, value, store = "default") => { stores[store].set(key, structuredClone(value)); },
  };
  const run = (id, msg) => {
    const out = vm.runInNewContext(`(function(){${byId.get(id).func}\n})()`, { msg, flow, Date, Number, Array, Object, JSON, Buffer, Math, String });
    return out === null || out === undefined ? out : JSON.parse(JSON.stringify(out));
  };
  const step = (action, minutes) => run("zigbee_component_diagnose", {
    _zigbee_test: test, zigbee_component: "modulo", zigbee_component_action: action,
    zigbee_now: T + minutes * MIN, zigbee_now_iso: new Date(T + minutes * MIN).toISOString(),
  });
  const announce = (minutes, extra = {}) => run("zigbee_announce_store", {
    _zigbee_test: test, topic: "zigbee2mqtt/bridge/event", monitor_now: T + minutes * MIN,
    payload: { type: "device_announce", data: { friendly_name: "modulo" } }, ...extra,
  });
  return { stores, run, step, announce };
}

// Incident of 24/11/2026: repeated returns without a reboot mean lost signal.
const signal = harness();
assert.equal(signal.step("open", 0).zigbee_component_diagnosis.code, "indefinido");
assert.equal(signal.step("recover", 30).zigbee_component_diagnosis.code, "indefinido", "one silent return is not enough");
signal.step("open", 40);
const twice = signal.step("recover", 70);
assert.deepEqual(twice.zigbee_component_diagnosis, { code: "sinal", outages_24h: 2, silent: 2, rebooted: 0 });
const third = signal.step("open", 80);
assert.match(third.zigbee_component_diagnosis_text, /3 quedas em 24 h e 2 retornos sem o módulo reiniciar/);
assert.equal(signal.step("touch", 81).zigbee_component_diagnosis.outages_24h, 3, "touch never adds an outage");
const notice = signal.run("zigbee_component_notification_build", {
  ...third, zigbee_component_key: "k", zigbee_component_event: "down", policy: { reminder_interval_h: 24 },
});
assert.match(notice.notification.message, /Verifique alimentação, alcance, bateria e a malha Zigbee\. Diagnóstico: 3 quedas/);
assert.equal(signal.step("baseline", 24 * 60 + 200).zigbee_component_diagnosis.outages_24h, 0, "evidence expires after 24 h");

// A reboot announced during the outage means power came back.
const power = harness();
power.step("open", 0);
power.announce(20);
assert.equal(power.step("recover", 22).zigbee_component_diagnosis.code, "energia");
power.step("open", 30);
assert.equal(power.step("recover", 50).zigbee_component_diagnosis.code, "misto", "an old announcement proves nothing new");

// Only live announcements count; test evidence never reaches production.
const ignored = harness();
ignored.step("open", 0);
ignored.announce(5, { retain: true });
ignored.announce(6, { topic: "zigbee2mqtt/modulo" });
ignored.announce(7, { payload: { type: "device_joined", data: { friendly_name: "modulo" } } });
assert.equal(ignored.step("recover", 10).zigbee_component_diagnosis.rebooted, 0);
const synthetic = harness(true);
synthetic.step("open", 0);
synthetic.announce(1);
assert.equal(synthetic.step("recover", 2).zigbee_component_diagnosis.code, "energia");
assert.equal(synthetic.stores.persistent.size, 0);
console.log("Zigbee component diagnosis tests passed.");
