const LAYOUT_FIELDS = new Set(["x", "y", "w", "h"]);

function duplicateIds(flows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const node of flows) {
    if (seen.has(node.id)) duplicates.add(node.id);
    seen.add(node.id);
  }
  return [...duplicates].sort();
}

function stableMembership(current = [], desired = [], isOwnedId = () => true) {
  const desiredIds = new Set(desired);
  const currentIds = new Set(current);
  return [
    ...current.filter((id) => desiredIds.has(id) || !isOwnedId(id)),
    ...desired.filter((id) => !currentIds.has(id)),
  ];
}

function mergeNode(current, desired, { preserveLayout, isOwnedId }) {
  const merged = structuredClone(current);
  for (const [property, value] of Object.entries(desired)) {
    if (preserveLayout && LAYOUT_FIELDS.has(property)) {
      continue;
    }
    if (property === "nodes" && Array.isArray(current.nodes) && Array.isArray(value)) {
      merged.nodes = stableMembership(current.nodes, value, isOwnedId);
      continue;
    }
    merged[property] = structuredClone(value);
  }
  return merged;
}

/**
 * Reconciles a generator's desired result with the file it read.
 *
 * Generators may build a convenient replacement graph internally, but the
 * persisted result is updated by id: existing nodes keep their array slot,
 * approved layout and stable group membership; genuinely new nodes are
 * appended once; obsolete nodes are removed only when explicitly owned.
 */
export function reconcileGeneratedFlows(currentFlows, desiredFlows, options = {}) {
  const preserveLayout = options.preserveLayout ?? true;
  const isOwned = options.isOwned ?? (() => false);
  const shouldUpdate = options.shouldUpdate ?? (() => true);
  const currentById = new Map(currentFlows.map((node) => [node.id, node]));
  const desiredById = new Map(desiredFlows.map((node) => [node.id, node]));

  if (currentById.size !== currentFlows.length) {
    throw new Error(`IDs duplicados no fluxo atual: ${duplicateIds(currentFlows).join(", ")}`);
  }
  if (desiredById.size !== desiredFlows.length) {
    const duplicated = duplicateIds(desiredFlows);
    const details = desiredFlows
      .filter((node) => duplicated.includes(node.id))
      .map((node) => `${node.id}[route=${Object.hasOwn(node, "notification_hub_wire_route") ? "yes" : "no"}]`);
    throw new Error(`IDs duplicados no fluxo gerado: ${details.join(", ")}`);
  }
  const isOwnedId = (id) => {
    const node = currentById.get(id) ?? desiredById.get(id);
    return node ? isOwned(node) : false;
  };

  const reconciled = [];
  for (const current of currentFlows) {
    const desired = desiredById.get(current.id);
    if (desired) {
      reconciled.push(shouldUpdate(current, desired)
        ? mergeNode(current, desired, { preserveLayout, isOwnedId })
        : structuredClone(current));
    } else if (!isOwned(current)) {
      reconciled.push(structuredClone(current));
    }
  }

  for (const desired of desiredFlows) {
    if (!currentById.has(desired.id) && isOwned(desired)) {
      reconciled.push(structuredClone(desired));
    }
  }
  return reconciled;
}
