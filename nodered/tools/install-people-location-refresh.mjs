import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.join(here, "functions");
const PEOPLE_TAB = "ea0a6aa0d24ff863";
const GROUP = "b35563e0f73e5b64";

const IDS = [
  "people_visual_vehicle_refresh_recheck",
  "people_visual_vehicle_refresh_recheck_out",
  "people_visual_vehicle_refresh_recheck_in",
  "people_visual_primary_icloud_out",
  "people_visual_primary_icloud_in",
  "people_visual_secondary_icloud_out",
  "people_visual_secondary_icloud_in",
  "people_visual_primary_icloud_gate",
  "people_visual_secondary_icloud_gate",
  "people_visual_primary_icloud_update",
  "people_visual_secondary_icloud_update",
  "people_visual_primary_icloud_accepted",
  "people_visual_secondary_icloud_accepted",
  "people_visual_icloud_dry_run_terminal",
];

const source = (name) =>
  fs.readFileSync(path.join(FUNCTIONS, name), "utf8").trimEnd();

export function installPeopleLocationRefresh(flows) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const required = (id) => {
    const node = byId.get(id);
    if (!node) throw new Error(`Nó obrigatório ausente: ${id}`);
    return node;
  };
  const upsert = (node) => {
    const current = byId.get(node.id);
    if (current) Object.assign(current, node);
    else {
      flows.push(node);
      byId.set(node.id, node);
    }
    return byId.get(node.id);
  };
  const grouped = (node) => {
    const saved = upsert({ ...node, z: PEOPLE_TAB, g: GROUP });
    const group = required(GROUP);
    if (!group.nodes.includes(saved.id)) group.nodes.push(saved.id);
    return saved;
  };
  const fn = (id, name, file, outputs, x, y, wires) => grouped({
    id,
    type: "function",
    name,
    func: source(file),
    outputs,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x,
    y,
    wires,
  });
  const linkOut = (id, name, target, x, y) => grouped({
    id,
    type: "link out",
    name,
    mode: "link",
    links: [target],
    x,
    y,
    wires: [],
  });
  const linkIn = (id, name, origin, destination, x, y) => grouped({
    id,
    type: "link in",
    name,
    links: [origin],
    x,
    y,
    wires: [[destination]],
  });
  const service = (id, name, role, x, y, accepted) => grouped({
    id,
    type: "api-call-service",
    name,
    server: required("564fdc36031eaef8__hub_call").server ??
      flows.find((node) => node.type === "server")?.id,
    version: 7,
    debugenabled: false,
    action: "public_bindings.call",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [],
    labelId: [],
    data: `{"role":"${role}","action":"refresh_location"}`,
    dataType: "json",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "first",
    blockInputOverrides: true,
    domain: "public_bindings",
    service: "call",
    x,
    y,
    wires: [[accepted]],
  });

  const group = required(GROUP);
  group.name = "3. Refresh seletivo: Companion + iCloud (máx. 2/h por morador)";
  group.h = Math.max(Number(group.h) || 0, 313);

  const decider = required("402fd0cc609443b7");
  decider.func = source("people-refresh-decide.js");
  decider.outputs = 2;
  decider.wires = [
    ["564fdc36031eaef8", "people_visual_primary_icloud_out"],
    ["e0b7c0ecf1d8ee28", "people_visual_secondary_icloud_out"],
  ];

  const arrival = required("people_visual_arrival_refresh_dispatch");
  arrival.wires = [
    ["564fdc36031eaef8", "people_visual_primary_icloud_out"],
    ["e0b7c0ecf1d8ee28", "people_visual_secondary_icloud_out"],
  ];

  const vehicleSync = required("555422f47d3a742b");
  vehicleSync.name = "Reavaliar trackers após refresh do vehicle_primary";
  vehicleSync.wires = [["people_visual_vehicle_refresh_recheck"]];
  fn(
    "people_visual_vehicle_refresh_recheck",
    "Converter sync em reavaliação com cooldown",
    "people-location-refresh-recheck.js",
    1,
    650,
    800,
    [["people_visual_vehicle_refresh_recheck_out"]],
  );
  linkOut(
    "people_visual_vehicle_refresh_recheck_out",
    "Reavaliar → decisão seletiva",
    "people_visual_vehicle_refresh_recheck_in",
    900,
    800,
  );
  linkIn(
    "people_visual_vehicle_refresh_recheck_in",
    "Receber reavaliação do vehicle_primary",
    "people_visual_vehicle_refresh_recheck_out",
    decider.id,
    100,
    850,
  );

  linkOut(
    "people_visual_primary_icloud_out",
    "resident_primary → iCloud",
    "people_visual_primary_icloud_in",
    480,
    850,
  );
  linkIn(
    "people_visual_primary_icloud_in",
    "Receber refresh iCloud de resident_primary",
    "people_visual_primary_icloud_out",
    "people_visual_primary_icloud_gate",
    1320,
    820,
  );
  linkOut(
    "people_visual_secondary_icloud_out",
    "resident_secondary → iCloud",
    "people_visual_secondary_icloud_in",
    700,
    1030,
  );
  linkIn(
    "people_visual_secondary_icloud_in",
    "Receber refresh iCloud de resident_secondary",
    "people_visual_secondary_icloud_out",
    "people_visual_secondary_icloud_gate",
    1320,
    1000,
  );

  fn(
    "people_visual_primary_icloud_gate",
    "Produção ou dry-run do iCloud primary?",
    "people-location-refresh-effect-gate.js",
    2,
    1580,
    820,
    [["people_visual_primary_icloud_update"], ["people_visual_icloud_dry_run_terminal"]],
  );
  fn(
    "people_visual_secondary_icloud_gate",
    "Produção ou dry-run do iCloud secondary?",
    "people-location-refresh-effect-gate.js",
    2,
    1580,
    1000,
    [["people_visual_secondary_icloud_update"], ["people_visual_icloud_dry_run_terminal"]],
  );
  service(
    "people_visual_primary_icloud_update",
    "EFEITO: atualizar localização iCloud primary",
    "resident_primary",
    1900,
    820,
    "people_visual_primary_icloud_accepted",
  );
  service(
    "people_visual_secondary_icloud_update",
    "EFEITO: atualizar localização iCloud secondary",
    "resident_secondary",
    1900,
    1000,
    "people_visual_secondary_icloud_accepted",
  );
  fn(
    "people_visual_primary_icloud_accepted",
    "Aguardar evidência nova de resident_primary",
    "people-location-refresh-accepted.js",
    0,
    2200,
    820,
    [],
  );
  fn(
    "people_visual_secondary_icloud_accepted",
    "Aguardar evidência nova de resident_secondary",
    "people-location-refresh-accepted.js",
    0,
    2200,
    1000,
    [],
  );
  fn(
    "people_visual_icloud_dry_run_terminal",
    "TESTE FINAL: iCloud não acionado",
    "people-location-refresh-dry-run.js",
    0,
    1900,
    920,
    [],
  );

  const catcher = required("people_refresh_connection_catch");
  catcher.scope = [...new Set([
    ...(catcher.scope ?? []),
    "people_visual_primary_icloud_update",
    "people_visual_secondary_icloud_update",
  ])];
  catcher.name = "Capturar falhas do refresh ativo dos iPhones";

  const tab = required(PEOPLE_TAB);
  if (!tab.info.includes("Companion + iCloud")) {
    tab.info += " O recovery de localização vencida usa Companion + iCloud, seletivamente por morador, com cooldown individual e confirmação por observação posterior.";
  }

  return { flows, ownedIds: IDS };
}
