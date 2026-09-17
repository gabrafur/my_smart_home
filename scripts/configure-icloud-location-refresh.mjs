#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindingsPath = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "bindings/private/private-bindings.json"),
);
const entityRegistryPath = process.argv[3] && path.resolve(process.argv[3]);
const configEntriesPath = process.argv[4] && path.resolve(process.argv[4]);
const backupRoot = path.resolve(
  process.env.LOCATION_REFRESH_BACKUP_DIR ??
    path.join(repoRoot, "bindings/private/backups"),
);

if (!entityRegistryPath || !configEntriesPath) {
  throw new Error("Informe core.entity_registry e core.config_entries");
}

const bindings = JSON.parse(fs.readFileSync(bindingsPath, "utf8"));
const entityRegistry = JSON.parse(fs.readFileSync(entityRegistryPath, "utf8"));
const configEntries = JSON.parse(fs.readFileSync(configEntriesPath, "utf8"));
const entities = entityRegistry.data?.entities ?? [];
const entries = configEntries.data?.entries ?? [];
let changed = false;

for (const [role, shortRole] of [
  ["resident_primary", "primary"],
  ["resident_secondary", "secondary"],
]) {
  const roleBinding = bindings.roles?.[role];
  if (!roleBinding) throw new Error(`Binding obrigatório ausente: ${role}`);
  const publicSource = `device_tracker.mobile_${shortRole}_source_2`;
  const target = roleBinding.entities?.[publicSource]?.target_entity_id;
  if (!target) throw new Error(`Fonte iCloud obrigatória ausente: ${publicSource}`);
  const entity = entities.find((candidate) => candidate.entity_id === target);
  if (!entity?.config_entry_id) {
    throw new Error(`Registro da fonte iCloud ausente para ${role}`);
  }
  const entry = entries.find(
    (candidate) => candidate.entry_id === entity.config_entry_id,
  );
  if (entry?.domain !== "icloud") {
    throw new Error(`Fonte secundária de ${role} não pertence ao iCloud`);
  }
  const account = entry.data?.username;
  if (typeof account !== "string" || account.length === 0) {
    throw new Error(`Conta iCloud ausente para ${role}`);
  }
  const desired = {
    target_service: "icloud.update",
    location_refresh_provider: "icloud",
    location_refresh_public_entity_id: publicSource,
    data: { account },
  };
  roleBinding.services ??= {};
  if (JSON.stringify(roleBinding.services.refresh_location) !== JSON.stringify(desired)) {
    roleBinding.services.refresh_location = desired;
    changed = true;
  }
}

if (!changed) {
  console.log("Bindings privados de refresh iCloud já estão configurados.");
  process.exit(0);
}

fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backup = path.join(
  backupRoot,
  `private-bindings-before-icloud-refresh-${stamp}.json`,
);
fs.copyFileSync(bindingsPath, backup, fs.constants.COPYFILE_EXCL);
fs.chmodSync(backup, 0o600);

const mode = fs.statSync(bindingsPath).mode & 0o777;
const temporary = `${bindingsPath}.icloud-refresh-${process.pid}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(bindings, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, bindingsPath);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}

console.log("Bindings privados de refresh iCloud configurados; valores permaneceram privados.");
