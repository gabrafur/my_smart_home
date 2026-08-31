#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabId = "456b32bd5d59b0d6";

const groups = {
  c8f8e5b532232a4f: { x: 74, y: 79, w: 1587, h: 312 },
  "5ae977feca8f9b01": { x: 74, y: 419, w: 4152, h: 442 },
  "4afb66a093b1940d": { x: 64, y: 879, w: 4517, h: 422 },
  f79ed8df25162bcf: { x: 64, y: 1399, w: 1592, h: 182 },
  global_observer_coverage__456b32bd5d59b0d6__group: { x: 4524, y: 59, w: 722, h: 142 },
};

const positions = {
  // 1. Detectar a condição e reconciliar o estado no startup.
  "9b0dbe523189f263": [220, 120],
  "05a75234a5e2020d": [500, 120],
  "4a38415ec9862e2e": [800, 120],
  "482e20c891bc1dd8": [1100, 120],
  c720a52c53f8f4de: [220, 220],
  "7e00437eb45c44bc": [500, 220],
  "338e309762aa7a99": [800, 220],
  "566d191a914b687b": [1100, 220],
  a35f9d7d54ac6026: [1420, 220],
  "29b85bea56c558c5": [1420, 310],

  // 2. Aplicar o resfriamento; a trilha inferior concentra falhas e retries.
  "54b8e92dac5342a4": [1100, 500],
  b8c032f35ca26623: [1380, 500],
  "26d9d7195ce14910": [1660, 460],
  "8c3d9e9163059731": [1740, 560],
  "2e77d30f5abbb9e8": [1980, 560],
  cc598d0965e30fe5: [2200, 560],
  a32c4cc997cdaee0: [2460, 560],
  "47cae39680ac8969": [2720, 560],
  c57195edaf731fea: [3000, 560],
  "303ec8403542617c": [3280, 560],
  bed05acc4339b69c: [3550, 560],
  a6f0fa154aac7b84: [3840, 540],
  "0cca7636547bd45c": [4120, 540],
  aa1a0d2a4b3dfd43: [3825, 660],
  b826f528fd92e2bd: [3825, 700],
  "048e2325e2e65944": [3825, 740],
  "4e460c1a9e688d48": [220, 760],
  "065453aa19652afe": [520, 760],
  "2715a6cbdf6f5683": [760, 620],
  "7a46b455ab19f6f1": [830, 700],
  "426ce86b78602275": [1040, 620],
  "80a75ea8907407b3": [1380, 720],
  "2721ff200d00c0f6": [900, 800],
  "93a520c87fdd951a": [735, 820],

  // 3. Restaurar o snapshot; decisões paralelas ficam em trilhas distintas.
  "213e93913539d640": [200, 980],
  aaa9ce1abce5f4a2: [440, 980],
  "8a59f82d6ce4aadf": [680, 980],
  "6162b449cc4a318b": [920, 980],
  "0547960da622f030": [1160, 980],
  "3fbbfda5d4519a8a": [1400, 980],
  "58fc2938de8879ce": [1660, 940],
  "54e8149a2939446d": [1700, 1040],
  "2d4e5f16992b02a3": [1950, 1040],
  abef0869bb9f8954: [2160, 960],
  "9db243616c0d9256": [2320, 1040],
  "94cf8f23337b9e97": [2580, 960],
  d4a1580cc965ba33: [2870, 1040],
  feff1e28b5cf244b: [3160, 1040],
  ff9a68d5d76c1aab: [3430, 1040],
  "6e624c181ac580f8": [3700, 1040],
  b9a3beb0d37aad9a: [4020, 980],
  "33cff748799e2546": [4300, 980],
  "9b036ac57fe732eb": [4020, 1100],
  "87c69add421941ca": [4300, 1100],
  "3f9982ee3d4d2c9a": [4540, 950],
  "611069891a9aa1ad": [4540, 990],
  "787769d2959d6ad5": [4540, 1030],
  c23c6d5c4ce5c532: [4540, 1070],
  ff69bc148fd602ce: [220, 1260],
  "3653df579248c807": [550, 1260],
  b69a6887788d1c54: [810, 1160],
  "429438d87ff983ef": [795, 1260],
  c1b98e075390aee0: [1100, 1160],
  "030e7e2e244bc035": [1400, 1180],

  // 4. Persistência e notificações em pares de entrada/ação.
  f9be08e865d2c10e: [105, 1440],
  ca55bd1e9433732e: [260, 1440],
  adb240fe59ad2ae7: [525, 1440],
  "349bc099633fee5d": [680, 1440],
  fb7ee906fa3b1033: [945, 1440],
  a240a1bb42481943: [1100, 1440],
  "12141375e10fc751": [1365, 1440],
  ab4f85af1ed94f86: [1520, 1440],
  "7e7a1b1cebdb498a": [105, 1540],
  "5dd0deebdc474035": [280, 1540],
  ed15af8740df7acc: [525, 1540],
  "36968b4881eab9d3": [700, 1540],
  "1e4e450ccd8e4ab6": [965, 1540],
  "4b48bc3c0c58d87c": [1140, 1540],

  // Observador global permanece isolado do fluxo funcional.
  global_observer_coverage__456b32bd5d59b0d6__catch: [4680, 100],
  global_observer_coverage__456b32bd5d59b0d6__status: [4690, 160],
  global_observer_coverage__456b32bd5d59b0d6__annotate: [4960, 130],
  global_observer_coverage__456b32bd5d59b0d6__out: [5205, 130],
};

const virtualRoutes = [
  {
    input: ["rpi_layout_start_failure_in", "Retorno: tratar falha de início", "5ae977feca8f9b01", 360, 760, "065453aa19652afe"],
    outputs: [
      ["rpi_layout_lock_failure_out", "Ir para falha de início", "c8f8e5b532232a4f", 1280, 150, "482e20c891bc1dd8", 1],
      ["rpi_layout_snapshot_failure_out", "Ir para falha de início", "5ae977feca8f9b01", 1560, 630, "b8c032f35ca26623", 2],
      ["rpi_layout_validation_failure_out", "Ir para falha de início", "5ae977feca8f9b01", 3465, 620, "303ec8403542617c", 1],
    ],
  },
  {
    input: ["rpi_layout_startup_rollback_in", "Retorno: restaurar snapshot", "4afb66a093b1940d", 1040, 940, "0547960da622f030"],
    outputs: [
      ["rpi_layout_classifier_rollback_out", "Ir para restauração", "c8f8e5b532232a4f", 1280, 260, "566d191a914b687b", 2],
      ["rpi_layout_failure_rollback_out", "Ir para restauração", "5ae977feca8f9b01", 755, 760, "065453aa19652afe", 2],
    ],
  },
  {
    input: ["rpi_layout_startup_timer_in", "Retorno: confirmar CPU normal", "4afb66a093b1940d", 925, 1240, "c1b98e075390aee0"],
    outputs: [
      ["rpi_layout_startup_timer_out", "Ir para confirmação de CPU", "c8f8e5b532232a4f", 1620, 250, "a35f9d7d54ac6026", 0],
    ],
  },
  {
    input: ["rpi_layout_startup_retry_in", "Retorno: reconciliar startup", "c8f8e5b532232a4f", 585, 280, "338e309762aa7a99"],
    outputs: [
      ["rpi_layout_startup_retry_out", "Ir para reconciliação", "5ae977feca8f9b01", 1005, 700, "7a46b455ab19f6f1", 0],
    ],
  },
  {
    input: ["rpi_layout_hot_retry_in", "Retorno: reler ownership", "c8f8e5b532232a4f", 660, 150, "4a38415ec9862e2e"],
    outputs: [
      ["rpi_layout_hot_retry_out", "Ir para ownership", "5ae977feca8f9b01", 1225, 620, "426ce86b78602275", 0],
    ],
  },
  {
    input: ["rpi_layout_cancel_timer_in", "Retorno: cancelar janela retomada", "c8f8e5b532232a4f", 1320, 350, "29b85bea56c558c5"],
    outputs: [
      ["rpi_layout_cancel_timer_out", "Ir para cancelamento da janela", "4afb66a093b1940d", 360, 1040, "213e93913539d640", 1],
    ],
  },
  {
    input: ["rpi_layout_stop_prepare_in", "Retorno: preparar encerramento", "4afb66a093b1940d", 340, 940, "aaa9ce1abce5f4a2"],
    outputs: [
      ["rpi_layout_stop_prepare_out", "Ir para preparação da saída", "4afb66a093b1940d", 1285, 1120, "c1b98e075390aee0", 0],
    ],
  },
  {
    input: ["rpi_layout_restore_failure_in", "Retorno: tratar falha de restauração", "4afb66a093b1940d", 345, 1220, "3653df579248c807"],
    outputs: [
      ["rpi_layout_restore_decision_failure_out", "Ir para falha de restauração", "4afb66a093b1940d", 1540, 1100, "3fbbfda5d4519a8a", 2],
      ["rpi_layout_restore_validation_failure_out", "Ir para falha de restauração", "4afb66a093b1940d", 3625, 1080, "ff9a68d5d76c1aab", 1],
    ],
  },
  {
    input: ["rpi_layout_restore_wait_in", "Retorno: aguardar confirmação", "4afb66a093b1940d", 2680, 1080, "d4a1580cc965ba33"],
    outputs: [
      ["rpi_layout_restore_off_wait_out", "Ir para confirmação", "4afb66a093b1940d", 1820, 920, "58fc2938de8879ce", 0],
      ["rpi_layout_restore_fan_wait_out", "Ir para confirmação", "4afb66a093b1940d", 2485, 1080, "9db243616c0d9256", 1],
    ],
  },
];

const routedNodeIds = new Set();
for (const { input, outputs } of virtualRoutes) {
  const [inputId, inputName, inputGroup, inputX, inputY, targetId] = input;
  const outputIds = outputs.map(([outputId]) => outputId);
  const inputNode = {
    id: inputId,
    type: "link in",
    z: tabId,
    g: inputGroup,
    name: inputName,
    links: outputIds,
    x: inputX,
    y: inputY,
    wires: [[targetId]],
  };
  const existingInput = byId.get(inputId);
  if (existingInput) Object.assign(existingInput, inputNode);
  else {
    flows.push(inputNode);
    byId.set(inputId, inputNode);
  }
  routedNodeIds.add(inputId);

  for (const [outputId, outputName, outputGroup, outputX, outputY, sourceId, outputIndex] of outputs) {
    const outputNode = {
      id: outputId,
      type: "link out",
      z: tabId,
      g: outputGroup,
      name: outputName,
      mode: "link",
      links: [inputId],
      x: outputX,
      y: outputY,
      wires: [],
    };
    const existingOutput = byId.get(outputId);
    if (existingOutput) Object.assign(existingOutput, outputNode);
    else {
      flows.push(outputNode);
      byId.set(outputId, outputNode);
    }
    routedNodeIds.add(outputId);

    const source = byId.get(sourceId);
    if (!source?.wires?.[outputIndex]) throw new Error(`Cooling route source not found: ${sourceId}[${outputIndex}]`);
    source.wires[outputIndex] = source.wires[outputIndex].map((id) => id === targetId ? outputId : id);
    if (!source.wires[outputIndex].includes(outputId)) {
      throw new Error(`Cooling route target changed unexpectedly: ${sourceId}[${outputIndex}] -> ${targetId}`);
    }
  }
}

for (const [id, geometry] of Object.entries(groups)) {
  const group = byId.get(id);
  if (!group || group.type !== "group" || group.z !== tabId) {
    throw new Error(`Cooling group not found: ${id}`);
  }
  Object.assign(group, geometry);
  const routeMembers = [...routedNodeIds].filter((nodeId) => byId.get(nodeId)?.g === id);
  group.nodes = [...new Set([...group.nodes, ...routeMembers])];
}

for (const [id, [x, y]] of Object.entries(positions)) {
  const node = byId.get(id);
  if (!node || node.z !== tabId || node.type === "group") {
    throw new Error(`Cooling node not found: ${id}`);
  }
  Object.assign(node, { x, y });
}

const unpositioned = flows.filter(
  (node) => node.z === tabId && node.type !== "group" && !Object.hasOwn(positions, node.id) && !routedNodeIds.has(node.id),
);
if (unpositioned.length) {
  throw new Error(`Cooling nodes without a layout position: ${unpositioned.map((node) => node.id).join(", ")}`);
}

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Raspberry Pi cooling flow layout organized.");
