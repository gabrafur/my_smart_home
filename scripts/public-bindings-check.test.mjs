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

test("validates an optional private display name for a role", () => {
  const valid = {
    ...roles,
    resident_primary: { display_name: "Example Primary Resident" },
  };
  assert.deepEqual(validateBindings({ schema_version: 1, roles: valid }), []);

  const invalid = {
    ...roles,
    resident_primary: { display_name: "" },
  };
  assert.ok(validateBindings({ schema_version: 1, roles: invalid })
    .some((item) => item.rule === "role-display-name"));
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
            hide_targets: true,
            attributes: ["gps_accuracy", "latitude", "longitude", "source_type"],
            string_attributes: ["gps_accuracy", "latitude", "longitude"],
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

test("rejects location selection inside public bindings", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      resident_primary: {
        entities: {
          "device_tracker.resident_primary_location": {
            target_entity_ids: [
              "device_tracker.example_mobile_app",
              "device_tracker.example_icloud",
            ],
            selection_mode: "best_location",
            state_mode: "passthrough",
            display_name: "Example Primary Resident",
            hide_targets: true,
            source_names: ["Home Assistant App", "iCloud"],
          },
        },
      },
    },
  };
  const rules = validateBindings(document).map((item) => item.rule);
  assert.ok(rules.includes("target-entity-id"));
  assert.ok(rules.includes("selection-mode"));
  assert.ok(rules.includes("location-metadata-owner"));
});

test("requires hide_targets to be an explicit boolean", () => {
  const entity = {
    target_entity_id: "device_tracker.example_vehicle",
    state_mode: "passthrough",
    hide_targets: "yes",
    attributes: ["gps_accuracy", "latitude", "longitude", "source_type"],
    string_attributes: ["gps_accuracy", "latitude", "longitude"],
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        entities: { "device_tracker.vehicle_primary": entity },
      },
    },
  };

  assert.ok(validateBindings(document).some((item) => item.rule === "hide-targets"));
  entity.hide_targets = true;
  assert.deepEqual(validateBindings(document), []);
});

test("accepts state-less aliases used only as service targets", () => {
  const entity = {
    target_entity_id: "button.example_vehicle_force_refresh",
    state_mode: "passthrough",
    hide_targets: true,
    expose_state: false,
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        entities: { "button.vehicle_primary_force_refresh": entity },
        services: {
          force_refresh: {
            target_service: "button.press",
            target_public_entity_id: "button.vehicle_primary_force_refresh",
          },
        },
      },
    },
  };

  assert.deepEqual(validateBindings(document), []);
  entity.expose_state = "no";
  assert.ok(validateBindings(document).some((item) => item.rule === "expose-state"));
});

test("requires every vehicle alias to hide its native target", () => {
  const entity = {
    target_entity_id: "sensor.example_vehicle_fuel_level",
    state_mode: "passthrough",
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      vehicle_primary: {
        entities: { "sensor.vehicle_primary_fuel_level": entity },
      },
    },
  };

  assert.ok(
    validateBindings(document).some(
      (item) => item.rule === "vehicle-target-visible",
    ),
  );
  entity.hide_targets = true;
  assert.deepEqual(validateBindings(document), []);
});

test("rejects source-selection metadata outside Node-RED", () => {
  const entity = {
    target_entity_id: "device_tracker.example_mobile_app",
    state_mode: "passthrough",
    source_names: ["Home Assistant App"],
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      resident_primary: {
        entities: { "device_tracker.resident_primary_location": entity },
      },
    },
  };

  assert.ok(
    validateBindings(document).some(
      (item) => item.rule === "location-metadata-owner",
    ),
  );
  delete entity.source_names;
  assert.deepEqual(validateBindings(document), []);
});

test("accepts string-projected source coordinates only when allowlisted", () => {
  const entity = {
    target_entity_id: "device_tracker.example_mobile_app",
    state_mode: "passthrough",
    attributes: ["latitude", "longitude", "gps_accuracy", "source_type"],
    string_attributes: ["latitude", "longitude", "gps_accuracy"],
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      resident_primary: {
        entities: { "device_tracker.mobile_primary_source_1": entity },
      },
    },
  };
  assert.deepEqual(validateBindings(document), []);

  entity.string_attributes.push("battery_level");
  assert.ok(
    validateBindings(document).some((item) => item.rule === "string-attributes"),
  );
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
            hide_targets: true,
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

test("requires an active iCloud refresh to identify its location source", () => {
  const publicId = "device_tracker.mobile_secondary_source_2";
  const service = {
    target_service: "icloud.update",
    location_refresh_provider: "icloud",
    location_refresh_public_entity_id: publicId,
    data: { account: "secondary@example.invalid" },
  };
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      resident_secondary: {
        entities: {
          [publicId]: {
            target_entity_id: "device_tracker.example_secondary_icloud",
            state_mode: "passthrough",
            attributes: ["gps_accuracy", "latitude", "longitude", "source_type"],
            string_attributes: ["gps_accuracy", "latitude", "longitude"],
          },
        },
        services: { refresh_location: service },
      },
    },
  };

  assert.deepEqual(validateBindings(document), []);
  delete service.location_refresh_public_entity_id;
  assert.ok(validateBindings(document).some((item) =>
    item.rule === "location-refresh-pair"));
  service.location_refresh_public_entity_id = publicId;
  service.target_service = "homeassistant.update_entity";
  assert.ok(validateBindings(document).some((item) =>
    item.rule === "location-refresh-provider"));
  service.target_service = "icloud.update";
  service.location_refresh_public_entity_id = "device_tracker.mobile_secondary_source_1";
  assert.ok(validateBindings(document).some((item) =>
    item.rule === "location-refresh-public-binding"));
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

test("reserves the legacy mobile service for actionable notifications", () => {
  const document = {
    schema_version: 1,
    roles: {
      ...roles,
      mobile_primary: {
        services: {
          notify_actionable: { target_service: "notify.send_message" },
        },
      },
    },
  };
  assert.ok(validateBindings(document).some((item) =>
    item.rule === "actionable-mobile-notify-service"));

  document.roles.mobile_primary.services.notify_actionable = {
    target_service: "notify.mobile_app_example",
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
