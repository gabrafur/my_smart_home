import assert from "node:assert/strict";
import test from "node:test";

import { validateBindings, validateFlowBindingCalls } from "./public-bindings-check.mjs";

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

test("preserves named Home Assistant zones on public device trackers", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        entities: {
          "device_tracker.vehicle_primary": {
            target_entity_id: "device_tracker.example_vehicle_primary",
            state_mode: "home_away",
          },
        },
      },
    },
  };
  const rules = validateBindings(document).map((item) => item.rule);
  assert.ok(rules.includes("location-state-mode"));

  document.roles.vehicle_primary.entities["device_tracker.vehicle_primary"].state_mode = "passthrough";
  assert.deepEqual(validateBindings(document), []);
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

test("accepts a fixed-payload MQTT topic as a string", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      exterior_light: { mqtt_topics: ["example/topic"] },
    },
  };
  assert.deepEqual(validateBindings(document), []);
});

test("requires every Node-RED binding call to exist in the contract", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      mobile_primary: {
        services: {
          notify: { target_service: "notify.example_mobile_primary" },
        },
      },
    },
  };
  assert.deepEqual(validateFlowBindingCalls(document, [{
    id: "notify-ok",
    action: "public_bindings.call",
    data: '{"role":"mobile_primary","action":"notify"}',
  }]), []);
  assert.equal(validateFlowBindingCalls(document, [{
    id: "notify-missing",
    action: "public_bindings.call",
    data: '{"role":"mobile_primary","action":"missing"}',
  }])[0]?.rule, "consumer-service");
});

test("resolves a service through an entity binding in the same role", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        entities: {
          "switch.vehicle_primary_climate": {
            target_entity_id: "switch.example_vehicle_climate",
          },
        },
        services: {
          climate_on: {
            target_service: "switch.turn_on",
            target_public_entity_id: "switch.vehicle_primary_climate",
          },
        },
      },
    },
  };
  assert.deepEqual(validateBindings(document), []);
});

test("requires modern mobile notification entities", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      mobile_primary: {
        services: {
          legacy: { target_service: "notify.mobile_app_example" },
          missing_target: { target_service: "notify.send_message" },
        },
      },
    },
  };
  const rules = validateBindings(document).map((item) => item.rule);
  assert.ok(rules.includes("legacy-mobile-notify-service"));
  assert.ok(rules.includes("notify-target-entity"));

  document.roles.mobile_primary.services = {
    notify_3: {
      target_service: "notify.send_message",
      target_entity_id: "notify.example_mobile_primary",
    },
  };
  assert.deepEqual(validateBindings(document), []);
});

test("rejects a service pointing to a missing public entity binding", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        services: {
          climate_on: {
            target_service: "switch.turn_on",
            target_public_entity_id: "switch.vehicle_primary_climate",
          },
        },
      },
    },
  };
  const rules = validateBindings(document).map((item) => item.rule);
  assert.ok(rules.includes("service-target-public-binding"));
});
