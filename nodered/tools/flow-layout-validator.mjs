const DEFAULT_NODE_HEIGHT = 34;
const COMMENT_HEIGHT = 42;

export function nodeDimensions(node) {
  if (node.type === "link in" || node.type === "link out") {
    return { width: 34, height: 28 };
  }
  return {
    width: Math.max(120, Math.min(260, 34 + String(node.name || node.type).length * 7)),
    height: node.type === "comment" ? COMMENT_HEIGHT : DEFAULT_NODE_HEIGHT,
  };
}

function positioned(node) {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

function nodeBounds(node) {
  const { width, height } = nodeDimensions(node);
  return {
    left: node.x - width / 2,
    right: node.x + width / 2,
    top: node.y - height / 2,
    bottom: node.y + height / 2,
  };
}

function groupBounds(group) {
  return {
    left: group.x,
    right: group.x + group.w,
    top: group.y,
    bottom: group.y + group.h,
  };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function validateFlowLayout(flows) {
  const issues = [];
  const roots = flows.filter((node) => node.type === "tab" || node.type === "subflow");

  for (const root of roots) {
    const rootName = root.label || root.name || root.id;
    const groups = flows.filter((node) => node.z === root.id && node.type === "group" && positioned(node));
    const nodes = flows.filter((node) => node.z === root.id && node.type !== "group" && positioned(node));

    for (let index = 0; index < groups.length; index += 1) {
      for (let candidate = index + 1; candidate < groups.length; candidate += 1) {
        if (overlaps(groupBounds(groups[index]), groupBounds(groups[candidate]))) {
          issues.push(`${rootName}: groups overlap: ${groups[index].id} / ${groups[candidate].id}`);
        }
      }
    }

    for (let index = 0; index < nodes.length; index += 1) {
      for (let candidate = index + 1; candidate < nodes.length; candidate += 1) {
        if (overlaps(nodeBounds(nodes[index]), nodeBounds(nodes[candidate]))) {
          issues.push(`${rootName}: nodes overlap: ${nodes[index].id} / ${nodes[candidate].id}`);
        }
      }
    }

    const groupsById = new Map(groups.map((group) => [group.id, group]));
    for (const node of nodes.filter((candidate) => candidate.g)) {
      const group = groupsById.get(node.g);
      if (!group) continue;
      const bounds = nodeBounds(node);
      const owner = groupBounds(group);
      if (bounds.left < owner.left || bounds.right > owner.right || bounds.top < owner.top || bounds.bottom > owner.bottom) {
        issues.push(`${rootName}: node outside group bounds: ${node.id} / ${group.id}`);
      }
    }
  }

  return issues;
}
