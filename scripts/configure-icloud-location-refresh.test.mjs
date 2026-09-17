import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./configure-icloud-location-refresh.mjs", import.meta.url),
);

test("configures per-resident iCloud refresh without exposing accounts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingsPath = path.join(root, "private-bindings.json");
  const entityRegistryPath = path.join(root, "core.entity_registry");
  const configEntriesPath = path.join(root, "core.config_entries");
  const backupRoot = path.join(root, "backups");
  const accountPrimary = "primary@example.invalid";
  const accountSecondary = "secondary@example.invalid";
  fs.writeFileSync(bindingsPath, JSON.stringify({
    schema_version: 1,
    roles: {
      resident_primary: { entities: {
        "device_tracker.mobile_primary_source_2": {
          target_entity_id: "device_tracker.primary_icloud",
        },
      } },
      resident_secondary: { entities: {
        "device_tracker.mobile_secondary_source_2": {
          target_entity_id: "device_tracker.secondary_icloud",
        },
      } },
    },
  }));
  fs.writeFileSync(entityRegistryPath, JSON.stringify({ data: { entities: [
    { entity_id: "device_tracker.primary_icloud", config_entry_id: "primary" },
    { entity_id: "device_tracker.secondary_icloud", config_entry_id: "secondary" },
  ] } }));
  fs.writeFileSync(configEntriesPath, JSON.stringify({ data: { entries: [
    { entry_id: "primary", domain: "icloud", data: { username: accountPrimary } },
    { entry_id: "secondary", domain: "icloud", data: { username: accountSecondary } },
  ] } }));

  const run = () => spawnSync(process.execPath, [
    script,
    bindingsPath,
    entityRegistryPath,
    configEntriesPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, LOCATION_REFRESH_BACKUP_DIR: backupRoot },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout + first.stderr, /primary@example|secondary@example/);
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, "utf8"));
  assert.deepEqual(bindings.roles.resident_primary.services.refresh_location, {
    target_service: "icloud.update",
    location_refresh_provider: "icloud",
    location_refresh_public_entity_id: "device_tracker.mobile_primary_source_2",
    data: { account: accountPrimary },
  });
  assert.deepEqual(bindings.roles.resident_secondary.services.refresh_location, {
    target_service: "icloud.update",
    location_refresh_provider: "icloud",
    location_refresh_public_entity_id: "device_tracker.mobile_secondary_source_2",
    data: { account: accountSecondary },
  });
  assert.equal(fs.readdirSync(backupRoot).length, 1);

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /já estão configurados/);
  assert.equal(fs.readdirSync(backupRoot).length, 1);
});
