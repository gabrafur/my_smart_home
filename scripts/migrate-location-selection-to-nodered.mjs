#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(
  process.argv[2] ??
    path.join(repoRoot, "bindings/private/private-bindings.json"),
);
const backupRoot = path.resolve(
  process.env.LOCATION_MIGRATION_BACKUP_DIR ??
    path.join(repoRoot, "bindings/private/backups"),
);

if (!fs.existsSync(target)) {
  throw new Error("Arquivo privado de bindings não encontrado");
}

const document = JSON.parse(fs.readFileSync(target, "utf8"));
let changed = false;
function normalizeLocationInput(binding) {
  const attributes = new Set(binding.attributes ?? []);
  for (const attribute of ["gps_accuracy", "latitude", "longitude", "source_type"]) {
    attributes.add(attribute);
  }
  const normalizedAttributes = [...attributes];
  if (JSON.stringify(binding.attributes ?? []) !== JSON.stringify(normalizedAttributes)) {
    binding.attributes = normalizedAttributes;
    changed = true;
  }

  const stringAttributes = new Set(binding.string_attributes ?? []);
  for (const attribute of ["gps_accuracy", "latitude", "longitude"]) {
    stringAttributes.add(attribute);
  }
  const normalizedStrings = [...stringAttributes];
  if (
    JSON.stringify(binding.string_attributes ?? []) !==
    JSON.stringify(normalizedStrings)
  ) {
    binding.string_attributes = normalizedStrings;
    changed = true;
  }
}

for (const [role, aliases] of Object.entries({
  resident_primary: [
    "device_tracker.mobile_primary_source_1",
    "device_tracker.mobile_primary_source_2",
  ],
  resident_secondary: [
    "device_tracker.mobile_secondary_source_1",
    "device_tracker.mobile_secondary_source_2",
  ],
})) {
  const entities = document.roles?.[role]?.entities;
  if (!entities || typeof entities !== "object") {
    throw new Error(`Bindings de ${role} ausentes`);
  }
  for (const alias of aliases) {
    if (!entities[alias]?.target_entity_id) {
      throw new Error(`Alias bruto obrigatório ausente: ${alias}`);
    }
    if (entities[alias].hide_targets !== true) {
      entities[alias].hide_targets = true;
      changed = true;
    }
    normalizeLocationInput(entities[alias]);
  }
  const consolidated = `device_tracker.${role}_location`;
  if (entities[consolidated] !== undefined) {
    delete entities[consolidated];
    changed = true;
  }
}

for (const role of Object.values(document.roles ?? {})) {
  for (const binding of Object.values(role?.entities ?? {})) {
    if (
      binding &&
      typeof binding === "object" &&
      binding.source_names !== undefined
    ) {
      delete binding.source_names;
      changed = true;
    }
  }
}

const vehicleLocation =
  document.roles?.vehicle_primary?.entities?.["device_tracker.vehicle_primary"];
if (!vehicleLocation?.target_entity_id) {
  throw new Error("Alias bruto obrigatório ausente: device_tracker.vehicle_primary");
}
if (vehicleLocation.hide_targets !== true) {
  vehicleLocation.hide_targets = true;
  changed = true;
}
normalizeLocationInput(vehicleLocation);

if (!changed) {
  console.log("Bindings privados já delegam a seleção de localização ao Node-RED.");
  process.exit(0);
}

fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backup = path.join(backupRoot, `private-bindings-before-location-${stamp}.json`);
fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
fs.chmodSync(backup, 0o600);
const mode = fs.statSync(target).mode & 0o777;
fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { mode });
fs.chmodSync(target, mode);
console.log("Bindings privados migrados; conteúdo e backup permaneceram privados.");
