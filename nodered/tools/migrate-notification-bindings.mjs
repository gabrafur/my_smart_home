#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

function required(id) {
  const node = byId.get(id);
  if (!node) throw new Error(`Node ausente: ${id}`);
  return node;
}

function publicBinding(id, { role, action, data, name }) {
  const node = required(id);
  Object.assign(node, {
    ...(name ? { name } : {}),
    action: "public_bindings.call",
    entityId: [],
    data: `{"role":"${role}","action":"${action}","data":${data}}`,
    domain: "public_bindings",
    service: "call",
  });
  return node;
}

function upsertClone(sourceId, id, changes) {
  const source = required(sourceId);
  let node = byId.get(id);
  if (!node) {
    node = structuredClone(source);
    node.id = id;
    const index = flows.findIndex((item) => item.id === sourceId);
    flows.splice(index + 1, 0, node);
    byId.set(id, node);
  }
  Object.assign(node, changes);
  return node;
}

function appendUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function addWire(sourceId, output, targetId) {
  const source = required(sourceId);
  source.wires ??= [];
  source.wires[output] ??= [];
  appendUnique(source.wires[output], targetId);
}

// Normalize nodes already routed through the adapter but carrying stale
// private domain/service metadata from the original Home Assistant nodes.
for (const node of flows) {
  if (node.type === "api-call-service" && node.action === "public_bindings.call") {
    node.domain = "public_bindings";
    node.service = "call";
    node.entityId = [];
  }
}

publicBinding("infra_notify_mobile", {
  role: "mobile_primary",
  action: "notify_3",
  name: "Push resident_primary",
  data: "{\"title\":notification.title,\"message\":notification.message}",
});
Object.assign(required("infra_notify_mobile"), { x: 500, y: 70 });
upsertClone("infra_notify_mobile", "infra_notify_mobile_secondary", {
  name: "Push resident_secondary",
  data: "{\"role\":\"mobile_secondary\",\"action\":\"notify_2\",\"data\":{\"title\":notification.title,\"message\":notification.message}}",
  x: 500,
  y: 100,
});
addWire("infra_notify_route", 1, "infra_notify_mobile_secondary");
required("infra_notify_dismiss").y = 130;

publicBinding("storage_notify", {
  role: "mobile_primary",
  action: "notify_3",
  name: "Avisar resident_primary",
  data: "{\"title\":payload.title,\"message\":payload.message}",
});
Object.assign(required("storage_notify"), { x: 1460, y: 290 });
upsertClone("storage_notify", "storage_notify_secondary", {
  name: "Avisar resident_secondary",
  data: "{\"role\":\"mobile_secondary\",\"action\":\"notify_2\",\"data\":{\"title\":payload.title,\"message\":payload.message}}",
  x: 1460,
  y: 350,
});
for (const sourceId of ["storage_evaluate", "storage_maintenance_complete"]) {
  addWire(sourceId, sourceId === "storage_evaluate" ? 1 : 0, "storage_notify_secondary");
}
const storageGroup = required("storage_group_alerts");
appendUnique(storageGroup.nodes, "storage_notify_secondary");
Object.assign(storageGroup, { x: 1314, y: 249, w: 314, h: 142 });

publicBinding("564fdc36031eaef8", {
  role: "mobile_primary",
  action: "notify_3",
  data: "{\"message\":\"request_location_update\"}",
});
publicBinding("e0b7c0ecf1d8ee28", {
  role: "mobile_secondary",
  action: "notify_2",
  data: "{\"message\":\"request_location_update\"}",
});
publicBinding("32f1180d9ab2d2de", {
  role: "mobile_primary",
  action: "notify_3",
  data: "{\"title\":\"Casa inteligente\",\"message\":payload.message}",
});

publicBinding("70eb073f8191e69e", {
  role: "security_panel",
  action: "arm_away",
  data: "{}",
});
publicBinding("8261c7cfb6756ca8", {
  role: "security_panel",
  action: "disarm",
  data: "{}",
});

publicBinding("2818bf202b397612", {
  role: "mobile_primary",
  action: "notify_3",
  name: "Avisar resident_primary: refletor ligado",
  data: "{\"title\":payload.test_mode=true ? \"Casa inteligente — TESTE\" : \"Casa inteligente\",\"message\":payload.test_mode=true ? \"[TESTE] O refletor da garagem foi ligado.\" : \"O refletor da garagem foi ligado.\"}",
});
upsertClone("2818bf202b397612", "light_notify_on_secondary", {
  name: "Avisar resident_secondary: refletor ligado",
  data: "{\"role\":\"mobile_secondary\",\"action\":\"notify_2\",\"data\":{\"title\":payload.test_mode=true ? \"Casa inteligente — TESTE\" : \"Casa inteligente\",\"message\":payload.test_mode=true ? \"[TESTE] O refletor da garagem foi ligado.\" : \"O refletor da garagem foi ligado.\"}}",
  y: 240,
});

publicBinding("04007cc1732f60c9", {
  role: "mobile_primary",
  action: "notify_3",
  name: "Avisar resident_primary: refletor indisponível",
  data: "{\"title\":payload.test_mode=true ? \"Casa inteligente — TESTE — erro no refletor\" : \"Casa inteligente — erro no refletor\",\"message\":payload.message}",
});
upsertClone("04007cc1732f60c9", "light_notify_unavailable_secondary", {
  name: "Avisar resident_secondary: refletor indisponível",
  data: "{\"role\":\"mobile_secondary\",\"action\":\"notify_2\",\"data\":{\"title\":payload.test_mode=true ? \"Casa inteligente — TESTE — erro no refletor\" : \"Casa inteligente — erro no refletor\",\"message\":payload.message}}",
  y: 320,
});

for (const sourceId of ["354c9839bfca592f", "d2cc7a5873776be0"]) {
  addWire(sourceId, 0, "light_notify_on_secondary");
}
addWire("87b2f8eb75cb6359", 1, "light_notify_unavailable_secondary");
const lightGroup = required("95e7527bc7a0a9a1");
appendUnique(lightGroup.nodes, "light_notify_on_secondary");
appendUnique(lightGroup.nodes, "light_notify_unavailable_secondary");

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Node-RED notifications migrated to public_bindings.call.");
