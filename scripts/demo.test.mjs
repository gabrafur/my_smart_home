import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runSyntheticScenario } from "../demo/engine.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("demo covers presence, security, lighting, storage and health recovery without real I/O", () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "demo/scenario.json"), "utf8"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network access is forbidden in demo"); };
  try {
    const result = runSyntheticScenario(scenario);
    assert.equal(result.synthetic, true);
    assert.equal(result.network_access, false);
    assert.equal(result.device_access, false);
    assert.equal(result.credentials_used, false);
    assert.equal(result.metrics.events, 9);
    assert.equal(result.metrics.alerts, 3);
    assert.equal(result.metrics.recoveries, 3);
    assert.equal(result.final_state.presence.resident_primary, "home");
    assert.equal(result.final_state.security_panel, "disarm-requested");
    assert.equal(result.final_state.exterior_light, "off");
    assert.deepEqual(result.active_alerts, []);
    assert.ok(result.timeline.flatMap((entry) => entry.actions).every((entry) => entry.simulated && !entry.dispatched));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("demo implementation has no network, process, MQTT or device-control imports", () => {
  for (const relative of ["demo/engine.mjs", "scripts/demo.mjs"]) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.doesNotMatch(source, /node:(?:http|https|net|tls|dgram|child_process)|from ["']mqtt["']/);
    assert.doesNotMatch(source, /docker|homeassistant\/api|zigbee2mqtt\//i);
  }
});

test("demo fails closed for an unsupported event", () => {
  assert.throws(() => runSyntheticScenario({
    schema_version: 1,
    synthetic: true,
    initial_state: {},
    events: [{ step: 1, type: "real.command" }],
  }), /unsupported synthetic event/);
});
