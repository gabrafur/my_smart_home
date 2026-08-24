import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatSyntheticSummary, runSyntheticScenario } from "../demo/engine.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("demo covers coordination, deduplication, stale rejection and restart recovery without real I/O", () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "demo/scenario.json"), "utf8"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network access is forbidden in demo"); };
  try {
    const result = runSyntheticScenario(scenario);
    assert.equal(result.synthetic, true);
    assert.equal(result.network_access, false);
    assert.equal(result.device_access, false);
    assert.equal(result.credentials_used, false);
    assert.equal(result.metrics.events, 12);
    assert.equal(result.metrics.events_applied, 10);
    assert.equal(result.metrics.alerts, 3);
    assert.equal(result.metrics.recoveries, 3);
    assert.equal(result.metrics.deduplicated, 1);
    assert.equal(result.metrics.stale_rejected, 1);
    assert.equal(result.metrics.restart_restores, 1);
    assert.equal(result.final_state.presence.resident_primary, "home");
    assert.equal(result.final_state.security_panel, "disarm-requested");
    assert.equal(result.final_state.exterior_light, "off");
    assert.equal(result.final_state.internet, "online");
    assert.deepEqual(result.active_alerts, []);
    assert.equal(result.timeline.find((entry) => entry.step === 5)?.outcome, "deduplicated");
    assert.equal(result.timeline.find((entry) => entry.step === 7)?.outcome, "restart_reloaded");
    assert.equal(result.timeline.find((entry) => entry.step === 9)?.outcome, "rejected_stale");
    assert.ok(result.timeline.flatMap((entry) => entry.actions).every((entry) => entry.simulated && !entry.dispatched));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("demo summary is concise, deterministic and matches the published example", () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "demo/scenario.json"), "utf8"));
  const summary = formatSyntheticSummary(runSyntheticScenario(scenario));
  assert.equal(summary.split("\n").length, 12);
  assert.match(summary, /deduplicated=1 \| stale_rejected=1 \| restart_restores=1/);
  assert.match(summary, /dispatched_actions=0/);
  for (const relative of ["docs/demo-output.md", "docs/demo-output.pt-BR.md"]) {
    const document = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    const published = document.match(/```text\n([\s\S]*?)\n```/)?.[1];
    assert.equal(published, summary, `${relative} must contain the current deterministic output`);
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
