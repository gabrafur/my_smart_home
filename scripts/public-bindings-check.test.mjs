import assert from "node:assert/strict";
import test from "node:test";

import { validateBindings } from "./public-bindings-check.mjs";

const roles = {
  resident_primary: {},
  resident_secondary: {},
  mobile_primary: {},
  mobile_secondary: {},
  vehicle_primary: {},
  garage_gate: {},
  exterior_light: {},
  security_panel: {},
};

test("accepts all public logical roles", () => {
  assert.deepEqual(validateBindings({ schema_version: 1, roles }), []);
});

test("rejects missing public roles", () => {
  const result = validateBindings({ schema_version: 1, roles: { resident_primary: {} } });
  assert.ok(result.some((item) => item.rule === "required-role"));
});

test("requires role-based public IDs and valid private targets", () => {
  const result = validateBindings({
    schema_version: 1,
    roles: {
      ...roles,
      resident_primary: {
        entities: {
          "person.example_invalid": { target_entity_id: "invalid" },
        },
      },
    },
  });
  assert.ok(result.some((item) => item.rule === "public-entity-id"));
  assert.ok(result.some((item) => item.rule === "target-entity-id"));
});

test("validates optional MQTT bindings without exposing their values", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      garage_gate: { topics: { command: "" } },
      exterior_light: { mqtt_topics: [{ topic: "example/topic", payload_on: "ON" }] },
    },
  };
  const rules = validateBindings(document).map((item) => item.rule);
  assert.ok(rules.includes("mqtt-topic"));
  assert.ok(rules.includes("mqtt-payload"));
});
