import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "public-bindings-settings-"));
const binding = {
  schema_version: 1,
  roles: {
    resident_primary: {
      source_alias: "example_primary",
    },
    resident_secondary: {
      source_alias: "example_secondary",
    },
    garage_gate: {
      topics: {
        relay_state: "zigbee2mqtt/example_garage_gate_relay/state",
        action: "zigbee2mqtt/example_garage_gate_remote/action",
        command: "zigbee2mqtt/example_garage_gate_relay/set",
        state: "zigbee2mqtt/example_garage_gate_relay/state",
      },
    },
    exterior_light: {
      mqtt_topics: ["zigbee2mqtt/example_exterior_light/set"],
    },
  },
};

try {
  fs.writeFileSync(path.join(directory, "synthetic.json"), JSON.stringify(binding));
  process.env.PUBLIC_BINDINGS_DIR = directory;
  const require = createRequire(import.meta.url);
  const settings = require("../settings.js");
  assert.deepEqual(
    settings.functionGlobalContext.publicBindings.roles.garage_gate.topics,
    binding.roles.garage_gate.topics,
  );
  assert.deepEqual(
    settings.functionGlobalContext.publicBindings.roles.exterior_light.mqtt_topics,
    [{ topic: binding.roles.exterior_light.mqtt_topics[0] }],
  );
  assert.equal(
    settings.functionGlobalContext.publicBindings.roles.resident_primary.source_alias,
    binding.roles.resident_primary.source_alias,
  );
  assert.equal(
    settings.functionGlobalContext.publicBindings.roles.resident_secondary.source_alias,
    binding.roles.resident_secondary.source_alias,
  );
  for (const [environmentSuffix, bindingKey] of [
    ["RELAY_STATE", "relay_state"],
    ["ACTION", "action"],
    ["COMMAND", "command"],
    ["STATE", "state"],
  ]) {
    assert.equal(
      process.env[`BINDING_GARAGE_GATE_${environmentSuffix}_TOPIC`],
      binding.roles.garage_gate.topics[bindingKey],
    );
  }
  console.log("Node-RED public binding loader test passed.");
} finally {
  delete process.env.PUBLIC_BINDINGS_DIR;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("BINDING_GARAGE_GATE_")) delete process.env[key];
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
