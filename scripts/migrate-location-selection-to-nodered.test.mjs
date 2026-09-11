import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./migrate-location-selection-to-nodered.mjs", import.meta.url),
);

test("moves location ownership to Node-RED and creates a private backup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "location-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "private-bindings.json");
  const backup = path.join(root, "backup");
  const source = (targetEntityId) => ({
    target_entity_id: targetEntityId,
    state_mode: "passthrough",
    hide_targets: false,
    source_names: ["legacy"],
  });
  const document = {
    schema_version: 1,
    roles: {
      resident_primary: {
        entities: {
          "device_tracker.mobile_primary_source_1": source("device_tracker.a"),
          "device_tracker.mobile_primary_source_2": source("device_tracker.b"),
          "device_tracker.resident_primary_location": {
            target_entity_ids: ["device_tracker.a", "device_tracker.b"],
            selection_mode: "best_location",
          },
        },
      },
      resident_secondary: {
        entities: {
          "device_tracker.mobile_secondary_source_1": source("device_tracker.c"),
          "device_tracker.mobile_secondary_source_2": source("device_tracker.d"),
          "device_tracker.resident_secondary_location": {
            target_entity_ids: ["device_tracker.c", "device_tracker.d"],
            selection_mode: "best_location",
          },
        },
      },
      vehicle_primary: {
        entities: {
          "device_tracker.vehicle_primary": source("device_tracker.vehicle"),
        },
      },
    },
  };
  fs.writeFileSync(target, `${JSON.stringify(document)}\n`, { mode: 0o640 });

  const first = spawnSync(process.execPath, [script, target], {
    encoding: "utf8",
    env: { ...process.env, LOCATION_MIGRATION_BACKUP_DIR: backup },
  });
  assert.equal(first.status, 0, first.stderr);
  const migrated = JSON.parse(fs.readFileSync(target, "utf8"));
  for (const [role, prefix] of [
    ["resident_primary", "device_tracker.mobile_primary_source_"],
    ["resident_secondary", "device_tracker.mobile_secondary_source_"],
  ]) {
    const entities = migrated.roles[role].entities;
    assert.equal(entities[`device_tracker.${role}_location`], undefined);
    assert.equal(entities[`${prefix}1`].hide_targets, true);
    assert.equal(entities[`${prefix}2`].hide_targets, true);
  }
  for (const role of Object.values(migrated.roles)) {
    for (const binding of Object.values(role.entities ?? {})) {
      assert.equal(binding.source_names, undefined);
    }
  }
  assert.deepEqual(
    new Set(
      migrated.roles.vehicle_primary.entities["device_tracker.vehicle_primary"]
        .string_attributes,
    ),
    new Set(["gps_accuracy", "latitude", "longitude"]),
  );
  assert.equal(
    migrated.roles.vehicle_primary.entities["device_tracker.vehicle_primary"]
      .hide_targets,
    true,
  );
  assert.equal(fs.readdirSync(backup).length, 1);

  const second = spawnSync(process.execPath, [script, target], {
    encoding: "utf8",
    env: { ...process.env, LOCATION_MIGRATION_BACKUP_DIR: backup },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /já delegam a seleção/);
  assert.equal(fs.readdirSync(backup).length, 1);
});
