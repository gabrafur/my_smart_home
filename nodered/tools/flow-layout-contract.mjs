import crypto from "node:crypto";

const ROOT_TYPES = new Set(["tab", "subflow"]);
const GROUP_VISUAL_FIELDS = new Set(["x", "y", "w", "h"]);
const NODE_VISUAL_FIELDS = new Set(["x", "y"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPositionedCanvasObject(node) {
  return isObject(node) && typeof node.id === "string" && typeof node.z === "string" &&
    Number.isFinite(node.x) && Number.isFinite(node.y) && !ROOT_TYPES.has(node.type);
}

export function approvedVisualFields(node) {
  if (!isPositionedCanvasObject(node)) return new Set();
  return node.type === "group" ? GROUP_VISUAL_FIELDS : NODE_VISUAL_FIELDS;
}

export function semanticProjection(flows) {
  if (!Array.isArray(flows)) throw new TypeError("expected a top-level flow array");
  return flows.map((node) => {
    if (!isObject(node)) return node;
    const visualFields = approvedVisualFields(node);
    if (visualFields.size === 0) return node;
    const projected = {};
    for (const [key, value] of Object.entries(node)) {
      if (!visualFields.has(key)) projected[key] = value;
    }
    return projected;
  });
}

export function semanticDigest(flows) {
  return crypto.createHash("sha256").update(JSON.stringify(semanticProjection(flows))).digest("hex");
}

export function structuralInventory(flows) {
  const roots = flows.filter((node) => ROOT_TYPES.has(node?.type));
  const groups = flows.filter((node) => node?.type === "group");
  const configs = flows.filter((node) => isObject(node) && !node.z && !ROOT_TYPES.has(node.type));
  return {
    objects: flows.length,
    ids: flows.map((node) => node?.id),
    types: flows.map((node) => node?.type),
    roots: roots.map((node) => node.id),
    groups: groups.map((node) => node.id),
    configs: configs.map((node) => node.id),
  };
}

export function assertLayoutOnlyChange(before, after) {
  const beforeInventory = structuralInventory(before);
  const afterInventory = structuralInventory(after);
  if (JSON.stringify(beforeInventory) !== JSON.stringify(afterInventory)) {
    throw new Error("layout changed object order, ids, types, roots, groups, or config nodes");
  }

  const beforeDigest = semanticDigest(before);
  const afterDigest = semanticDigest(after);
  if (beforeDigest !== afterDigest) {
    throw new Error(`semantic hash changed: ${beforeDigest} -> ${afterDigest}`);
  }

  for (let index = 0; index < before.length; index += 1) {
    const beforeNode = before[index];
    const afterNode = after[index];
    const fields = approvedVisualFields(beforeNode);
    if (fields.size === 0) continue;
    for (const field of fields) {
      if (!Object.hasOwn(beforeNode, field) || !Object.hasOwn(afterNode, field)) {
        throw new Error(`${beforeNode.id}.${field} was added or removed`);
      }
      if (!Number.isFinite(afterNode[field])) {
        throw new Error(`${beforeNode.id}.${field} is not finite`);
      }
    }
  }

  return { semanticHash: beforeDigest, inventory: beforeInventory };
}

export function visualChanges(before, after) {
  const changes = [];
  for (let index = 0; index < before.length; index += 1) {
    const beforeNode = before[index];
    const afterNode = after[index];
    for (const field of approvedVisualFields(beforeNode)) {
      if (beforeNode[field] !== afterNode[field]) {
        changes.push({
          index,
          id: beforeNode.id,
          canvas: beforeNode.z,
          type: beforeNode.type,
          field,
          before: beforeNode[field],
          after: afterNode[field],
        });
      }
    }
  }
  return changes;
}
