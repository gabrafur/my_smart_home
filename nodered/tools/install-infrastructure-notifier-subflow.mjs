#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const ID = "infra_notify_all_mobiles";
const SERVER = "4126427d5e161a03";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const ownedIds = new Set([ID, ...flows.filter((node) => node.z === ID).map((node) => node.id)]);
const next = flows.filter((node) => !ownedIds.has(node.id) && node.z !== ID);
for (const node of next) {
  if (Array.isArray(node.wires)) node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !ownedIds.has(id)) : wire);
}
const call = (id, name, action, data, x, y) => ({
  id, type: "api-call-service", z: ID, name, server: SERVER, version: 7, debugenabled: false,
  action, floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [], data, dataType: "jsonata",
  mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true,
  domain: action.split(".")[0], service: action.split(".")[1], x, y, wires: [[]],
});
const nodes = [
  { id: ID, type: "subflow", name: "Notificar celulares, Echo e Home Assistant",
    info: "Contrato: msg.notification com id, title, message e dismiss_id opcional. O chamador decide estado, dedupe e produção/teste antes desta fronteira. Este subflow apenas valida e distribui os efeitos reais.",
    category: "infraestrutura", in: [{ x: 60, y: 140, wires: [{ id: "infra_notify_route" }] }], out: [], env: [], meta: {}, color: "#DDAA99" },
  { id: "infra_notify_route", type: "function", z: ID, name: "Validar contrato e distribuir",
    func: fs.readFileSync(path.join(here, "functions", "infrastructure-notification-router.js"), "utf8").trimEnd(),
    outputs: 3, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x: 240, y: 140,
    wires: [["infra_notify_persistent"], ["infra_notify_mobile", "infra_notify_mobile_secondary", "infra_notify_echo"], ["infra_notify_dismiss"]] },
  call("infra_notify_persistent", "Criar/atualizar alerta persistente", "persistent_notification.create",
    '{"title":notification.title,"message":notification.message,"notification_id":notification.id}', 560, 40),
  call("infra_notify_mobile", "Push resident_primary", "public_bindings.call",
    '{"role":"mobile_primary","action":"notify_3","data":{"title":notification.title,"message":notification.message}}', 560, 90),
  call("infra_notify_mobile_secondary", "Push resident_secondary", "public_bindings.call",
    '{"role":"mobile_secondary","action":"notify_2","data":{"title":notification.title,"message":notification.message}}', 560, 140),
  call("infra_notify_echo", "Anunciar na Echo Dot", "public_bindings.call",
    '{"role":"mobile_primary","action":"notify","data":{"message":notification.title & ". " & notification.message}}', 560, 190),
  call("infra_notify_dismiss", "Remover alerta anterior", "persistent_notification.dismiss",
    '{"notification_id":notification.dismiss_id}', 560, 240),
];
next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Infrastructure notifier subflow installed in ${outputPath}`);
