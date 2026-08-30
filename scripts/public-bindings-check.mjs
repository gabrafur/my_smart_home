#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredRoles = [
  "resident_primary",
  "resident_secondary",
  "mobile_primary",
  "mobile_secondary",
  "vehicle_primary",
  "garage_gate",
  "exterior_light",
  "security_panel",
];
const entityIdPattern = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const servicePattern = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const publicRolePattern = /(?:resident|mobile)_(?:primary|secondary)|vehicle_primary|garage_gate|exterior_light|security_panel/;

function issue(rule, location, category) {
  return { rule, location, category };
}

export function validateBindings(document, { requireAllRoles = true } = {}) {
  const issues = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return [issue("document-type", "$", "schema")];
  }
  if (document.schema_version !== 1) issues.push(issue("schema-version", "$.schema_version", "schema"));
  if (!document.roles || typeof document.roles !== "object" || Array.isArray(document.roles)) {
    issues.push(issue("roles-type", "$.roles", "schema"));
    return issues;
  }
  if (requireAllRoles) {
    for (const role of requiredRoles) {
      if (!Object.hasOwn(document.roles, role)) issues.push(issue("required-role", `$.roles.${role}`, "binding"));
    }
  }
  for (const [role, binding] of Object.entries(document.roles)) {
    if (!requiredRoles.includes(role)) issues.push(issue("unknown-role", `$.roles.${role}`, "binding"));
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      issues.push(issue("role-type", `$.roles.${role}`, "schema"));
      continue;
    }
    for (const [publicId, entity] of Object.entries(binding.entities ?? {})) {
      const location = `$.roles.${role}.entities.${publicId}`;
      if (!entityIdPattern.test(publicId) || !publicRolePattern.test(publicId)) {
        issues.push(issue("public-entity-id", location, "binding"));
      }
      const scalarTarget = entityIdPattern.test(entity?.target_entity_id ?? "");
      const locationTargets =
        Array.isArray(entity?.target_entity_ids) &&
        entity.target_entity_ids.length >= 2 &&
        new Set(entity.target_entity_ids).size === entity.target_entity_ids.length &&
        entity.target_entity_ids.every((target) => entityIdPattern.test(target));
      if (!entity || typeof entity !== "object" || scalarTarget === locationTargets) {
        issues.push(issue("target-entity-id", location, "binding"));
      }
      if (locationTargets && entity.selection_mode !== "best_location") {
        issues.push(issue("selection-mode", location, "binding"));
      }
      if (!locationTargets && entity?.selection_mode !== undefined) {
        issues.push(issue("selection-mode", location, "binding"));
      }
      if (entity.state_mode && !["passthrough", "home_away", "boolean"].includes(entity.state_mode)) {
        issues.push(issue("state-mode", location, "binding"));
      }
      if (publicId.startsWith("device_tracker.") && entity.state_mode !== "passthrough") {
        issues.push(issue("location-state-mode", location, "binding"));
      }
      const allowedAttributes = new Set(entity.attributes ?? []);
      const stringAttributes = entity.string_attributes ?? [];
      if (
        !Array.isArray(stringAttributes) ||
        new Set(stringAttributes).size !== stringAttributes.length ||
        stringAttributes.some(
          (attribute) =>
            !/^[a-z0-9_]+$/.test(attribute) || !allowedAttributes.has(attribute),
        )
      ) {
        issues.push(issue("string-attributes", location, "binding"));
      }
      for (const service of entity.allowed_services ?? []) {
        if (!servicePattern.test(service)) issues.push(issue("allowed-service", location, "binding"));
      }
    }
    for (const [action, service] of Object.entries(binding.services ?? {})) {
      const location = `$.roles.${role}.services.${action}`;
      if (!/^[a-z0-9_]+$/.test(action)) issues.push(issue("action-name", location, "binding"));
      if (!service || typeof service !== "object" || !servicePattern.test(service.target_service ?? "")) {
        issues.push(issue("target-service", location, "binding"));
      }
      const legacyMobileNotify = /^notify\.mobile_app_/.test(service?.target_service ?? "");
      if (legacyMobileNotify && action !== "notify_actionable") {
        issues.push(issue("legacy-mobile-notify-service", location, "binding"));
      }
      if (action === "notify_actionable" && !legacyMobileNotify) {
        issues.push(issue("actionable-mobile-notify-service", location, "binding"));
      }
      if (service?.target_service === "notify.send_message" && !service?.target_entity_id) {
        issues.push(issue("notify-target-entity", location, "binding"));
      }
      if (service?.data !== undefined && (
        !service.data || typeof service.data !== "object" || Array.isArray(service.data)
      )) {
        issues.push(issue("service-data", location, "binding"));
      }
      if (service?.target_entity_id && !entityIdPattern.test(service.target_entity_id)) {
        issues.push(issue("service-target-entity", location, "binding"));
      }
      if (service?.target_public_entity_id) {
        if (!entityIdPattern.test(service.target_public_entity_id)) {
          issues.push(issue("service-target-public-entity", location, "binding"));
        } else if (!Object.hasOwn(binding.entities ?? {}, service.target_public_entity_id)) {
          issues.push(issue("service-target-public-binding", location, "binding"));
        }
      }
    }
    for (const [key, topic] of Object.entries(binding.topics ?? {})) {
      const location = `$.roles.${role}.topics.${key}`;
      if (!/^[a-z0-9_]+$/.test(key) || typeof topic !== "string" || topic.length === 0) {
        issues.push(issue("mqtt-topic", location, "binding"));
      }
    }
    if (binding.mqtt_topics !== undefined && !Array.isArray(binding.mqtt_topics)) {
      issues.push(issue("mqtt-topics-type", `$.roles.${role}.mqtt_topics`, "schema"));
    }
    for (const [index, topic] of (binding.mqtt_topics ?? []).entries()) {
      const location = `$.roles.${role}.mqtt_topics.${index}`;
      if (typeof topic === "string") {
        if (topic.length === 0) issues.push(issue("mqtt-topic", location, "binding"));
        continue;
      }
      if (!topic || typeof topic !== "object" || typeof topic.topic !== "string" || topic.topic.length === 0) {
        issues.push(issue("mqtt-topic", location, "binding"));
      }
      if (!("payload_on" in (topic ?? {})) || !("payload_off" in (topic ?? {}))) {
        issues.push(issue("mqtt-payload", location, "binding"));
      }
    }
  }
  return issues;
}

export function checkFile(file, options) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [issue("json-parse", path.relative(repoRoot, file) || file, "schema")];
  }
  return validateBindings(document, options);
}

export function validateFlowBindingCalls(document, flows) {
  const issues = [];
  for (const node of flows) {
    if (node?.action !== "public_bindings.call" || typeof node.data !== "string") continue;
    const role = /["']role["']\s*:\s*["']([a-z0-9_]+)["']/.exec(node.data)?.[1];
    const action = /["']action["']\s*:\s*["']([a-z0-9_]+)["']/.exec(node.data)?.[1];
    if (!role || !action) {
      issues.push(issue("consumer-contract", `nodered:${node.id ?? "unknown"}`, "binding"));
      continue;
    }
    if (!document.roles?.[role]?.services?.[action]) {
      issues.push(issue("consumer-service", `${role}/${action}`, "binding"));
    }
  }
  return issues;
}

function main() {
  const privateIndex = process.argv.indexOf("--private");
  const explicitPrivate = privateIndex >= 0 ? process.argv[privateIndex + 1] : null;
  const file = explicitPrivate
    ? path.resolve(explicitPrivate)
    : path.join(repoRoot, "bindings", "private-bindings.example.json");
  if (explicitPrivate && !fs.existsSync(file)) {
    console.error("rule=private-file file=<configured> line=0 category=binding");
    process.exit(1);
  }
  const issues = checkFile(file, { requireAllRoles: !explicitPrivate });
  if (issues.length === 0) {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    const flows = JSON.parse(fs.readFileSync(path.join(repoRoot, "nodered", "flows.json"), "utf8"));
    issues.push(...validateFlowBindingCalls(document, flows));
  }
  if (issues.length) {
    for (const item of issues) {
      console.error(`rule=${item.rule} file=${explicitPrivate ? "<private-bindings>" : "bindings/private-bindings.example.json"} line=0 category=${item.category}`);
    }
    process.exit(1);
  }
  console.log(`Public bindings check passed (${explicitPrivate ? "private file, values omitted" : "public example"}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
