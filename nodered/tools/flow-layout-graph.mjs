const LINK_TYPES = new Set(["link in", "link out", "link call"]);

function edgeKey(source, target) {
  return `${source}\u0000${target}`;
}

export function semanticEdges(flows, canvasId) {
  const canvasNodes = flows.filter((node) => node.z === canvasId && node.type !== "group");
  const byId = new Map(canvasNodes.map((node) => [node.id, node]));
  const edges = [];
  const seen = new Set();
  const add = (source, target, kind, output = 0) => {
    if (source === target || !byId.has(source) || !byId.has(target)) return;
    const key = edgeKey(source, target);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, kind, output });
  };

  for (const node of canvasNodes) {
    for (const [output, targets] of (node.wires ?? []).entries()) {
      for (const target of Array.isArray(targets) ? targets : []) add(node.id, target, "wire", output);
    }
  }

  for (const node of canvasNodes.filter((candidate) => LINK_TYPES.has(candidate.type))) {
    if (node.type === "link in") continue;
    for (const target of Array.isArray(node.links) ? node.links : []) {
      add(node.id, target, node.type === "link call" ? "link-call" : "link", 0);
    }
  }

  return edges;
}

export function connectedComponents(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }
  const remaining = new Set(nodeIds);
  const components = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const component = [];
    const queue = [seed];
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!remaining.delete(neighbor)) continue;
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}
