#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import {
  imageChannelsForMode,
  replaceServiceImage,
  waitForHealthyService,
  servicesNeedingRecreate,
  validateComposeCandidate,
  recreateAndVerify,
} from "./docker-auto-update.mjs";
import { probeService, startupComplete, requireReadinessCoverage,
  mqttProbeScript, zigbeeProbeScript, nodeRedProbeScript } from "./container-readiness.mjs";
import {
  assessKiaRuntimeStates,
  candidateMetadataMatchesTarget,
  hacsInstallationMatches,
  preferFullCommit,
  runtimeUpdateMatchesTarget,
  selectKiaRuntimeEntities,
  statusLine,
  updateMatchesTarget,
} from "./kia-uvo-safe-update.mjs";

const healthyKiaRuntimeStates = [
  { entity_id: "sensor.vehicle_primary_fuel_level", state: "29" },
  {
    entity_id: "sensor.vehicle_primary_last_scanned_at",
    state: "2026-08-31T18:00:00Z",
  },
  {
    entity_id: "button.vehicle_primary_force_refresh",
    state: "2026-08-31T17:00:00Z",
  },
  {
    entity_id: "button.vehicle_primary_start_hazard_lights_and_horn",
    state: "unknown",
  },
  {
    entity_id: "sensor.garagem_vehicle_primary_recent_trip_info",
    state: "ready",
  },
  {
    entity_id: "sensor.garagem_vehicle_primary_remote_command_status",
    state: "idle",
  },
];

test("retry reconciles a pending digest even when Compose already has it", () => {
  const desired = [{ service: "homeassistant", image: "example/core@sha256:next" }];
  assert.deepEqual(servicesNeedingRecreate(desired, () => "next\n", () => "old\n"), ["homeassistant"]);
  assert.deepEqual(servicesNeedingRecreate(desired, () => "next\n", () => "next\n"), []);
  assert.throws(() => servicesNeedingRecreate(desired, () => "", () => "old"), /identity unavailable/);
  assert.throws(() => servicesNeedingRecreate(desired, () => "next", () => { throw new Error("inspect failed"); }), /inspect failed/);
});

test("validation failure restores only the updater's Compose candidate", () => {
  let content = "before";
  const plan = { before: "before", compose: "candidate" };
  const io = { read: () => content, write: (value) => { content = value; } };
  assert.throws(() => validateComposeCandidate(plan, { ...io, validate: () => {
    assert.equal(content, "candidate");
    throw new Error("dependency unavailable");
  } }), /dependency unavailable/);
  assert.equal(content, "before");
  assert.throws(() => validateComposeCandidate(plan, { ...io, validate: () => {
    content = "operator edit";
    throw new Error("validation failed");
  } }), /validation failed/);
  assert.equal(content, "operator edit");
  assert.throws(() => validateComposeCandidate(plan, { ...io, validate: () => assert.fail() }), /Compose changed/);
  content = "before";
  validateComposeCandidate(plan, { ...io, validate: () => {} });
  assert.equal(content, "candidate");
});

test("replaces an image even when comments precede it", () => {
  const compose = `services:
  first:
    image: example/first@sha256:old
  matter_server:
    # Operational comment that used to break the regex parser.
    # A second comment keeps this fixture representative.
    image: example/matter@sha256:old
    restart: always
  last:
    image: example/last@sha256:old
`;
  const result = replaceServiceImage(compose, "matter_server", "example/matter@sha256:new");
  assert.equal(result.current, "example/matter@sha256:old");
  assert.match(result.compose, /matter_server:[\s\S]*image: example\/matter@sha256:new/);
  assert.match(result.compose, /first:[\s\S]*image: example\/first@sha256:old/);
  assert.match(result.compose, /last:[\s\S]*image: example\/last@sha256:old/);
});

test("does not cross into the next service", () => {
  const compose = `services:
  build_only:
    build: .
  next:
    image: example/next:latest
`;
  assert.throws(
    () => replaceServiceImage(compose, "build_only", "example/build:new"),
    /Could not find image property/,
  );
});

test("keeps Home Assistant Core separate from all other container images", () => {
  assert.deepEqual(imageChannelsForMode("home-assistant-core").map((item) => item.service), ["homeassistant"]);
  const containers = imageChannelsForMode("containers").map((item) => item.service);
  assert.equal(containers.includes("homeassistant"), false);
  assert.deepEqual([...imageChannelsForMode("daily").map((item) => item.service)].sort(), [
    "appdaemon", "homeassistant", "matter_server", "mosquitto", "nodered", "portainer", "zigbee2mqtt",
  ]);
  assert.equal(imageChannelsForMode("ha-updates"), null);
});

test("recreates changed image services without touching dependencies", () => {
  const source = fs.readFileSync("scripts/docker-auto-update.mjs", "utf8");
  assert.match(
    source,
    /\["compose", "up", "-d", "--no-deps", \.\.\.changedServices\]/,
  );
});

test("waits for Home Assistant health before recording an update", async () => {
  const observed = ["running|starting", "running|starting", "running|healthy"];
  const pauses = [];
  const result = await waitForHealthyService("homeassistant", {
    inspect: () => observed.shift(),
    pause: async (milliseconds) => pauses.push(milliseconds),
    attempts: 4,
    intervalMs: 25,
  });

  assert.equal(result, "running|healthy");
  assert.deepEqual(pauses, [25, 25]);
});

test("rejects an unhealthy Home Assistant runtime", async () => {
  await assert.rejects(
    waitForHealthyService("homeassistant", {
      inspect: () => "running|unhealthy",
      pause: async () => {},
      attempts: 2,
    }),
    /failed while waiting for health/,
  );
});

test("running is insufficient, and even Docker healthy requires the service probe", async () => {
  for (const service of ["mosquitto", "nodered", "zigbee2mqtt"]) {
    for (const state of ["running|none", "running|healthy"]) {
      let calls = 0;
      await waitForHealthyService(service, { inspect: () => state,
        probe: () => ++calls === 2, pause: async () => {}, attempts: 2 });
      assert.equal(calls, 2);
      await assert.rejects(waitForHealthyService(service, { inspect: () => state,
        probe: () => false, pause: async () => {}, attempts: 2 }), /did not become healthy/);
    }
  }
});

test("readiness rejects missing, exited, restarting and unsupported containers", async () => {
  for (const state of ["exited|none", "dead|none", "restarting|none", "running|unhealthy"]) {
    await assert.rejects(waitForHealthyService("mosquitto", { inspect: () => state,
      probe: () => assert.fail("must not probe an unusable container"), pause: async () => {}, attempts: 2 }));
  }
  await assert.rejects(waitForHealthyService("mosquitto", { inspect: () => { throw Error("missing"); },
    pause: async () => {}, attempts: 2 }), /unavailable/);
  await assert.rejects(waitForHealthyService("unknown", { inspect: () => "running|none",
    attempts: 1 }), /no readiness probe/);
  assert.throws(() => requireReadinessCoverage(["portainer"], () => false), /before recreation/);
  requireReadinessCoverage(["mosquitto", "nodered", "zigbee2mqtt"], () => assert.fail());
  requireReadinessCoverage(["homeassistant"], () => true);
});

test("probes use bounded private subprocesses and current-start logs without publishing", () => {
  for (const service of ["mosquitto", "nodered", "zigbee2mqtt"]) {
    const calls = [];
    const execute = (command, args, options) => {
      calls.push(args);
      assert.equal(command, "docker");
      assert.equal(options.timeout, 10000);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      if (args[0] === "inspect") return "2026-10-13T00:00:00Z\n";
      if (args[0] === "logs") {
        assert.equal(args[2], "2026-10-13T00:00:00Z");
        return service === "nodered" ? "Started flows" : "Zigbee2MQTT started!";
      }
      assert.equal(args[0], "exec");
      assert.doesNotMatch(args.at(-1), /\.publish\(/);
      return "";
    };
    assert.equal(probeService(service, { execute }), true);
    assert.equal(calls.at(-1)[1], service === "mosquitto" ? "nodered" : service);
    assert.equal(probeService(service, { execute: () => { throw Error("private details"); } }), false);
  }
  assert.equal(startupComplete("nodered", "Started flows\nStopped flows"), false);
  assert.equal(startupComplete("nodered", "Stopped flows\nStarted flows"), true);
  assert.equal(startupComplete("zigbee2mqtt", "Zigbee2MQTT started!\nStopping Zigbee2MQTT"), false);
  assert.equal(startupComplete("zigbee2mqtt", "HTTP listening"), false);
});

test("all updated services must pass before clearing recovery; failures preserve the gate", async () => {
  for (const failure of [null, "recreate", "mosquitto", "nodered", "zigbee2mqtt"]) {
    const events = [];
    const task = recreateAndVerify(["mosquitto", "nodered", "zigbee2mqtt"], {
      record: state => { events.push(state.status); assert.equal(state.automatic_downgrade, false); },
      recreate: () => { events.push("up"); if (failure === "recreate") throw Error("partial up"); },
      wait: service => { events.push(service); if (failure === service) throw Error("not ready"); },
      clear: () => events.push("clear"), report: () => {},
    });
    if (failure) {
      await assert.rejects(task);
      assert.equal(events.at(-1), "failed");
      assert.equal(events.includes("clear"), false);
    } else {
      await task;
      assert.deepEqual(events, ["pending", "up", "mosquitto", "nodered", "zigbee2mqtt", "clear"]);
    }
    assert.deepEqual(events.slice(0, 2), ["pending", "up"]);
  }
});

test("MQTT probe authenticates to the local broker without publishing or exposing credentials", () => {
  const secret = crypto.randomBytes(16).toString("hex");
  const cipher = crypto.createCipheriv("aes-256-ctr", crypto.createHash("sha256").update(secret).digest(), Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({local: {user: "fixture", password: "synthetic"}})), cipher.final()]);
  const exits = [], client = new EventEmitter();
  client.end = (_force, _options, done) => done();
  vm.runInNewContext(mqttProbeScript, { Buffer, setTimeout: () => 1, clearTimeout: () => {},
    process: { env: {NODE_RED_CREDENTIAL_SECRET: secret}, exit: code => exits.push(code) },
    require: name => ({ crypto, fs: {readFileSync: file => file.includes("flows_cred")
      ? JSON.stringify({$: "00".repeat(16) + encrypted.toString("base64")})
      : JSON.stringify([{id: "local", type: "mqtt-broker", broker: "mosquitto", port: 1883}])},
    mqtt: {connect: options => { assert.equal(options.host, "mosquitto"); assert.equal(options.password, "synthetic"); return client; }} }[name]),
  });
  assert.deepEqual(exits, []);
  client.emit("connect");
  assert.deepEqual(exits, [0]);
});

test("Zigbee probe rejects offline and unrelated retained state, then accepts online", () => {
  const exits = [], client = new EventEmitter();
  let topic;
  client.subscribe = (value, _options, done) => { topic = value; done(null, [{qos: 0}]); };
  client.end = (_force, _options, done) => done();
  vm.runInNewContext(zigbeeProbeScript, { setTimeout: () => 1, clearTimeout: () => {},
    process: {env: {}, exit: code => exits.push(code)},
    require: name => ({ fs: {readFileSync: () => "fixture"},
      "js-yaml": {load: () => ({mqtt: {server: "mqtt://fixture", base_topic: "fixture"}})},
      mqtt: {connect: () => client} }[name]),
  });
  client.emit("connect");
  assert.equal(topic, "fixture/bridge/state");
  client.emit("message", "other/bridge/state", Buffer.from('"online"'));
  client.emit("message", topic, Buffer.from('{"state":"offline"}'));
  assert.deepEqual(exits, []);
  client.emit("message", topic, Buffer.from('{"state":"online"}'));
  assert.deepEqual(exits, [0]);
});

test("Node-RED probe rejects authentication errors and unavailable HTTP runtime", () => {
  for (const status of [200, 401, 503]) {
    const exits = [], response = new EventEmitter(), request = new EventEmitter();
    response.statusCode = status; response.resume = () => {};
    request.setTimeout = () => {};
    vm.runInNewContext(nodeRedProbeScript, { process: {exit: code => exits.push(code)},
      require: () => ({get: (url, done) => { assert.equal(url, "http://127.0.0.1:1880/auth/login"); done(response); return request; }}) });
    response.emit("end");
    assert.deepEqual(exits, [status === 200 ? 0 : 1]);
  }
});

test("recognizes an already installed Kia UVO target", () => {
  const entity = {
    attributes: { installed_version: "v3.10.1" },
  };
  const hacs = { version_installed: "v3.10.1" };
  assert.equal(updateMatchesTarget(entity, hacs, "3.10.1"), true);
  assert.equal(updateMatchesTarget(entity, hacs, "v3.10.2"), false);
  assert.equal(
    updateMatchesTarget(entity, { version_installed: "v3.9.0" }, "v3.10.1"),
    false,
  );
});

test("requires the live HACS update entity before replacing runtime", () => {
  const states = [{
    entity_id: "update.kia_uvo_hyundai_bluelink_update",
    attributes: { installed_version: "v3.12.0" },
  }];
  assert.equal(hacsInstallationMatches(
    states,
    "update.kia_uvo_hyundai_bluelink_update",
    { version_installed: "v3.12.0" },
    "v3.12.0",
  ), true);
  assert.equal(hacsInstallationMatches(
    states,
    "update.kia_uvo_hyundai_bluelink_update",
    { version_installed: "v3.11.0" },
    "v3.12.0",
  ), false);
  assert.equal(hacsInstallationMatches(
    states,
    "update.kia_uvo_hyundai_bluelink_update",
    { version_installed: "v3.11.0" },
    "v3.12.0",
    "v3.12.0",
  ), true);
  assert.equal(runtimeUpdateMatchesTarget(states[0], "v3.12.0"), true);
  assert.equal(runtimeUpdateMatchesTarget(states[0], "v3.11.0"), false);
});

test("persists refreshed Kia credentials through the coordinator config entry", () => {
  const coordinator = fs.readFileSync(
    "homeassistant/custom_components/kia_uvo/coordinator.py",
    "utf8",
  );
  assert.match(
    coordinator,
    /new_token = self\.vehicle_manager\.token\.to_dict\(\)\n        config_entry = self\.config_entry/,
  );
  assert.match(
    coordinator,
    /self\.hass\.config_entries\.async_update_entry\(config_entry, data=updated_data\)/,
  );
});

test("requires a fresh healthy cache probe before accepting Kia runtime", () => {
  assert.equal(assessKiaRuntimeStates(healthyKiaRuntimeStates).healthy, true);
  assert.equal(
    assessKiaRuntimeStates(
      healthyKiaRuntimeStates,
      "2026-08-31T17:59:59Z",
    ).healthy,
    true,
  );
  assert.equal(
    assessKiaRuntimeStates(
      healthyKiaRuntimeStates,
      "2026-08-31T18:00:00Z",
    ).reason,
    "cache_probe_not_observed",
  );
  assert.equal(
    assessKiaRuntimeStates(
      healthyKiaRuntimeStates.map((state) =>
        state.entity_id === "sensor.vehicle_primary_fuel_level"
          ? { ...state, state: "unavailable" }
          : state
      ),
    ).reason,
    "entities_unavailable",
  );
  assert.equal(
    assessKiaRuntimeStates(
      healthyKiaRuntimeStates.map((state) =>
        state.entity_id === "sensor.garagem_vehicle_primary_recent_trip_info"
          ? { ...state, state: "unavailable" }
          : state
      ),
    ).reason,
    "entities_unavailable",
  );
});

test("selects the actual Kia UVO entities from the configured integration", () => {
  const runtime = selectKiaRuntimeEntities([
    "sensor.creta_fuel_level",
    "sensor.creta_last_scanned_at",
    "button.creta_force_refresh",
    "button.creta_start_hazard_lights_and_horn",
    "sensor.garagem_creta_recent_trip_info",
    "sensor.garagem_creta_remote_command_status",
  ]);
  assert.deepEqual(runtime.requiredEntities, [
    "sensor.creta_fuel_level",
    "sensor.creta_last_scanned_at",
    "button.creta_force_refresh",
    "button.creta_start_hazard_lights_and_horn",
    "sensor.garagem_creta_recent_trip_info",
    "sensor.garagem_creta_remote_command_status",
  ]);
  assert.equal(runtime.fuelEntity, "sensor.creta_fuel_level");
  assert.equal(runtime.scannedEntity, "sensor.creta_last_scanned_at");
  assert.throws(() => selectKiaRuntimeEntities([
    "sensor.creta_fuel_level",
  ]), /missing or ambiguous/);
});

test("preserves the full upstream commit when HACS reports a prefix", () => {
  const full = "2c602560746318fd001db8fe52347e9398f181ed";
  assert.equal(preferFullCommit(full, "2c60256"), full);
  assert.equal(preferFullCommit("2c60256", full), full);
});

test("binds a Codex candidate to a semantic target and full upstream commit", () => {
  assert.equal(candidateMetadataMatchesTarget({
    base_version: "v3.11.0",
    base_commit: "04b92423e779f26f169858dfa5a14f7750731759",
  }, "3.11.0"), true);
  assert.equal(candidateMetadataMatchesTarget({
    base_version: "v3.11.0",
    base_commit: "04b9242",
  }, "v3.11.0"), false);
  assert.equal(candidateMetadataMatchesTarget({
    base_version: "v3.12.0",
    base_commit: "04b92423e779f26f169858dfa5a14f7750731759",
  }, "v3.11.0"), false);
});

test("publishes only sanitized Kia UVO status fields to Node-RED", () => {
  assert.equal(statusLine({
    state: "conflict",
    installed_version: "3.10.1",
    latest_version: "v3.11.0",
    patch_state: "conflict",
    conflicts: ["private detail", "another detail"],
    checked_at: "2026-08-31T13:30:04.072Z",
    message: "must not leave the host",
  }), "kia-uvo-update status=conflict installed_version=3.10.1 latest_version=v3.11.0 patch_state=conflict conflicts=2 checked_at=2026-08-31T13:30:04.072Z");
  assert.equal(statusLine(null), "kia-uvo-update status=unavailable");
});
