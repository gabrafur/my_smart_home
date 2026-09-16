export const FLOW_LAYOUT_POLICY = Object.freeze({
  grid: 10,
  leftMargin: 64,
  topMargin: 20,
  nodeSpacing: 40,
  layerSpacing: 100,
  componentSpacing: 70,
  groupSpacing: 70,
  groupPadding: Object.freeze({ top: 36, right: 20, bottom: 20, left: 20 }),
  minimumGroupWidth: 180,
  maximumWireLength: 500,
  maximumGroupGap: 160,
  targetGroupGap: 80,
});

export const ELK_LAYERED_OPTIONS = Object.freeze({
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.considerModelOrder.components": "MODEL_ORDER",
  "elk.layered.considerModelOrder.portModelOrder": "true",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.compaction.connectedComponents": "true",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.nodeNode": String(FLOW_LAYOUT_POLICY.nodeSpacing),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(FLOW_LAYOUT_POLICY.layerSpacing),
  "elk.spacing.componentComponent": String(FLOW_LAYOUT_POLICY.componentSpacing),
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
});

export function snapToGrid(value, grid = FLOW_LAYOUT_POLICY.grid) {
  return Math.round(value / grid) * grid;
}
