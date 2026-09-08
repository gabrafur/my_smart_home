#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const outputPath = process.env.NODE_RED_FLOW_OUTPUT
  ? new URL(`file://${process.env.NODE_RED_FLOW_OUTPUT}`)
  : flowPath;
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const tab = "ea0a6aa0d24ff863";
const normalizer = flows.find((node) => node.name === "Normalizar pessoas e detectar transições");
if (!normalizer?.func) throw new Error("Normalizador de pessoas não encontrado");

normalizer.func = normalizer.func.replace(
  "const ARRIVAL_DISTANCE_M = 300;",
  `const DEFAULT_ARRIVAL_DISTANCE_M = 700;
const configuredArrivalDistanceM = Number(
    flow.get("security_arrival_distance_m", "persistent")
);
const ARRIVAL_DISTANCE_M =
    Number.isFinite(configuredArrivalDistanceM) &&
    configuredArrivalDistanceM >= 50 &&
    configuredArrivalDistanceM <= 2000
        ? configuredArrivalDistanceM
        : DEFAULT_ARRIVAL_DISTANCE_M;`,
);

const ids = new Set([
  "people_arrival_distance_group_v1",
  "people_arrival_distance_comment_v1",
  "people_arrival_distance_set_v1",
  "people_arrival_distance_apply_v1",
]);
for (let index = flows.length - 1; index >= 0; index -= 1) {
  if (ids.has(flows[index].id)) flows.splice(index, 1);
}

flows.push(
  {
    id: "people_arrival_distance_group_v1", type: "group", z: tab,
    name: "0. Ajuste do raio de chegada", style: { label: true, stroke: "#5ca5d8", fill: "#d9edf7", color: "#1d4f72" },
    nodes: ["people_arrival_distance_comment_v1", "people_arrival_distance_set_v1", "people_arrival_distance_apply_v1"],
    x: 1364, y: 239, w: 560, h: 162,
  },
  {
    id: "people_arrival_distance_comment_v1", type: "comment", z: tab, g: "people_arrival_distance_group_v1",
    name: "Edite o valor (metros) no nó abaixo e faça Deploy. Intervalo aceito: 50–2.000 m.", x: 1605, y: 280, w: 420, wires: [],
  },
  {
    id: "people_arrival_distance_set_v1", type: "inject", z: tab, g: "people_arrival_distance_group_v1",
    name: "Definir raio de chegada — 700 m", props: [{ p: "payload" }], repeat: "", crontab: "", once: true, onceDelay: "0.5", topic: "",
    payload: "700", payloadType: "num", x: 1540, y: 340, wires: [["people_arrival_distance_apply_v1"]],
  },
  {
    id: "people_arrival_distance_apply_v1", type: "function", z: tab, g: "people_arrival_distance_group_v1",
    name: "Aplicar raio de chegada", func: `const MIN_DISTANCE_M = 50;\nconst MAX_DISTANCE_M = 2000;\nconst requested = Number(msg.payload);\n\nif (!Number.isFinite(requested) || requested < MIN_DISTANCE_M || requested > MAX_DISTANCE_M) {\n    node.status({ fill: "red", shape: "ring", text: "use 50–2.000 m" });\n    node.warn("localizacao_pessoas: raio de chegada inválido");\n    return null;\n}\n\nconst distanceM = Math.round(requested);\nflow.set("security_arrival_distance_m", distanceM, "persistent");\nnode.status({ fill: "green", shape: "dot", text: "raio de chegada: " + distanceM + " m" });\nreturn null;`, outputs: 0,
    timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x: 1770, y: 340, wires: [],
  },
);

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Controle do raio de chegada instalado.");
