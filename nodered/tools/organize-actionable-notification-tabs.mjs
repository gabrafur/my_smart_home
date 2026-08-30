#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));

function organize(tabLabel, group) {
  const tab = flows.find((node) => node.type === "tab" && node.label === tabLabel);
  if (!tab) throw new Error(`Tab ausente: ${tabLabel}`);

  const members = flows.filter((node) => node.z === tab.id && node.type !== "group");
  if (members.length === 0) throw new Error(`Tab vazio: ${tabLabel}`);

  for (const node of members) node.g = group.id;
  const existing = flows.findIndex((node) => node.id === group.id);
  const value = {
    ...group,
    type: "group",
    z: tab.id,
    style: {
      label: true,
      "label-position": "nw",
      stroke: group.stroke,
      "stroke-opacity": "1",
      fill: "none",
      color: "#a4a4a4",
    },
    nodes: members.map((node) => node.id),
  };
  delete value.stroke;
  if (existing >= 0) flows[existing] = value;
  else flows.push(value);
}

const externalTopOutput = flows.find((node) =>
  node.id === "205cde805aa5e22c" && node.y === 20,
);
if (externalTopOutput) externalTopOutput.y = 40;

organize("alarme_desarme_chegada", {
  id: "alarm_arrival_full_flow_group",
  name: "Confirmação de chegada, resposta e testes",
  x: 64,
  y: 19,
  w: 2022,
  h: 722,
  stroke: "#7d6ba8",
});

organize("iluminacao_externa", {
  id: "external_lighting_full_flow_group",
  name: "Comandos, confirmação e recovery da iluminação externa",
  x: 64,
  y: 19,
  w: 2142,
  h: 542,
  stroke: "#3f7cb5",
});

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Tabs de notificações acionáveis organizados em grupos.");
